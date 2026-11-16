import SwiftUI
import UIKit
import WebKit

// Full-screen WKWebView showing the pages from the PC's dev server.
//
// Messages (web/src/native.js):
//   web → native: window.webkit.messageHandlers.native.postMessage({type, id, payload})
//   native → web: window.__fromNative({id, ...reply})
// Types: "ping" → {type: "pong", echo: payload}; "status" → AppModel.status();
//        "openSettings" → shows the server-address screen.
// Before any page script runs, window.__nativeInfo = {version, buildTime, label, ios, model}.
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
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        // The pages handle the notch themselves (viewport-fit=cover + env(safe-area-inset-*)).
        web.scrollView.contentInsetAdjustmentBehavior = .never

        context.coordinator.webView = web
        model.reload = { [weak coordinator = context.coordinator] in coordinator?.load() }
        context.coordinator.load()
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    private static func infoScript() -> String {
        let info: [String: String] = [
            "version": BuildInfo.commit,
            "buildTime": BuildInfo.time,
            "label": BuildInfo.label,
            "ios": UIDevice.current.systemVersion,
            "model": BuildInfo.deviceModel,
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
            NativeLog.send(server: model.serverURL, "web content process terminated, reloading", level: "warn")
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
            default:
                reply(id, ["error": "unknown message type: \(type)"])
            }
        }

        private func reply(_ id: Any?, _ payload: [String: Any]) {
            var message = payload
            message["id"] = id ?? NSNull()
            guard JSONSerialization.isValidJSONObject(message),
                  let data = try? JSONSerialization.data(withJSONObject: message),
                  let json = String(data: data, encoding: .utf8) else {
                NativeLog.send(server: model.serverURL, "could not encode reply", level: "error")
                return
            }
            webView?.evaluateJavaScript("window.__fromNative && window.__fromNative(\(json))", completionHandler: nil)
        }
    }
}
