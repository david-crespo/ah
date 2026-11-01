; Where clients share one editor (a Helix with sessions), a document waits
; for a merge while any client is typing in it, not only the client a check
; happens to run as. auto-merge.scm loads this only there: other Helix has
; no client API, so it can't compile this file.

(require "helix/editor.scm")
(require "auto-merge.scm")

(define insert (string->editor-mode "insert"))

(set-typing-check!
 (lambda (doc)
   (not (null? (filter (lambda (client)
                         (with-client client
                                      (lambda ()
                                        (and (equal? (editor-mode) insert)
                                             (equal? (editor->doc-id (editor-focus)) doc)))))
                       (editor-clients))))))
