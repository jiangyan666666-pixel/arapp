import Foundation
import UIKit

// App-wide state: which PC to load the pages from, whether loading failed, and whether the
// startup log reached the PC. The PC's LAN address changes, so it is editable in the app
// (SettingsView) and remembered in UserDefaults.
@MainActor
final class AppModel: ObservableObject {
    static let defaultServer = "http://192.168.0.215:5173"
    private static let serverKey = "serverURL"

    @Published private(set) var serverURL: String
    @Published var loadError: String?
    @Published var showSettings = false

    /// Set by WebView: reloads the page from `serverURL`.
    var reload: (@MainActor () -> Void)?

    private(set) var startupLog = "还没发送"
    private(set) var startupLogOK = false
    private var sendingStartupLog = false

    init() {
        serverURL = UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer
    }

    /// Accepts "192.168.0.5:5173", "http://192.168.0.5:5173/" etc.; empty → default.
    func setServer(_ raw: String) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty && !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        if s.isEmpty { s = Self.defaultServer }
        serverURL = s
        UserDefaults.standard.set(s, forKey: Self.serverKey)
        startupLogOK = false
        startupLog = "还没发送"
        reload?()
        Task { await sendStartupLog() }
    }

    func retry() {
        reload?()
        if !startupLogOK { Task { await sendStartupLog() } }
    }

    /// Called when a page finished loading. The first launch usually fails the startup log
    /// while iOS asks for local-network permission, so try again once a page got through.
    func pageLoaded() {
        loadError = nil
        if !startupLogOK { Task { await sendStartupLog() } }
    }

    func sendStartupLog() async {
        if sendingStartupLog || startupLogOK { return }
        sendingStartupLog = true
        defer { sendingStartupLog = false }
        let error = await NativeLog.post(
            server: serverURL,
            message: "app started",
            data: ["ios": UIDevice.current.systemVersion, "model": BuildInfo.deviceModel]
        )
        startupLogOK = error == nil
        startupLog = error.map { "发送失败：\($0)" } ?? "电脑收到了"
    }

    /// Reply to the web page's "status" message.
    func status() -> [String: Any] {
        [
            "server": serverURL,
            "startupLog": startupLog,
            "startupLogOK": startupLogOK,
            "version": BuildInfo.commit,
            "buildTime": BuildInfo.time,
        ]
    }
}
