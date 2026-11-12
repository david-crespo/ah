// A window for one of ah's pages: a WKWebView in an app process of its own,
// so each page gets its own Dock tile and Cmd-Tab entry, and whether it takes
// focus is ah's call rather than the browser's. ah launches it with `open -n`
// so it never reuses a running one, adding -g when it shouldn't take focus.
// Launching is what brings it forward: macOS ignores the app's own activate()
// after a -g launch. --focus makes its window key.
//
//   ah-webview --url URL [--focus] [--other-display] [--badge TEXT] [--color HEX]
//              [--socket PATH]
//
// --other-display fills a display without the pointer, preferring the
// built-in one. --badge and --color draw the Dock icon. Links off the
// loopback hosts open in the default browser, and links of other schemes
// (mailto:) in their apps. ⌘[ and ⌘] go back and forward.
//
// ⌘F opens a find bar over the page's top right corner, for any page, and
// ⌘G and ⇧⌘G go to the next and previous match. A page that handles ⌘F
// itself, like a doc page, keeps it: WKWebView only passes a key the page
// didn't take on to the menu.
//
// Hovering a link shows its address in the bottom left corner, as a
// browser's status bar does: a script in every frame reports the link under
// the pointer, and the window draws it over the page.
//
// --socket PATH has the app listen there for the server's questions, like
// whether to push a stack's PR: each connection sends one as a line of JSON,
// the window shows it in a sheet, and the app answers "yes" or "no" on the
// same connection. Pages can't reach a Unix socket, and no script message
// handler answers a question, so only a click in the sheet says yes. Escape,
// Cancel, 2 minutes without an answer, and the server hanging up say no.

import AppKit
import WebKit

struct Options {
  var url: URL
  var focus = false
  var otherDisplay = false
  var badge: String?
  var color = NSColor.systemIndigo
  var socket: String?
}

func parseOptions(_ args: [String]) -> Options? {
  var url: URL?
  var options = Options(url: URL(string: "about:blank")!)
  var rest = args[...]
  while let arg = rest.popFirst() {
    switch arg {
    case "--url": url = rest.popFirst().flatMap(URL.init(string:))
    case "--focus": options.focus = true
    case "--other-display": options.otherDisplay = true
    case "--badge": options.badge = rest.popFirst()
    case "--color": if let c = rest.popFirst().flatMap(color(hex:)) { options.color = c }
    case "--socket": options.socket = rest.popFirst()
    default: break  // LaunchServices may add its own, like -psn_…
    }
  }
  guard let url else { return nil }
  options.url = url
  return options
}

func color(hex: String) -> NSColor? {
  let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
  guard digits.count == 6, let value = Int(digits, radix: 16) else { return nil }
  return NSColor(
    srgbRed: CGFloat((value >> 16) & 0xff) / 255,
    green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255,
    alpha: 1)
}

/** A rounded square in `color` with `text` on it */
func dockIcon(_ text: String, color: NSColor) -> NSImage {
  NSImage(size: NSSize(width: 512, height: 512), flipped: false) { rect in
    color.setFill()
    NSBezierPath(roundedRect: rect.insetBy(dx: 50, dy: 50), xRadius: 92, yRadius: 92).fill()
    let size: CGFloat = text.count > 2 ? 150 : 230
    let label = NSAttributedString(
      string: text,
      attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: .semibold),
        .foregroundColor: NSColor.white,
      ])
    let bounds = label.size()
    label.draw(at: NSPoint(x: rect.midX - bounds.width / 2, y: rect.midY - bounds.height / 2))
    return true
  }
}

/** A display without the pointer, the built-in one if that's among them */
func otherScreen() -> NSScreen? {
  let mouse = NSEvent.mouseLocation
  let others = NSScreen.screens.filter { !NSMouseInRect(mouse, $0.frame, false) }
  return others.first { $0.localizedName.hasPrefix("Built-in") } ?? others.first
}

/** ah's own servers and the pages they serve */
func isLocal(_ url: URL) -> Bool {
  guard let host = url.host() else { return false }
  return host == "127.0.0.1" || host == "localhost" || host.hasSuffix(".localhost")
}

func menuItem(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
  NSMenuItem(title: title, action: action, keyEquivalent: key)
}

