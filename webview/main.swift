// A window for one of ah's pages: a WKWebView in an app process of its own,
// so each page gets its own Dock tile and Cmd-Tab entry, and whether it takes
// focus is ah's call rather than the browser's. ah launches it with `open -n`
// so it never reuses a running one, adding -g when it shouldn't take focus.
// Launching is what brings it forward: macOS ignores the app's own activate()
// after a -g launch. --focus makes its window key.
//
//   ah-webview --url URL [--focus] [--other-display] [--badge TEXT] [--color HEX]
//
// --other-display fills a display without the pointer, preferring the
// built-in one. --badge and --color draw the Dock icon. Links off the
// loopback hosts open in the default browser.

import AppKit
import WebKit

struct Options {
  var url: URL
  var focus = false
  var otherDisplay = false
  var badge: String?
  var color = NSColor.systemIndigo
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
  ])
  add("View", [
    menuItem("Reload", #selector(WKWebView.reload(_:)), "r"),
    .separator(),
    menuItem("Actual Size", #selector(AppDelegate.actualSize(_:)), "0"),
    menuItem("Zoom In", #selector(AppDelegate.zoomIn(_:)), "="),
    menuItem("Zoom Out", #selector(AppDelegate.zoomOut(_:)), "-"),
  ])
  add("Window", [
    menuItem("Close", #selector(NSWindow.performClose(_:)), "w"),
    menuItem("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
  ])
  return main
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  let options: Options
  var window: NSWindow!
  var webView: WKWebView!
  var titleObservation: NSKeyValueObservation?
  /** Over the page while it can't be loaded */
  var overlay: NSView?

  init(options: Options) {
    self.options = options
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = mainMenu()
    if let badge = options.badge {
      NSApp.applicationIconImage = dockIcon(badge, color: options.color)
    }

    webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    webView.isInspectable = true
    // Pinch to zoom, as in Safari: it magnifies without reflowing the page
    webView.allowsMagnification = true
    webView.navigationDelegate = self
    webView.uiDelegate = self

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 960, height: 760),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false)
    window.contentView = webView
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

    if options.focus {
      NSApp.activate()
      window.makeKeyAndOrderFront(nil)
    } else {
      // In front of other apps' windows, but the keyboard stays where it is
      window.orderFrontRegardless()
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

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

  // The page's own frames go anywhere; the window itself stays on ah's pages
  func webView(
    _ webView: WKWebView,
    decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    guard action.targetFrame?.isMainFrame == true, let url = action.request.url,
      url.scheme == "http" || url.scheme == "https", !isLocal(url)
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
  FileHandle.standardError.write("usage: ah-webview --url URL [--focus] [--other-display] [--badge TEXT] [--color HEX]\n".data(using: .utf8)!)
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
