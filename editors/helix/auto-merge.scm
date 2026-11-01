; Keep every helix buffer up to date with its file on disk: reload the
; agent's edits, or merge them into unsaved text, by the rules in
; views/markdown/editor.ts. ah.scm requires this, so it runs in every helix
; that loads ah's Steel config, not just ah's editor pane. Runs on
; mattwparas's steel-event-system.
;
; Each open document whose file is newer than helix's last save of it (the
; test helix's save uses to refuse with "modified by an external process")
; is:
;
; - reloaded, if the buffer is unmodified
; - merged, if it's modified: `ah view merge` merges the file on disk into
;   the buffer, against the file as helix last read or saved it (the base),
;   marking the text both changed with both versions. The result is written
;   to the file and the buffer reloaded from it, so the buffer ends
;   unmodified with the merged text, and helix's last-saved time is the
;   merged write's mtime, so its next save goes through.
;
; The merge goes by lines, marking lines both changed with git's conflict
; markers, except for markdown, which goes word by word (*merge-units*).
; A file that isn't UTF-8 text isn't merged: the status line says to
; :reload or :w! instead.
;
; When to check: a helix with a file watcher (helix-editor/helix#14544) and
; the document-changed-on-disk hook says when a file changed, after
; reloading an unmodified buffer itself; the script turns off its prompt for
; a modified one and merges instead. The watcher also watches open files
; outside a workspace and ignored ones, like .claude/notes
; (file-watcher.watch-open-files). Without the hook, the script checks every
; CHECK-EVERY ms itself. Either way also when the terminal gains focus or
; insert mode ends.
;
; A file written to in the last SETTLE ms is left for the next check, since
; a non-atomic writer (jj checkout) can leave it briefly empty.
;
; A document someone is typing in waits until they leave insert mode: a
; merge moves text under the cursor, and in most Helix a reload in insert
; mode puts the pending insert in the reload's undo step. Where clients
; share the editor, that's anyone typing in it: auto-merge-clients.scm
; checks every client, loaded only where the client-detached hook exists,
; since other Helix can't compile its calls to the client API.
;
; Helix's auto-save can still fire in the moment between the agent's write
; and the next check, fail, and leave "modified by an external process" in
; the status line. The check that follows merges as usual.

(require-builtin steel/time)
(require-builtin helix/core/text as text.)
(require "helix/misc.scm")
(require "helix/editor.scm")
(require "helix/configuration.scm")
(require (prefix-in helix.static. "helix/static.scm"))

(provide set-merge-unit!
         set-typing-check!)

(define CHECK-EVERY 300)
(define SETTLE 150)

; How `ah view merge` merges a file, by its extension: by 'lines, or by
; 'words for prose, where a paragraph is often one long line. Others go by
; lines.
(define *merge-units* (hash "md" 'words "markdown" 'words))

;;@doc
;; Merge the agent's edits into unsaved text in files with this extension
;; (like "md") by 'lines or 'words
(define (set-merge-unit! extension unit)
  (let ([unit (if (string? unit) (string->symbol unit) unit)])
    (if (member unit '(lines words))
        (set! *merge-units* (hash-insert *merge-units* extension unit))
        (set-error! "set-merge-unit!: the unit is 'lines or 'words"))))

(define (merge-unit path)
  (let ([name (last (split-many path "/"))])
    (if (string-contains? name ".")
        (or (hash-try-get *merge-units* (last (split-many name "."))) 'lines)
        'lines)))

; Path -> (mtime . text): the file as helix last read or saved it, the merge
; base. Taken from disk whenever the file's mtime is helix's last-saved
; time. Not from the document-saved hook: that fires when a save is queued,
; before the save can still fail because the file changed.
(define *bases* (hash))
(define (remember! path time text)
  (set! *bases* (hash-insert *bases* path (cons time text))))

; The file's text, or #f if it isn't UTF-8 or can't be read
(define (read-file path)
  (with-handler (lambda (_) #f) (read-port-to-string (open-input-file path))))

(define (write-file! path text)
  (let ([port (open-output-file path #:exists 'truncate)])
    (write-string text port)
    (close-output-port port)))

(define (text-of doc)
  (text.rope->string (editor->text doc)))

(define (mtime path)
  (fs-metadata-modified (file-metadata path)))

; How long ago the file was written, in ms. An mtime in the future (clock
; skew) counts as settled, or it would never be read.
(define (age-ms time)
  (let ([now (system-time/now)])
    (if (system-time<? now time)
        SETTLE
        (duration->millis (system-time-duration-since now time)))))

(define (insert-mode?)
  (equal? (editor-mode) (string->editor-mode "insert")))

; Whether someone is typing in the document. With one client, the editor's
; mode says, whatever the document.
(define *typing-in?* (lambda (doc) (insert-mode?)))
(define (set-typing-check! typing-in?)
  (set! *typing-in?* typing-in?))

; disk merged into unsaved, both edits of base, by `ah view merge` by unit,
; and how many conflicts it marked in it: (text . conflicts), or #f if that
; failed. Runs on the editor's thread, which waits for it, so the buffer
; can't change in the meantime. ah reads all of stdin before it writes, so
; sending everything and closing stdin before reading can't deadlock.
(define (ah-merge unit base unsaved disk)
  (let ([spawned (~> (command "ah"
                              (if (equal? unit 'words)
                                  (list "view" "merge" "--words")
                                  (list "view" "merge")))
                     with-stdin-piped
                     with-stdout-piped
                     spawn-process)])
    (and (Ok? spawned)
         (let ([child (Ok->value spawned)])
           ; A write fails only once ah has exited, so the wait doesn't block
           (with-handler
            (lambda (_)
              (wait child)
              #f)
            (let ([in (child-stdin child)])
              (write-string (value->jsexpr-string (hash "base" base "unsaved" unsaved "disk" disk))
                            in)
              (close-output-port in)
              (let* ([out (read-port-to-string (child-stdout child))]
                     [code (Ok->value (wait child))])
                (and (equal? code 0)
                     ; JSON numbers parse as floats, which print as 1.0
                     (let ([result (string->jsexpr out)])
                       (cons (hash-ref result 'text) (exact (hash-ref result 'conflicts))))))))))))

; The file is what helix last read or wrote, if its mtime is helix's
; last-saved time: keep it as the base, once per mtime, if it doesn't change
; while being read. A file that isn't UTF-8 text is kept as #f, so it's read
; once.
(define (track-base! doc path)
  (let ([saved (editor-document-last-saved doc)]
        [known (hash-try-get *bases* path)])
    (when (and saved
               (equal? saved (mtime path))
               (not (and known (equal? (car known) saved))))
      (let ([text (read-file path)])
        (when (equal? saved (mtime path))
          (remember! path saved text))))))

(define (merge! doc path seen)
  (let ([base (hash-try-get *bases* path)])
    (if (not base)
        ; Opened and changed before the first check, or config reloaded
        ; after it changed: what helix last saved is unknown, so don't guess
        (set-error! "File changed on disk and the merge base is unknown: :reload or :w!")
        (let* ([disk (read-file path)]
               [result (and (cdr base)
                            disk
                            (ah-merge (merge-unit path) (cdr base) (text-of doc) disk))])
          (cond
            [(not (and (cdr base) disk))
             (set-error! "File changed on disk and isn't UTF-8 text to merge: :reload or :w!")]
            [(not result) (set-error! "Couldn't merge the file on disk: is ah on the PATH?")]
            ; Written again since we read it: the next check merges that
            [(not (equal? seen (mtime path))) void]
            [else
             (let ([merged (car result)]
                   [conflicts (cdr result)])
               (unless (equal? merged disk)
                 (write-file! path merged))
               (editor-document-reload doc)
               (track-base! doc path)
               (if (> conflicts 0)
                   (set-error! (string-append "Merged external changes, with "
                                              (number->string conflicts)
                                              (if (= conflicts 1) " conflict" " conflicts")
                                              " marked"))
                   (set-status! "Merged external changes")))])))))

(define (check-doc doc)
  (let ([path (editor-document->path doc)]
        [saved (editor-document-last-saved doc)])
    (when (and path saved (is-file? path))
      (let ([disk (mtime path)])
        (cond
          [(not (system-time<? saved disk)) (track-base! doc path)]
          [(or (< (age-ms disk) SETTLE) (*typing-in?* doc)) void]
          [(editor-document-dirty? doc) (merge! doc path disk)]
          [else
           (editor-document-reload doc)
           (track-base! doc path)
           (set-status! "Reloaded external changes")])))))

(define (check-all)
  (for-each check-doc (editor-all-documents)))

(define (poll)
  ; Schedule the next one first, so an error in this one doesn't stop them.
  ; :config-reload starts a new loop, and helix drops the old one's callbacks.
  (enqueue-thread-local-callback-with-delay CHECK-EVERY poll)
  (check-all))

; After a save, the file is the base once helix has written it, which is
; after document-saved fires (see *bases*): look every 50ms, for 2s at
; most, for a new last-saved time that is the file's mtime. A save that
; fails never gets one.
(define (track-save doc before tries)
  (enqueue-thread-local-callback-with-delay
   50
   (lambda ()
     (when (editor-doc-exists? doc)
       (let ([path (editor-document->path doc)]
             [saved (editor-document-last-saved doc)])
         (cond
           [(not (and path saved (is-file? path))) void]
           [(not (equal? saved before)) (track-base! doc path)]
           [(> tries 0) (track-save doc before (- tries 1))]))))))

; Checks when helix says a file changed, and tracks the base after saves,
; which polling did. #f where helix has no such hook.
(define (on-change!)
  (with-handler
   (lambda (_) #f)
   (begin
     (register-hook "document-changed-on-disk" check-doc)
     (register-hook "document-saved"
                    (lambda (doc) (track-save doc (editor-document-last-saved doc) 40)))
     ; Instead of prompting about a modified buffer
     (set-option! 'auto-reload.notify-if-modified #f)
     #t)))

; Helix just read it, so the buffer is the file
(register-hook "document-opened"
               (lambda (doc)
                 (let ([path (editor-document->path doc)]
                       [saved (editor-document-last-saved doc)])
                   (when (and path saved) (remember! path saved (text-of doc))))))
(register-hook "terminal-focus-gained" check-all)
; Runs as insert mode ends, before a save deferred during it
(register-hook "on-mode-switch"
               (lambda (event)
                 (when (equal? (mode-switch-old event) (string->editor-mode "insert"))
                   (check-all))))
; Where clients share the editor, a client that leaves in insert mode stops
; holding up its document, and auto-merge-clients.scm makes the typing check
; ask every client. That file requires this one, so it's loaded once this
; one has finished loading.
(when (with-handler (lambda (_) #f)
                    (register-hook "client-detached" (lambda (_) (check-all)))
                    #t)
  (enqueue-thread-local-callback-with-delay
   0
   (lambda ()
     (let ([config (helix.static.get-helix-scm-path)])
       ; ah's directory is linked into helix.scm's as ah/
       (load (string-append (substring config 0 (- (string-length config) (string-length "helix.scm")))
                            "ah/auto-merge-clients.scm"))))))
; Polling checks right away. The first check also takes bases for the
; documents already open after :config-reload, which empties *bases*.
(if (on-change!) (check-all) (poll))
