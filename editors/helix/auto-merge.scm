; Keep helix in ah's editor pane up to date with the file on disk, by the
; rules in views/markdown/editor.ts: reload the agent's edits, or merge them
; into unsaved text. ah.scm requires this, and it starts only in the pane,
; where ah sets AH_MERGE_URL. Uses only APIs on mattwparas's
; steel-event-system.
;
; Every CHECK-EVERY ms, and when the terminal gains focus or insert mode
; ends, each open document whose file is newer than helix's last save of it
; (the test helix's save uses to refuse with "modified by an external
; process") is:
;
; - reloaded, if the buffer is unmodified
; - merged, if it's modified: ah's server merges the file on disk into the
;   buffer, against the file as helix last read or saved it (the base),
;   marking the text both changed with both versions. The result is written to the file and the buffer reloaded from it, so the
;   buffer ends unmodified with the merged text, and helix's last-saved time
;   is the merged write's mtime, so its next save goes through.
;
; A file written to in the last SETTLE ms is left for the next check, since
; a non-atomic writer (jj checkout) can leave it briefly empty.
;
; Insert mode waits for normal mode: a reload in insert mode commits the
; pending insert and the reload as one undo step.
;
; Helix's auto-save can still fire in the moment between the agent's write
; and the next check, fail, and leave "modified by an external process" in
; the status line. The check that follows merges as usual.

(require-builtin steel/time)
(require-builtin helix/core/text as text.)
(require "helix/misc.scm")
(require "helix/editor.scm")

(define CHECK-EVERY 300)
(define SETTLE 150)

(define *merge-url*
  (let ([v (maybe-get-env-var "AH_MERGE_URL")])
    (if (Ok? v) (Ok->value v) #f)))

; Path -> (mtime . text): the file as helix last read or saved it, the merge
; base. Taken from disk whenever the file's mtime is helix's last-saved
; time. Not from the document-saved hook: that fires when a save is queued,
; before the save can still fail because the file changed.
(define *bases* (hash))
(define (remember! path time text)
  (set! *bases* (hash-insert *bases* path (cons time text))))

(define (read-file path)
  (read-port-to-string (open-input-file path)))

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

; Where the texts go for curl to send
(define *scratch*
  (let ([v (maybe-get-env-var "TMPDIR")])
    (string-append (if (Ok? v) (Ok->value v) "/tmp") "/ah-hx-merge-"
                   (number->string (current-milliseconds)))))

; disk merged into unsaved, both edits of base, by the ah server, and how
; many conflicts it marked in it: (text . conflicts), or #f if that failed.
; Runs on the editor's thread, which waits for it, so the buffer can't change
; in the meantime.
(define (ah-merge base unsaved disk)
  (create-directory! *scratch*)
  (let* ([path (lambda (name) (string-append *scratch* "/" name))]
         [field (lambda (name text)
                  (write-file! (path name) text)
                  (list "--form" (string-append name "=@" (path name))))]
         ; The text to a file, and the conflicts to stdout
         [spawned (~> (command "curl"
                               (append (list "--silent" "--fail" "--max-time" "5")
                                       (field "base" base)
                                       (field "unsaved" unsaved)
                                       (field "disk" disk)
                                       (list "--output" (path "merged")
                                             "--write-out" "%header{ah-conflicts}"
                                             *merge-url*)))
                      with-stdout-piped
                      spawn-process)])
    (if (Err? spawned)
        #f
        (let* ([child (Ok->value spawned)]
               [out (read-port-to-string (child-stdout child))]
               [code (Ok->value (wait child))])
          (if (equal? code 0)
              (cons (read-file (path "merged")) (or (string->number out) 0))
              #f)))))

; The file is what helix last read or wrote: keep it as the base, once per
; mtime, if it doesn't change while being read
(define (track-base! path disk)
  (let ([known (hash-try-get *bases* path)])
    (unless (and known (equal? (car known) disk))
      (let ([text (read-file path)])
        (when (equal? disk (mtime path))
          (remember! path disk text))))))

(define (merge! doc path seen)
  (let ([base (hash-try-get *bases* path)])
    (if (not base)
        ; Opened and changed before the first check, or config reloaded
        ; after it changed: what helix last saved is unknown, so don't guess
        (set-error! "File changed on disk and the merge base is unknown: :reload or :w!")
        (let* ([disk (read-file path)]
               [result (ah-merge (cdr base) (text-of doc) disk)])
          (cond
            [(not result) (set-error! "Couldn't merge the file on disk: is ah running?")]
            ; Written again since we read it: the next check merges that
            [(not (equal? seen (mtime path))) void]
            [else
             (let ([merged (car result)]
                   [conflicts (cdr result)])
               (unless (equal? merged disk)
                 (write-file! path merged))
               (editor-document-reload doc)
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
          [(not (system-time<? saved disk))
           (when (equal? saved disk) (track-base! path disk))]
          [(or (< (age-ms disk) SETTLE) (insert-mode?)) void]
          [(editor-document-dirty? doc) (merge! doc path disk)]
          [else
           (editor-document-reload doc)
           (set-status! "Reloaded external changes")])))))

(define (check-all)
  (for-each check-doc (editor-all-documents)))

(define (poll)
  ; Schedule the next one first, so an error in this one doesn't stop them.
  ; :config-reload starts a new loop, and helix drops the old one's callbacks.
  (enqueue-thread-local-callback-with-delay CHECK-EVERY poll)
  (check-all))

(when *merge-url*
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
  (poll))
