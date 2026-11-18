import SwiftUI
import UIKit
import WebKit

// Full-screen WKWebView showing the pages from the PC's dev server. It is transparent: where
// a page has no background, the AR picture underneath shows through (ContentView). The web
// view is on top and gets every touch; the AR layer has no gestures.
//
// Messages (web/src/native.js; docs/protocol.md is the contract):
//   web → native: window.webkit.messageHandlers.native.postMessage({type, id, payload})
//   native → web: window.__fromNative({id, ...reply})      reply to one message
//                 window.__nativeEvent({type, ...})        unasked, e.g. "ar.status", "ar.hands"
// A message without an id (or with id null) gets no reply: fire-and-forget for what the page
// sends every frame (ar.updateGroups via postNative()).
// Types: "ping" → {type: "pong", echo: payload}; "status" → AppModel.status();
//        "openSettings" → shows the server-address screen; "haptic" → Haptics (works without AR);
//        "ar.*" → ARController (session, raycast, capture, depth, planes, light), its
//        HandTracker (ar.hands) and BoxGroups (ar.setGroup … ar.groups, ar.*Furniture).
// Before any page script runs,
//   window.__nativeInfo = {version, buildTime, label, ios, model, features}
// with features = ["ar", "hands", "groups", "planes", "depth", "haptic", "light", "erase"].
struct WebView: UIViewRepresentable {
    let model: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "native")
        contentController.addUserScript(WKUserScript(
            source: Self.infoScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.underPageBackgroundColor = .clear
        // The pages handle the notch themselves (viewport-fit=cover + env(safe-area-inset-*)).
        web.scrollView.contentInsetAdjustmentBehavior = .never

        context.coordinator.webView = web
        model.reload = { [weak coordinator = context.coordinator] in coordinator?.load() }
        model.ar.emit = { [weak coordinator = context.coordinator] event in coordinator?.send(event: event) }
        context.coordinator.load()
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    /// What this app can do; pages check before using a stage-3 message (hasFeature in native.js).
    static let features = ["ar", "hands", "groups", "planes", "depth", "haptic", "light", "erase"]

    private static func infoScript() -> String {
        let info: [String: Any] = [
            "version": BuildInfo.commit,
            "buildTime": BuildInfo.time,
            "label": BuildInfo.label,
            "ios": UIDevice.current.systemVersion,
            "model": BuildInfo.deviceModel,
            "features": features,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: info)) ?? Data("{}".utf8)
        let json = String(data: data, encoding: .utf8) ?? "{}"
        return "window.__nativeInfo = \(json);"
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let model: AppModel
        weak var webView: WKWebView?

        init(model: AppModel) {
            self.model = model
        }

        func load() {
            guard let url = URL(string: model.serverURL), url.scheme != nil, url.host != nil else {
                model.loadError = "地址格式不对：\(model.serverURL)"
                return
            }
            model.loadError = nil
            webView?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8))
        }

        // MARK: navigation

        /// A new page (or a reload) starts without AR; the page asks for it again if it wants it.
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            model.ar.pageChanged()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.pageLoaded()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            NativeLog.shared.log("web content process terminated, reloading", level: "warn")
            // The page that owned the camera is gone: without this, AR (camera, LiDAR, Vision)
            // would keep running under the error panel if the reload fails.
            model.ar.pageChanged()
            webView.reload()
        }

        private func fail(_ error: Error) {
            let ns = error as NSError
            if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return } // superseded by a newer load
            model.loadError = "\(ns.localizedDescription)（\(ns.code)）"
        }

        // MARK: messages from the page

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            let id = body["id"]
            let payload = body["payload"] as? [String: Any] ?? [:]
            let ar = model.ar
            switch type {
            case "ping":
                reply(id, [
                    "type": "pong",
                    "echo": body["payload"] ?? NSNull(),
                    "nativeTime": Date().timeIntervalSince1970 * 1000,
                ])
            case "status":
                reply(id, model.status())
            case "openSettings":
                model.showSettings = true
                reply(id, ["ok": true])
            case "ar.start":
                // Waits for the camera-permission question the first time.
                Task { @MainActor [weak self] in
                    let result = await ar.start(payload)
                    self?.reply(id, result)
                }
            case "ar.stop":
                reply(id, ar.stop())
            case "ar.setOptions":
                reply(id, ar.setOptions(payload))
            case "ar.state":
                reply(id, ar.state())
            case "ar.raycast":
                reply(id, ar.raycast(payload))
            case "ar.capture":
                reply(id, ar.capture(payload))
            case "ar.depth":
                reply(id, ar.depth(payload))
            case "ar.planes":
                reply(id, ar.planes())
            case "ar.setLight":
                reply(id, ar.setLight(payload))
            case "ar.hands":
                reply(id, ar.hands.configure(payload))
            case "ar.updateGroups":
                // Every frame, usually without an id (then there is no reply).
                reply(id, ar.boxes.updateGroups(payload))
            case "ar.setGroup":
                reply(id, ar.boxes.setGroup(payload))
            case "ar.moveGroup":
                reply(id, ar.boxes.moveGroup(payload))
            case "ar.removeGroup":
                reply(id, ar.boxes.removeGroup(payload))
            case "ar.clearGroups":
                ar.boxes.removeAll()
                reply(id, ["ok": true])
            case "ar.groups":
                reply(id, ar.boxes.listGroups())
            case "ar.setFurniture":
                reply(id, ar.boxes.setFurniture(payload))
            case "ar.moveFurniture":
                reply(id, ar.boxes.moveFurniture(payload))
            case "ar.clearFurniture":
                reply(id, ar.boxes.clearFurniture())
            case "haptic":
                reply(id, Haptics.play(payload))
            default:
                let name = String(type.prefix(40))
                LogOnce.shared.log("type \(name)", "unknown message type", data: ["type": name])
                reply(id, ["error": "unknown message type: \(name)"])
            }
        }

        /// An event the page did not ask for: window.__nativeEvent(event).
        func send(event: [String: Any]) {
            guard let json = Self.json(event, what: event["type"] as? String ?? "event") else { return }
            webView?.evaluateJavaScript("window.__nativeEvent && window.__nativeEvent(\(json))", completionHandler: nil)
        }

        /// The reply to one message – only if it came with an id (protocol §1).
        private func reply(_ id: Any?, _ payload: [String: Any]) {
            guard let id, !(id is NSNull) else { return }
            var message = payload
            message["id"] = id
            guard let json = Self.json(message, what: "reply") else {
                if let number = id as? NSNumber {
                    // Still answer, so the page does not wait for its timeout.
                    webView?.evaluateJavaScript("window.__fromNative && window.__fromNative({id: \(number.intValue), error: 'native could not encode the reply'})", completionHandler: nil)
                }
                return
            }
            webView?.evaluateJavaScript("window.__fromNative && window.__fromNative(\(json))", completionHandler: nil)
        }

        /// JSON text, or nil. JSONSerialization refuses NaN and infinity; numbers are rounded
        /// before they get here, but if one slips through it is sent as 0 (logged once per kind
        /// of message) rather than the whole message silently disappearing.
        private static func json(_ object: [String: Any], what: String) -> String? {
            var value: Any = object
            if !JSONSerialization.isValidJSONObject(value) {
                value = jsonSafe(object)
                LogOnce.shared.log("json \(what)", "message had values JSON cannot hold; sent with 0 instead", level: "error", data: ["message": what])
            }
            guard JSONSerialization.isValidJSONObject(value),
                  let data = try? JSONSerialization.data(withJSONObject: value),
                  let json = String(data: data, encoding: .utf8) else {
                NativeLog.shared.log("could not encode a message", level: "error", data: ["message": what])
                return nil
            }
            return json
        }
    }
}
