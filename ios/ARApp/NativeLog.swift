import Foundation

// There is no debugger on the phone: native log lines are POSTed to the dev server on the PC
// (web/vite.config.js → terminal + notes/logs/). BLIND TEST: never log a trial's width.
//
// Lines are queued and saved to a file before sending, and stay queued until the PC answers:
// a line written while the PC is unreachable (or just before a crash) is delivered later, in
// order – also after the app was restarted. Each line carries the time it was written ("t"),
// its number within this launch ("seq") and the launch ("launch").
@MainActor
final class NativeLog {
    static let shared = NativeLog()

    /// "http://192.168.0.5:5173"; set by AppModel. Changing it redirects the queued lines too.
    var server = "" {
        didSet { if server != oldValue { flush() } }
    }
    /// Why the last send failed; nil after a success.
    private(set) var lastError: String?
    var pendingCount: Int { queue.count }

    private static let maxEntries = 400
    private static let iso = ISO8601DateFormatter()
    private let launch: String
    private let fileURL: URL
    private var queue: [[String: Any]] = []
    private var nextSeq = 1
    private var sending = false
    private var retryScheduled = false

    private init() {
        launch = String(UUID().uuidString.prefix(6)).lowercased()
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("log-queue.json")
        if let data = try? Data(contentsOf: fileURL),
           let saved = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
            queue = saved
        }
    }

    /// Queues a line and tries to send. Returns a key for `isPending`.
    @discardableResult
    func log(_ message: String, level: String = "info", data: [String: Any] = [:]) -> Int {
        let seq = nextSeq
        nextSeq += 1
        var entry: [String: Any] = [
            "source": "native",
            "level": level,
            "message": message,
            "version": BuildInfo.commit,
            "t": Self.iso.string(from: Date()),
            "seq": seq,
            "launch": launch,
        ]
        if !data.isEmpty {
            entry["data"] = JSONSerialization.isValidJSONObject(data) ? data : ["text": String(describing: data)]
        }
        queue.append(entry)
        if queue.count > Self.maxEntries {
            queue.removeFirst(queue.count - Self.maxEntries)
        }
        save()
        flush()
        return seq
    }

    /// True while a line written in this launch has not reached the PC yet.
    func isPending(_ seq: Int) -> Bool {
        queue.contains { Self.key($0) == "\(launch)-\(seq)" }
    }

    /// Starts sending the queued lines unless a send is already running (that one keeps going
    /// until the queue is empty, so nothing is skipped).
    func flush() {
        guard !sending, !queue.isEmpty, !server.isEmpty else { return }
        sending = true
        Task { @MainActor in
            await self.drain()
            self.sending = false
        }
    }

    private func drain() async {
        while let entry = queue.first {
            let key = Self.key(entry)
            guard let body = try? JSONSerialization.data(withJSONObject: entry) else {
                remove(key) // cannot be encoded: drop it rather than block the queue
                continue
            }
            let result = await Self.post(server: server, body: body)
            switch result {
            case .delivered:
                lastError = nil
                remove(key)
            case .rejected(let why):
                lastError = why // the PC answered but refused this line: retrying will not help
                remove(key)
            case .failed(let why):
                lastError = why
                scheduleRetry()
                return
            }
        }
    }

    private func remove(_ key: String) {
        if let index = queue.firstIndex(where: { Self.key($0) == key }) {
            queue.remove(at: index)
        }
        save()
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            self.retryScheduled = false
            self.flush()
        }
    }

    private func save() {
        guard let data = try? JSONSerialization.data(withJSONObject: queue) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    private static func key(_ entry: [String: Any]) -> String {
        let launch = entry["launch"] as? String ?? "?"
        let seq = (entry["seq"] as? NSNumber)?.intValue ?? -1
        return "\(launch)-\(seq)"
    }

    private enum SendResult {
        case delivered
        case rejected(String)
        case failed(String)
    }

    private nonisolated static func post(server: String, body: Data) async -> SendResult {
        guard let url = URL(string: server + "/__log") else { return .failed("地址格式不对：\(server)") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code == 200 { return .delivered }
            if code == 400 || code == 413 { return .rejected("HTTP \(code)") }
            return .failed("HTTP \(code)")
        } catch {
            let ns = error as NSError
            return .failed("\(ns.localizedDescription)（\(ns.code)）")
        }
    }
}

// An uncaught Objective-C exception (ARKit and RealityKit throw these for invalid settings)
// ends the app before anything can be sent. The handler writes it to a file; the next launch
// puts it in the startup log. Swift runtime traps are not caught – for those, the last queued
// log lines show how far the app got.
enum CrashNote {
    private static var url: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("last-exception.txt")
    }

    static func install() {
        NSSetUncaughtExceptionHandler { exception in
            let stack = exception.callStackSymbols.prefix(14).joined(separator: "\n")
            let text = "\(exception.name.rawValue): \(exception.reason ?? "")\n\(stack)"
            try? text.write(to: CrashNote.url, atomically: true, encoding: .utf8)
        }
    }

    /// The exception that ended the previous run, if any. Reading it removes it.
    static func take() -> String? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        try? FileManager.default.removeItem(at: url)
        return text
    }
}
