; A bordered box under some lines of the current file, like a review comment,
; for writing a comment in. Enter sends, alt-enter or shift-enter adds a line,
; escape drops it. Helix has no text input to embed, so the editing is here:
; the text is one string and a cursor index into it, and each frame wraps it
; to the box's width. The box can also show a list under the text, such as
; where the comment goes, with one item selected; tab and shift-tab move.

(require "helix/misc.scm")
(require (prefix-in helix.editor. "helix/editor.scm"))
(require (prefix-in ui. "helix/components.scm"))
(require-builtin helix/core/text as text.)

(provide open-comment-box
         set-comment-box-title!
         set-comment-box-hint!
         set-comment-box-choices!
         comment-box-selected)

; title: what's commented on, shown in the top border. on-send: called with
; the text when it isn't blank. hint: the keys, shown in the bottom border.
; choices: the list under the text, or #f. top and bottom: screen rows of the
; first and last commented lines. col: screen column of the box's left edge.
; scroll: first visual line shown. width: text width at the last frame, for
; up and down.
(struct CommentBox (title on-send hint choices text cursor top bottom col scroll width) #:mutable)

; The list under the text. title: shown in the divider over it. items: each
; a list of spans, (text . theme scope). selected: the highlighted item's
; index.
(struct Choices (title items selected) #:mutable)

(define max-width 72)
(define max-lines 8)
(define default-hint " ⏎ send · esc cancel ")

(define (set-comment-box-title! box title)
  (set-CommentBox-title! box title))

(define (set-comment-box-hint! box hint)
  (set-CommentBox-hint! box hint))

;;@doc
;; Show items under the text, like helix's picker, with the one at index
;; selected highlighted. Each item is a list of spans, (text . theme scope).
;; Tab and shift-tab move the selection.
(define (set-comment-box-choices! box title items selected)
  (set-CommentBox-choices! box (Choices title items selected)))

;;@doc
;; The selected item's index, or #f with no list.
(define (comment-box-selected box)
  (let ([choices (CommentBox-choices box)])
    (and choices (Choices-selected choices))))

;; Text

; The text's visual lines at this width, as (start . end) character indexes.
; A newline ends a line and belongs to neither; a full line wraps after its
; last space, or mid-word if it has none, and a full last line gets an empty
; one after it, so the cursor always has a cell.
(define (wrap-lines text width)
  (let ([len (string-length text)])
    (let loop ([i 0] [start 0] [lines '()])
      (cond
        [(= i len)
         (reverse (if (= (- len start) width)
                      (cons (cons len len) (cons (cons start len) lines))
                      (cons (cons start len) lines)))]
        [(equal? (string-ref text i) #\newline) (loop (+ i 1) (+ i 1) (cons (cons start i) lines))]
        [(= (- i start) width)
         (let ([space (skip-back text i start (lambda (c) (not (char-whitespace? c))))])
           (if (> space (+ start 1))
               (loop i space (cons (cons start space) lines))
               (loop i i (cons (cons start i) lines))))]
        [else (loop (+ i 1) start lines)]))))

; Step back from i, not past stop, while the character before matches.
(define (skip-back text i stop pred)
  (if (and (> i stop) (pred (string-ref text (- i 1))))
      (skip-back text (- i 1) stop pred)
      i))

; Start of the word before i, skipping whitespace first.
(define (word-start text i)
  (skip-back text
             (skip-back text i 0 char-whitespace?)
             0
             (lambda (c) (not (char-whitespace? c)))))

; Index of the visual line the cursor is on: the last one starting at or
; before it.
(define (cursor-line lines cursor)
  (- (length (filter (lambda (span) (<= (car span) cursor)) lines)) 1))

;; Editing

; Replace the text between the cursor and i with s, leaving the cursor after
; it. Every edit goes through here.
(define (box-splice! box i s)
  (let* ([text (CommentBox-text box)]
         [cursor (CommentBox-cursor box)]
         [start (max 0 (min i cursor))]
         [end (min (string-length text) (max i cursor))])
    (set-CommentBox-text! box (string-append (substring text 0 start) s (substring text end (string-length text))))
    (set-CommentBox-cursor! box (+ start (string-length s)))))

; Terminals paste line breaks as \r, so those become \n.
(define (box-insert! box s)
  (box-splice! box
               (CommentBox-cursor box)
               (string-replace (string-replace (string-replace s "\r\n" "\n") "\r" "\n") "\t" "  ")))

(define (box-delete-to! box i)
  (box-splice! box i ""))

(define (box-move! box i)
  (set-CommentBox-cursor! box (max 0 (min i (string-length (CommentBox-text box))))))

; Move the cursor a visual line up or down, keeping its column.
(define (box-move-line! box delta)
  (let* ([lines (wrap-lines (CommentBox-text box) (CommentBox-width box))]
         [line (cursor-line lines (CommentBox-cursor box))]
         [target (+ line delta)])
    (when (and (>= target 0) (< target (length lines)))
      (let ([col (- (CommentBox-cursor box) (car (list-ref lines line)))]
            [to (list-ref lines target)])
        (box-move! box (min (+ (car to) col) (cdr to)))))))

;; Drawing

; The box's rect, the visual lines shown in it, and the cursor's position.
(struct Layout (rect lines cursor))

; Under the commented lines, or over them when there's no room under, with
; any list under the text. Scrolls the text to keep the cursor in view.
(define (layout box screen)
  (let* ([text (CommentBox-text box)]
         [choices (CommentBox-choices box)]
         [width (min max-width (- (ui.area-width screen) 2))]
         [x (max 0 (min (CommentBox-col box) (- (ui.area-width screen) width)))]
         [text-width (- width 4)]
         [lines (wrap-lines text text-width)]
         [line (cursor-line lines (CommentBox-cursor box))]
         [shown (min (length lines) max-lines)]
         [scroll (max (- line (- shown 1)) (min line (CommentBox-scroll box)))]
         [height (+ shown 2 (if choices (+ 1 (length (Choices-items choices))) 0))]
         ; The bottom two rows are the statusline and the command line.
         [room (- (ui.area-height screen) 2)]
         [below (+ (CommentBox-bottom box) 1)]
         [above (- (CommentBox-top box) height)]
         [y (cond
              [(<= (+ below height) room) below]
              [(>= above 0) above]
              [else (max 0 (- room height))])])
    (set-CommentBox-scroll! box scroll)
    (set-CommentBox-width! box text-width)
    (Layout (ui.area x y width height)
            (map (lambda (span) (substring text (car span) (cdr span))) (take (list-tail lines scroll) shown))
            (ui.position (+ y 1 (- line scroll))
                         (+ x 2 (- (CommentBox-cursor box) (car (list-ref lines line))))))))

(define (render box screen buf)
  (let* ([l (layout box screen)]
         [rect (Layout-rect l)]
         [width (ui.area-width rect)]
         [height (ui.area-height rect)]
         [scope ui.theme-scope-ref]
         ; Write s at this column and row of the box.
         [put (lambda (col row s style)
                (ui.frame-set-string! buf (+ (ui.area-x rect) col) (+ (ui.area-y rect) row) s style))]
         [title (let ([t (string-append " " (CommentBox-title box) " ")])
                  (if (> (string-length t) (- width 4))
                      (string-append (substring t 0 (- width 6)) "… ")
                      t))]
         [hint (CommentBox-hint box)])
    (ui.buffer/clear buf rect)
    (ui.block/render buf rect (ui.make-block (scope "ui.popup") (scope "ui.text") "all" "rounded"))
    (put 2 0 title (scope "string"))
    (when (>= (- width 4) (string-length hint))
      (put (- width (string-length hint) 2) (- height 1) hint (scope "string")))
    (if (equal? (CommentBox-text box) "")
        (put 2 1 "Comment to the agent" (ui.style-with-italics (scope "comment")))
        (let loop ([lines (Layout-lines l)] [row 1])
          (when (not (null? lines))
            (put 2 row (car lines) (scope "ui.text"))
            (loop (cdr lines) (+ row 1)))))
    (when (CommentBox-choices box)
      (render-choices (CommentBox-choices box) put width (+ 1 (length (Layout-lines l)))))))

; A divider with the list's title at row, then its items, the selected one
; marked and highlighted across the box as in helix's picker.
(define (render-choices choices put width row)
  (let ([scope ui.theme-scope-ref])
    (put 0 row (string-append "├" (make-string (- width 2) #\─) "┤") (scope "ui.text"))
    (put 2 row (string-append " " (Choices-title choices) " ") (scope "string"))
    (let loop ([items (Choices-items choices)] [i 0])
      (when (not (null? items))
        (let ([selected (= i (Choices-selected choices))]
              [r (+ row 1 i)])
          (when selected
            (put 1 r (make-string (- width 2) #\space) (scope "ui.text.focus"))
            (put 2 r ">" (scope "ui.text.focus")))
          (put-spans put 4 r (- width 6) (car items))
          (loop (cdr items) (+ i 1)))))))

; Write spans from col on row, cut with … to fit in room columns. Their
; styles add to what's there, so a highlight's background stays.
(define (put-spans put col row room spans)
  (when (not (null? spans))
    (let* ([text (car (car spans))]
           [style (ui.theme-scope-ref (cdr (car spans)))]
           [len (string-length text)])
      (if (> len room)
          (put col row (string-append (substring text 0 (max 0 (- room 1))) "…") style)
          (begin
            (put col row text style)
            (put-spans put (+ col len) row (- room len) (cdr spans)))))))

(define (cursor box screen)
  (list (Layout-cursor (layout box screen)) "bar"))

;; Keys

; Move the list's selection by delta, wrapping.
(define (choices-move! choices delta)
  (set-Choices-selected! choices (modulo (+ (Choices-selected choices) delta) (length (Choices-items choices)))))

; Enter sends and escape drops it. Tab and shift-tab move the list's
; selection. Every other key edits, and stray ones are swallowed so they
; don't edit the buffer underneath.
(define (handle-key box event)
  (let* ([mods (or (ui.key-event-modifier event) 0)]
         [plain (or (= mods 0) (= mods ui.key-modifier-shift))]
         [char (ui.key-event-char event)]
         [ctrl? (lambda (c) (and (= mods ui.key-modifier-ctrl) (equal? char c)))]
         [text (CommentBox-text box)]
         [cursor (CommentBox-cursor box)])
    (cond
      [(or (ui.key-event-escape? event) (ctrl? #\c))
       (set-status! "Comment dropped")
       ui.event-result/close]
      [(and (ui.key-event-enter? event) (= mods 0))
       (if (equal? (trim text) "")
           (set-status! "No comment, nothing sent")
           ((CommentBox-on-send box) text))
       ui.event-result/close]
      [else
       (cond
         [(or (ui.key-event-enter? event) (ctrl? #\j)) (box-insert! box "\n")]
         [(and (ui.key-event-tab? event) (CommentBox-choices box))
          (choices-move! (CommentBox-choices box) (if (= mods ui.key-modifier-shift) -1 1))]
         [(ui.key-event-backspace? event) (box-delete-to! box (if plain (- cursor 1) (word-start text cursor)))]
         [(ctrl? #\w) (box-delete-to! box (word-start text cursor))]
         [(ctrl? #\u) (box-delete-to! box 0)]
         [(ui.key-event-delete? event) (box-delete-to! box (+ cursor 1))]
         [(ui.key-event-left? event) (box-move! box (- cursor 1))]
         [(ui.key-event-right? event) (box-move! box (+ cursor 1))]
         [(ui.key-event-up? event) (box-move-line! box -1)]
         [(ui.key-event-down? event) (box-move-line! box 1)]
         [(or (ui.key-event-home? event) (ctrl? #\a)) (box-move! box 0)]
         [(or (ui.key-event-end? event) (ctrl? #\e)) (box-move! box (string-length text))]
         [(and plain char) (box-insert! box (string char))])
       ui.event-result/consume])))

(define (handle-event box event)
  (cond
    [(ui.paste-event? event) (box-insert! box (ui.paste-event-string event)) ui.event-result/consume]
    [(ui.key-event? event) (handle-key box event)]
    [else ui.event-result/ignore]))

;;@doc
;; Open the comment box on lines first to last (0-based) of the current
;; file, lined up with the first line's indentation, and return it. on-send
;; gets the text.
(define (open-comment-box title first last on-send)
  (let* ([doc (helix.editor.editor->text (helix.editor.editor->doc-id (helix.editor.editor-focus)))]
         [screen-pos (car (helix.editor.current-cursor))]
         [pos (cursor-position)]
         [line (text.rope-char->line doc pos)]
         [row (if screen-pos (ui.position-row screen-pos) 0)]
         [line-col (if screen-pos
                       (- (ui.position-col screen-pos) (- pos (text.rope-line->char doc line)))
                       0)]
         [first-start (text.rope-line->char doc first)]
         [indent (let loop ([i first-start])
                   (if (and (< i (text.rope-len-chars doc))
                            (member (text.rope-char-ref doc i) (list #\space #\tab)))
                       (loop (+ i 1))
                       (- i first-start)))])
    (let ([box (CommentBox title
                           on-send
                           default-hint
                           #f
                           ""
                           0
                           (- row (- line first))
                           (+ row (- last line))
                           (max 0 (+ line-col indent))
                           0
                           (- max-width 4))])
      (push-component!
       (ui.new-component! "comment-box" box render (hash "handle_event" handle-event "cursor" cursor)))
      box)))
