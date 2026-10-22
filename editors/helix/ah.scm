; ah's commands for helix: comment on lines of a file, or the whole file, to
; an agent in the Rex tab, in a box under the lines. helix.scm requires this
; (as ah/ah.scm, with this directory linked into helix's config directory)
; and re-exports the commands, since helix only offers what helix.scm
; provides.

(require (prefix-in helix. "helix/commands.scm"))
(require (prefix-in helix.static. "helix/static.scm"))
(require "helix/misc.scm")
(require (prefix-in helix.editor. "helix/editor.scm"))
(require "helix/ext.scm")
(require "comment-box.scm")
(require-builtin helix/core/text as text.)

(provide ah-comment
         ah-comment-file)

; Run ah with these arguments, off the main thread so a slow server start
; doesn't hold up the editor, then call done with what it printed to stdout
; and stderr, back in the editor. No shell, so arguments need no quoting.
(define (run-ah args done)
  (spawn-native-thread
   (lambda ()
     (let ([spawned (~> (command "ah" args) with-stdout-piped with-stderr-piped spawn-process)])
       (if (Err? spawned)
           (hx.with-context (lambda () (done "" "Couldn't run ah")))
           (let* ([child (Ok->value spawned)]
                  [err (trim (read-port-to-string (child-stderr child)))]
                  [out (trim (Ok->value (wait->stdout child)))])
             (hx.with-context (lambda () (done out err))))))))
  ; Not the thread, which helix would print as the command's result
  void)

; Whether s starts with prefix.
(define (prefixed? s prefix)
  (and (>= (string-length s) (string-length prefix))
       (equal? (substring s 0 (string-length prefix)) prefix)))

; Run `ah message send` with these arguments, and say in the status line
; whether an agent took the comment (`sent`) or it waits for one (`held`).
; Either means it went through, whatever ah says on stderr, like that it
; started the server.
(define (ah-send args)
  (run-ah (append (list "message" "send") args)
          (lambda (out err)
            (cond
              [(prefixed? out "sent") (set-status! "Sent to agent")]
              [(prefixed? out "held") (set-status! "Held until an agent is here")]
              [(not (equal? err "")) (set-error! err)]
              [else (set-error! (string-append "ah printed: " out))]))))

; The agents in this Rex tab, as `ah workspace agents` lists them, to done.
(define (ah-agents done)
  (run-ah (list "workspace" "agents")
          (lambda (out err)
            (done (map string->jsexpr (filter (lambda (l) (not (equal? l ""))) (split-many out "\n")))))))

; An agent as ah's terminal picker shows it: its part of the tab's title,
; then its harness. A JSON null parses to void, which is truthy, so a
; missing summary is told by its type.
(define (agent-line agent)
  (let ([summary (hash-ref agent 'summary)])
    (string-append (hash-ref agent 'label)
                   (if (string? summary) (string-append " | " summary) "")
                   " ("
                   (hash-ref agent 'harness)
                   (if (hash-ref agent 'busy) ", working" "")
                   ")")))

; The same line as spans for the comment box's list, the harness dim.
(define (agent-spans agent)
  (let ([summary (hash-ref agent 'summary)])
    (list (cons (string-append (hash-ref agent 'label) (if (string? summary) (string-append " | " summary) ""))
                "ui.text")
          (cons (string-append " (" (hash-ref agent 'harness) (if (hash-ref agent 'busy) ", working" "") ")")
                "comment"))))

; The current file's name without its directory, or "" for a scratch buffer.
(define (current-file-name)
  (let ([path (or (helix.static.cx->current-file) "")])
    (let loop ([i (- (string-length path) 1)])
      (cond
        [(< i 0) path]
        [(equal? (string-ref path i) #\/) (substring path (+ i 1) (string-length path))]
        [else (loop (- i 1))]))))

; Open the comment box on lines first to last (0-based) of the current file,
; for a comment on lines (`12` or `12-20`, or #f for the whole file) with
; the selected text, if any. Sending saves the file, so the agent reads the
; lines the comment is on, skipping formatting, which could move the lines.
;
; In a Rex pane, the comment goes to an agent in the tab as a message. With
; one agent there, the title says it's that one. With several, they're
; listed under the text, starting on the one ah sends to from this pane (its
; pick), and tab moves. The selected one goes as --agent, which makes it the
; pane's pick for later comments.
;
; In a markdown page's helix pane, outside Rex, ah puts it in the file's
; thread instead, as one made on the rendered side, so the page shows it.
(define (ah-comment-box title lines selection first last)
  (let ([file (helix.static.cx->current-file)]
        [agents '()]
        [box #f])
    (define (send text)
      (let ([selected (comment-box-selected box)])
        (helix.update "--no-format")
        (ah-send (append (list "--file" file)
                         (if lines (list "--lines" lines) '())
                         (if selection (list "--selection" selection) '())
                         (if selected (list "--agent" (hash-ref (list-ref agents selected) 'id)) '())
                         (list "--text" text)))))
    (if (not file)
        (set-error! "This buffer has no file")
        (begin
          (set! box (open-comment-box title first last send))
          (ah-agents (lambda (listed)
                       (set! agents listed)
                       (cond
                         [(= (length listed) 1)
                          (set-comment-box-title! box (string-append title " → " (agent-line (car listed))))]
                         [(> (length listed) 1)
                          (set-comment-box-choices! box
                                                    "send to"
                                                    (map agent-spans listed)
                                                    (or (target-index listed) 0))
                          (set-comment-box-hint! box " ⏎ send · tab agent · esc cancel ")])))))))

; Index of the agent ah sends to without --agent, or #f.
(define (target-index agents)
  (let loop ([agents agents] [i 0])
    (cond
      [(null? agents) #f]
      [(hash-ref (car agents) 'target) i]
      [else (loop (cdr agents) (+ i 1))])))

;;@doc
;; Comment to the agent on the selected lines
(define (ah-comment)
  ; The selected text goes along unless it's just the cursor, cut to 4000
  ; characters so a whole-file selection stays under the argument size
  ; limit.
  (let* ([range (helix.static.selection->primary-range (helix.static.current-selection-object))]
         [doc (helix.editor.editor->text (helix.editor.editor->doc-id (helix.editor.editor-focus)))]
         [from (helix.static.range->from range)]
         [to (helix.static.range->to range)]
         [first (+ 1 (text.rope-char->line doc from))]
         [last (+ 1 (text.rope-char->line doc (max from (- to 1))))]
         [lines (if (= first last)
                    (number->string first)
                    (string-append (number->string first) "-" (number->string last)))]
         [selection (if (> (- to from) 1)
                        (let ([text (helix.static.current-highlighted-text!)])
                          (if (> (string-length text) 4000) (substring text 0 4000) text))
                        #f)])
    (ah-comment-box (string-append (current-file-name) ":" lines) lines selection (- first 1) (- last 1))))

;;@doc
;; Comment to the agent on the whole file
(define (ah-comment-file)
  (let* ([doc (helix.editor.editor->text (helix.editor.editor->doc-id (helix.editor.editor-focus)))]
         [line (text.rope-char->line doc (cursor-position))])
    (ah-comment-box (current-file-name) #f #f line line)))