/** ⌥⌘I, as in Safari */
func inspectorItem() -> NSMenuItem {
  let item = menuItem("Show Web Inspector", #selector(AppDelegate.showInspector(_:)), "i")
  item.keyEquivalentModifierMask = [.command, .option]
  return item
}

/** WKWebView's editing commands and the window's need a menu to have keys */
func mainMenu() -> NSMenu {
  let main = NSMenu()
  func add(_ title: String, _ items: [NSMenuItem]) {
    let menu = NSMenu(title: title)
    for item in items { menu.addItem(item) }
    let holder = NSMenuItem()
    holder.submenu = menu
    main.addItem(holder)
  }
  let name = ProcessInfo.processInfo.processName
  add(name, [
    menuItem("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
    .separator(),
    menuItem("Quit \(name)", #selector(NSApplication.terminate(_:)), "q"),
  ])
  add("Edit", [
    menuItem("Undo", Selector(("undo:")), "z"),
    menuItem("Redo", Selector(("redo:")), "Z"),
    .separator(),
    menuItem("Cut", #selector(NSText.cut(_:)), "x"),
    menuItem("Copy", #selector(NSText.copy(_:)), "c"),
    menuItem("Paste", #selector(NSText.paste(_:)), "v"),
    menuItem("Select All", #selector(NSText.selectAll(_:)), "a"),
    .separator(),
    menuItem("Find…", #selector(AppDelegate.showFind(_:)), "f"),
    menuItem("Find Next", #selector(AppDelegate.findNext(_:)), "g"),
    menuItem("Find Previous", #selector(AppDelegate.findPrevious(_:)), "G"),
  ])
  add("View", [
    menuItem("Reload", #selector(WKWebView.reload(_:)), "r"),
    menuItem("Back", #selector(WKWebView.goBack(_:)), "["),
    menuItem("Forward", #selector(WKWebView.goForward(_:)), "]"),
    .separator(),
    menuItem("Actual Size", #selector(AppDelegate.actualSize(_:)), "0"),
    menuItem("Zoom In", #selector(AppDelegate.zoomIn(_:)), "="),
    menuItem("Zoom Out", #selector(AppDelegate.zoomOut(_:)), "-"),
    .separator(),
    inspectorItem(),
  ])
  add("Window", [
    menuItem("Close", #selector(NSWindow.performClose(_:)), "w"),
    menuItem("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
  ])
  return main
}

/** What the server asks: a heading, notes under it, then rows of an ID and
 * a line of text, and how many rows didn't fit. `button` says yes. */
struct Question: Decodable, Sendable {
  struct Row: Decodable, Sendable {
    let id: String
    let text: String
  }
  let heading: String
  let notes: [String]
  let rows: [Row]
  let more: Int
  let button: String
}

/** A listening Unix socket at `path`, or nil if it can't be made */
func listenUnix(_ path: String) -> Int32? {
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
  withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { return nil }
  unlink(path)
  let bound = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  guard bound == 0, chmod(path, 0o600) == 0, listen(fd, 4) == 0 else {
    close(fd)
    return nil
  }
  return fd
}

/** The first line on `fd`, without its newline; nil if it closes first */
func readLine(_ fd: Int32) -> Data? {
  var line = Data()
  var byte: UInt8 = 0
  while read(fd, &byte, 1) == 1 {
    if byte == 10 { return line }
    line.append(byte)
    if line.count > 1 << 20 { return nil }
  }
  return nil
}

/** Accept connections on `listener` for good, each on a thread of its own:
 * read its question, hand it to `ask` on the main thread, and when the
 * connection ends, whether the server hung up or the answer was sent, tell
 * `hungUp` and close it */
func serveQuestions(
  _ listener: Int32,
  ask: @escaping @MainActor @Sendable (Question, Int32) -> Void,
  hungUp: @escaping @MainActor @Sendable (Int32) -> Void
) {
  Thread.detachNewThread {
    while true {
      let fd = accept(listener, nil, nil)
      if fd < 0 { continue }
      var on: Int32 = 1
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      Thread.detachNewThread {
        if let line = readLine(fd),
          let question = try? JSONDecoder().decode(Question.self, from: line)
        {
          DispatchQueue.main.async { MainActor.assumeIsolated { ask(question, fd) } }
          // Until the server hangs up, or the answer's shutdown ends it
          var byte: UInt8 = 0
          while read(fd, &byte, 1) > 0 {}
        }
        DispatchQueue.main.sync { MainActor.assumeIsolated { hungUp(fd) } }
        close(fd)
      }
    }
  }
}

@MainActor
func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular) -> NSTextField {
  let field = NSTextField(labelWithString: text)
  field.font = .systemFont(ofSize: size, weight: weight)
  return field
}

/** A question in a sheet on a window: Cancel and its button, which Return
 * clicks. Text is shown as plain strings, never as markup. */
@MainActor
final class Asking: NSObject {
  static let width: CGFloat = 520
  let fd: Int32
  let sheet: NSWindow
  weak var parent: NSWindow?
  var answered = false
  /** Space after a view in the sheet, where it isn't the usual */
  var gaps: [NSView: CGFloat] = [:]

  init(_ question: Question, fd: Int32, on parent: NSWindow) {
    self.fd = fd
    self.parent = parent
    sheet = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: Asking.width, height: 100),
      styleMask: [.titled], backing: .buffered, defer: true)
    super.init()

    let heading = NSTextField(wrappingLabelWithString: question.heading)
    heading.font = .systemFont(ofSize: 15, weight: .semibold)
    // Each as wide as the sheet's inside, so notes wrap there and rows cut
    var views: [NSView] = [heading]
    for note in question.notes {
      let field = NSTextField(wrappingLabelWithString: note)
      field.font = .systemFont(ofSize: 13)
      views.append(field)
    }
    for (i, row) in question.rows.enumerated() {
      let id = NSTextField(labelWithString: row.id)
      id.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
      id.textColor = .secondaryLabelColor
      id.setContentCompressionResistancePriority(.required, for: .horizontal)
      let text = label(row.text)
      text.lineBreakMode = .byTruncatingTail
      text.toolTip = row.text
      text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      let line = NSStackView(views: [id, text])
      line.spacing = 8
      line.alignment = .firstBaseline
      views.append(line)
      if i == 0, let above = views.dropLast().last { gaps[above] = 14 }
    }
    if question.more > 0 {
      let more = label("and \(question.more) more")
      more.textColor = .secondaryLabelColor
      views.append(more)
    }
    let cancel = NSButton(title: "Cancel", target: nil, action: nil)
    cancel.keyEquivalent = "\u{1b}"
    let yes = NSButton(title: question.button, target: nil, action: nil)
    yes.keyEquivalent = "\r"
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let buttons = NSStackView(views: [spacer, cancel, yes])
    if let above = views.last { gaps[above] = 18 }
    views.append(buttons)

    let stack = NSStackView(views: views)
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 6
    for (view, gap) in gaps { stack.setCustomSpacing(gap, after: view) }
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 16, right: 20)
    sheet.contentView = stack
    NSLayoutConstraint.activate(
      [stack.widthAnchor.constraint(equalToConstant: Asking.width)]
        + views.map { $0.widthAnchor.constraint(equalToConstant: Asking.width - 40) })
    cancel.target = self
    cancel.action = #selector(cancel(_:))
    yes.target = self
    yes.action = #selector(confirm(_:))
  }

  func show() {
    guard let parent else { return answer(false) }
    parent.orderFrontRegardless()
    parent.beginSheet(sheet)
    Task {
      try? await Task.sleep(for: .seconds(120))
      self.answer(false)
    }
  }

  @objc func confirm(_ sender: Any?) { answer(true) }
  @objc func cancel(_ sender: Any?) { answer(false) }

  /** Send `yes` once, close the sheet, and end the connection */
  func answer(_ yes: Bool) {
    if answered { return }
    answered = true
    let reply = yes ? "yes\n" : "no\n"
    _ = reply.withCString { write(fd, $0, strlen($0)) }
    shutdown(fd, SHUT_RDWR)
    parent?.endSheet(sheet)
  }
}

/** Reports the address of the link under the pointer, "" when there is none,
 * to the "hoveredLink" message handler */
let hoveredLinkScript = """
  (() => {
    let shown = ""
    const report = (href) => {
      if (href === shown) return
      shown = href
      window.webkit.messageHandlers.hoveredLink.postMessage(href)
    }
    const linkAt = (target) => target instanceof Element ? target.closest("a[href]") : null
    document.addEventListener("mouseover", (e) => report(linkAt(e.target)?.href ?? ""), true)
    document.addEventListener("mouseleave", () => report(""))
    window.addEventListener("blur", () => report(""))
    window.addEventListener("pagehide", () => report(""))
  })()
  """

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
  WKScriptMessageHandler, NSSearchFieldDelegate
{
  let options: Options
  var window: NSWindow!
  var webView: WKWebView!
  var titleObservation: NSKeyValueObservation?
  /** Over the page while it can't be loaded */
  var overlay: NSView?
  /** The hovered link's address, in the bottom left corner */
  var linkStatus: NSView!
  var linkStatusText: NSTextField!
  /** ⌘F's bar, hidden until opened */
  var findBar: NSView!
  var findField: NSSearchField!
  /** The question in the window's sheet, by its connection */
  var asking: [Int32: Asking] = [:]

  init(options: Options) {
    self.options = options
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = mainMenu()
    if let badge = options.badge {
      NSApp.applicationIconImage = dockIcon(badge, color: options.color)
    }

    let configuration = WKWebViewConfiguration()
    configuration.userContentController.addUserScript(
      WKUserScript(
        source: hoveredLinkScript, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
    configuration.userContentController.add(self, name: "hoveredLink")
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.isInspectable = true
    // Pinch to zoom, as in Safari: it magnifies without reflowing the page
    webView.allowsMagnification = true
    webView.navigationDelegate = self
    webView.uiDelegate = self
    // A web view paints white until its page first draws, which flashes in a
    // dark window. Until the load finishes, it shows the window behind it.
    // WKWebView has no public setting for this
    webView.setValue(false, forKey: "drawsBackground")

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 960, height: 760),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false)
    window.contentView = webView
    addLinkStatus()
    addFindBar()
    window.isReleasedWhenClosed = false
    // Dark whatever the system's appearance, title bar and page alike: the
    // web view inherits it, so prefers-color-scheme is dark too
    window.appearance = NSAppearance(named: .darkAqua)
    if options.otherDisplay, let screen = otherScreen() {
      window.setFrame(screen.visibleFrame, display: false)
    } else if !window.setFrameUsingName(options.url.path()) {
      window.center()
    }
    window.setFrameAutosaveName(options.url.path())
    titleObservation = webView.observe(\.title) { [weak self] webView, _ in
      MainActor.assumeIsolated { self?.window.title = webView.title ?? "" }
    }
    webView.load(URLRequest(url: options.url))
    if let path = options.socket { listenForQuestions(path) }

    if options.focus {
      NSApp.activate()
      window.makeKeyAndOrderFront(nil)
    } else {
      // In front of other apps' windows, but the keyboard stays where it is
      window.orderFrontRegardless()
    }
  }

  func listenForQuestions(_ path: String) {
    guard let listener = listenUnix(path) else {
      FileHandle.standardError.write("ah-webview: can't listen on \(path)\n".data(using: .utf8)!)
      return
    }
    serveQuestions(
      listener,
      ask: { [weak self] question, fd in
        guard let self else { return }
        let asking = Asking(question, fd: fd, on: window)
        // One at a time: a second is a no while the first is up
        if !self.asking.isEmpty { return asking.answer(false) }
        self.asking[fd] = asking
        asking.show()
      },
      hungUp: { [weak self] fd in self?.asking.removeValue(forKey: fd)?.answer(false) })
  }

  func applicationWillTerminate(_ notification: Notification) {
    if let path = options.socket { unlink(path) }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  /** The strip a hovered link's address is shown in, hidden until there is one */
  func addLinkStatus() {
    linkStatusText = NSTextField(labelWithString: "")
    linkStatusText.font = .systemFont(ofSize: 11)
    linkStatusText.textColor = NSColor(white: 0.85, alpha: 1)
    linkStatusText.lineBreakMode = .byTruncatingMiddle
    linkStatusText.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    linkStatusText.translatesAutoresizingMaskIntoConstraints = false

    linkStatus = NSView()
    linkStatus.wantsLayer = true
    linkStatus.layer?.backgroundColor = NSColor(white: 0.16, alpha: 1).cgColor
    linkStatus.layer?.borderColor = NSColor(white: 0.3, alpha: 1).cgColor
    linkStatus.layer?.borderWidth = 1
    // A pill
    let height: CGFloat = 20
    linkStatus.layer?.cornerRadius = height / 2
    linkStatus.translatesAutoresizingMaskIntoConstraints = false
    linkStatus.isHidden = true
    linkStatus.addSubview(linkStatusText)
    webView.addSubview(linkStatus)
    NSLayoutConstraint.activate([
      linkStatusText.leadingAnchor.constraint(equalTo: linkStatus.leadingAnchor, constant: 10),
      linkStatusText.trailingAnchor.constraint(equalTo: linkStatus.trailingAnchor, constant: -10),
      linkStatusText.centerYAnchor.constraint(equalTo: linkStatus.centerYAnchor),
      linkStatus.heightAnchor.constraint(equalToConstant: height),
      // In from the edges, clear of the window's rounded corner
      linkStatus.leadingAnchor.constraint(equalTo: webView.leadingAnchor, constant: 8),
      linkStatus.bottomAnchor.constraint(equalTo: webView.bottomAnchor, constant: -8),
      linkStatus.widthAnchor.constraint(lessThanOrEqualTo: webView.widthAnchor, multiplier: 0.7),
    ])
  }

  func addFindBar() {
    findField = NSSearchField()
    findField.placeholderString = "Find in page"
    findField.delegate = self
    findField.translatesAutoresizingMaskIntoConstraints = false

    findBar = NSView()
    findBar.wantsLayer = true
    findBar.layer?.backgroundColor = NSColor(white: 0.16, alpha: 1).cgColor
    findBar.layer?.borderColor = NSColor(white: 0.3, alpha: 1).cgColor
    findBar.layer?.borderWidth = 1
    findBar.layer?.cornerRadius = 8
    findBar.translatesAutoresizingMaskIntoConstraints = false
    findBar.isHidden = true
    findBar.addSubview(findField)
    webView.addSubview(findBar)
    NSLayoutConstraint.activate([
      findField.leadingAnchor.constraint(equalTo: findBar.leadingAnchor, constant: 6),
      findField.trailingAnchor.constraint(equalTo: findBar.trailingAnchor, constant: -6),
      findField.topAnchor.constraint(equalTo: findBar.topAnchor, constant: 6),
      findField.bottomAnchor.constraint(equalTo: findBar.bottomAnchor, constant: -6),
      findField.widthAnchor.constraint(equalToConstant: 240),
      findBar.topAnchor.constraint(equalTo: webView.topAnchor, constant: 8),
      findBar.trailingAnchor.constraint(equalTo: webView.trailingAnchor, constant: -8),
    ])
  }

  @objc func showFind(_ sender: Any?) {
    findBar.isHidden = false
    window.makeFirstResponder(findField)
    findField.selectText(nil)
  }

  @objc func findNext(_ sender: Any?) { find(backwards: false) }
  @objc func findPrevious(_ sender: Any?) { find(backwards: true) }

  /** The next match after the page's selection, which WKWebView selects and
   * scrolls to. The field's text turns red when there's none. */
  func find(backwards: Bool) {
    let query = findField.stringValue
    if query.isEmpty { return }
    let configuration = WKFindConfiguration()
    configuration.backwards = backwards
    webView.find(query, configuration: configuration) { [weak self] result in
      self?.findField.textColor = result.matchFound ? .labelColor : .systemRed
    }
  }

  /** As the query changes, the match stays where it is if it still matches,
   * since a search starts after the selection */
  func controlTextDidChange(_ notification: Notification) {
    webView.evaluateJavaScript("getSelection().collapseToStart()") { [weak self] _, _ in
      self?.find(backwards: false)
    }
  }

  /** Return goes to the next match, ⇧Return the previous, and Escape closes */
  func control(
    _ control: NSControl, textView: NSTextView, doCommandBy selector: Selector
  ) -> Bool {
    switch selector {
    case #selector(NSResponder.insertNewline(_:)):
      find(backwards: NSApp.currentEvent?.modifierFlags.contains(.shift) == true)
    case #selector(NSResponder.cancelOperation(_:)):
      findBar.isHidden = true
      window.makeFirstResponder(webView)
    default:
      return false
    }
    return true
  }

  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.name == "hoveredLink", let href = message.body as? String else { return }
    linkStatusText.stringValue = href
    linkStatus.isHidden = href.isEmpty
  }

  /** Say the server can't be reached, over the page, and try again in 2s */
  func showUnreachable(_ error: Error) {
    overlay?.removeFromSuperview()
    let box = NSView(frame: webView.bounds)
    box.autoresizingMask = [.width, .height]
    box.wantsLayer = true
    box.layer?.backgroundColor = NSColor(white: 0.07, alpha: 0.94).cgColor
    let label = NSTextField(
      wrappingLabelWithString:
        "Can't reach ah's server\n\(options.url.absoluteString)\n\n"
        + "\(error.localizedDescription)\nTrying again every 2 seconds")
    label.alignment = .center
    label.textColor = .white
    label.font = .systemFont(ofSize: 14)
    label.translatesAutoresizingMaskIntoConstraints = false
    box.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: box.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: box.centerYAnchor),
      label.widthAnchor.constraint(lessThanOrEqualTo: box.widthAnchor, constant: -48),
    ])
    webView.addSubview(box)
    overlay = box
    Task {
      try? await Task.sleep(for: .seconds(2))
      webView.load(URLRequest(url: options.url))
    }
  }

  /** A failure to reach the server, rather than a load this app stopped */
  func unreachable(_ error: Error) -> Bool {
    let error = error as NSError
    return error.domain == NSURLErrorDomain && error.code != NSURLErrorCancelled
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    if unreachable(error) { showUnreachable(error) }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if unreachable(error) { showUnreachable(error) }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    overlay?.removeFromSuperview()
    overlay = nil
    // A page that sets no background of its own gets the usual one
    webView.setValue(true, forKey: "drawsBackground")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  // The page's window.close(), as a page whose file was closed calls
  func webViewDidClose(_ webView: WKWebView) {
    window.close()
  }

  @objc func actualSize(_ sender: Any?) {
    webView.pageZoom = 1
    webView.magnification = 1
  }
  @objc func zoomIn(_ sender: Any?) { webView.pageZoom *= 1.1 }
  @objc func zoomOut(_ sender: Any?) { webView.pageZoom /= 1.1 }

  /** Web Inspector, as ⌥⌘I opens it in Safari. isInspectable only adds
   * Inspect Element to the context menu, and WKWebView has no public call to
   * open it, so this uses the private _inspector. */
  @objc func showInspector(_ sender: Any?) {
    (webView.value(forKey: "_inspector") as? NSObject)?.perform(Selector(("show")))
  }

  // The page's own frames go anywhere on the web; the window itself stays on
  // ah's pages. A link of another scheme, like mailto: or vscode:, is the
  // app's for that scheme: loaded here, it would fail and read as ah's
  // server being down.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else { return decisionHandler(.allow) }
    let scheme = url.scheme ?? ""
    if !["http", "https", "about", "blob", "data"].contains(scheme) {
      // Only on a click, so a script can't launch apps
      if action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
      return decisionHandler(.cancel)
    }
    guard action.targetFrame?.isMainFrame == true, scheme == "http" || scheme == "https",
      !isLocal(url)
    else { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  // target=_blank and window.open
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }
}

guard let options = parseOptions(Array(CommandLine.arguments.dropFirst())) else {
  FileHandle.standardError.write("usage: ah-webview --url URL [--focus] [--other-display] [--badge TEXT] [--color HEX] [--socket PATH]\n".data(using: .utf8)!)
  exit(2)
}
// Held keys repeat, as in a terminal, so holding j in the Helix pane keeps
// moving instead of opening the accent picker
UserDefaults.standard.register(defaults: ["ApplePressAndHoldEnabled": false])
let app = NSApplication.shared
let delegate = AppDelegate(options: options)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
