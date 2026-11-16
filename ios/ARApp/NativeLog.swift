import Foundation

// There is no debugger on the phone: native log lines are POSTed to the dev server on the PC
// (web/vite.config.js → terminal + notes/logs/). BLIND TEST: never log a trial's width.
enum NativeLog {
    /// - Returns: nil when the PC answered 200, otherwise a short error text.
    static func post(server: String, message: String, level: String = "info", data: [String: String] = [:]) async -> String? {
        guard let url = URL(string: server + "/__log") else { return "地址格式不对：\(server)" }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "source": "native",
            "level": level,
            "message": message,
            "data": data,
            "version": BuildInfo.commit,
            "t": ISO8601DateFormatter().string(from: Date()),
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            return code == 200 ? nil : "HTTP \(code)"
        } catch {
            let ns = error as NSError
            return "\(ns.localizedDescription)（\(ns.code)）"
        }
    }

    /// Fire and forget.
    static func send(server: String, _ message: String, level: String = "info", data: [String: String] = [:]) {
        Task { _ = await post(server: server, message: message, level: level, data: data) }
    }
}
