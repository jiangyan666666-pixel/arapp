import Foundation

// Which build is on the phone: the commit's short hash and the build time, written into
// Info.plist by the cloud build (see .github/workflows/ios.yml). A local build shows "local".
enum BuildInfo {
    static let commit = value("ARAppGitCommit")
    static let time = value("ARAppBuildTime")
    static var label: String { "版本 \(commit) · \(time)" }

    private static func value(_ key: String) -> String {
        let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
        let s = raw.trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? "local" : s
    }
}
