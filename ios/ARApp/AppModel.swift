import Foundation
import UIKit

// App-wide state: which PC to load the pages from, whether loading failed, the AR layer, and
// whether the startup log reached the PC. The PC's LAN address changes, so it is editable in
// the app (SettingsView) and remembered in UserDefaults.
@MainActor
final class AppModel: ObservableObject {
    static let defaultServer = "http://192.168.0.215:5173"
    private static let serverKey = "serverURL"

    @Published private(set) var serverURL: String
    @Published var loadError: String?
    @Published var showSettings = false

    /// The native AR layer under the web page (ARController.swift).
    let ar: ARController

    /// Set by WebView: reloads the page from `serverURL`.
    var reload: (@MainActor () -> Void)?

    private var startupSeq: Int?

    init() {
        serverURL = UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer
        ar = ARController()
        NativeLog.shared.server = serverURL
    }

    /// Accepts "192.168.0.5:5173", "http://192.168.0.5:5173/" etc.; empty → default.
    func setServer(_ raw: String) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty && !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        if s.isEmpty { s = Self.defaultServer }
        serverURL = s
        UserDefaults.standard.set(s, forKey: Self.serverKey)
        NativeLog.shared.server = s
        NativeLog.shared.log("server address saved")
        reload?()
    }

    func retry() {
        reload?()
        NativeLog.shared.flush()
    }

    /// Called when a page finished loading: the PC is reachable now, so send what is queued.
    /// (The first launch cannot send while iOS is still asking for local-network permission.)
    func pageLoaded() {
        loadError = nil
        NativeLog.shared.flush()
    }

    /// Queued once per launch. It stays queued until the PC has it (NativeLog).
    func sendStartupLog() {
        guard startupSeq == nil else { return }
        var data: [String: Any] = [
            "ios": UIDevice.current.systemVersion,
            "model": BuildInfo.deviceModel,
            "buildTime": BuildInfo.time,
            "queuedFromEarlier": NativeLog.shared.pendingCount,
        ]
        if let crash = CrashNote.take() {
            data["previousRunEndedWith"] = crash
        }
        startupSeq = NativeLog.shared.log("app started", data: data)
    }

    /// Reply to the web page's "status" message.
    func status() -> [String: Any] {
        let delivered = startupSeq.map { !NativeLog.shared.isPending($0) } ?? false
        let text: String
        if delivered {
            text = "电脑收到了"
        } else if let error = NativeLog.shared.lastError {
            text = "发送失败：\(error)"
        } else {
            text = "还没发送"
        }
        return [
            "server": serverURL,
            "startupLog": text,
            "startupLogOK": delivered,
            "logPending": NativeLog.shared.pendingCount,
            "version": BuildInfo.commit,
            "buildTime": BuildInfo.time,
        ]
    }
}
