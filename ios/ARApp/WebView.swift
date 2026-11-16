import SwiftUI
import UIKit
import WebKit

// Full-screen WKWebView showing the pages from the PC's dev server. It is transparent: where
// a page has no background, the AR picture underneath shows through (ContentView). The web
// view is on top and gets every touch; the AR layer has no gestures.
//
// Messages (web/src/native.js):
//   web → native: window.webkit.messageHandlers.native.postMessage({type, id, payload})
//   native → web: window.__fromNative({id, ...reply})      reply to one message
//                 window.__nativeEvent({type, ...})        unasked, e.g. "ar.status"
// Types: "ping" → {type: "pong", echo: payload}; "status" → AppModel.status();
//        "openSettings" → shows the server-address screen; "ar.*" → ARController.
// Before any page script runs,
//   window.__nativeInfo = {version, buildTime, label, ios, model, features: ["ar"]}.
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

    private static func infoScript() -> String {
        let info: [String: Any] = [
            "version": BuildInfo.commit,
            "buildTime": BuildInfo.time,
            "label": BuildInfo.label,
            "ios": UIDevice.current.systemVersion,
            "model": BuildInfo.deviceModel,
            "features": ["ar"],
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
            _ = model.ar.stop()
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
            case "ar.setFurniture":
                reply(id, ar.setFurniture(payload))
            case "ar.moveFurniture":
                reply(id, ar.moveFurniture(payload))
            case "ar.clearFurniture":
                reply(id, ar.clearFurniture())
            case "ar.capture":
                reply(id, ar.capture(payload))
            default:
                reply(id, ["error": "unknown message type: \(type)"])
            }
        }

        /// An event the page did not ask for: window.__nativeEvent(event).
        func send(event: [String: Any]) {
            guard JSONSerialization.isValidJSONObject(event),
                  let data = try? JSONSerialization.data(withJSONObject: event),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView?.evaluateJavaScript("window.__nativeEvent && window.__nativeEvent(\(json))", completionHandler: nil)
        }

        private func reply(_ id: Any?, _ payload: [String: Any]) {
            var message = payload
            message["id"] = id ?? NSNull()
            guard JSONSerialization.isValidJSONObject(message),
                  let data = try? JSONSerialization.data(withJSONObject: message),
                  let json = String(data: data, encoding: .utf8) else {
                NativeLog.shared.log("could not encode reply", level: "error")
                if let number = id as? NSNumber {
                    // Still answer, so the page does not wait for its timeout.
                    webView?.evaluateJavaScript("window.__fromNative && window.__fromNative({id: \(number.intValue), error: 'native could not encode the reply'})", completionHandler: nil)
                }
                return
            }
            webView?.evaluateJavaScript("window.__fromNative && window.__fromNative(\(json))", completionHandler: nil)
        }
    }
}
