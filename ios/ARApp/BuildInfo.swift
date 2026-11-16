import Foundation

// Which build is on the phone: the commit's short hash and the build time, written into
// Info.plist by the cloud build (see .github/workflows/ios.yml). A local build shows "local".
enum BuildInfo {
    static let commit = value("ARAppGitCommit")
    static let time = value("ARAppBuildTime")
    static var label: String { "版本 \(commit) · \(time)" }

    /// e.g. "iPhone17,1" (iPhone 16 Pro).
    static let deviceModel: String = {
        var info = utsname()
        uname(&info)
        return Mirror(reflecting: info.machine).children.reduce(into: "") { text, child in
            if let byte = child.value as? Int8, byte != 0 {
                text.append(Character(UnicodeScalar(UInt8(bitPattern: byte))))
            }
        }
    }()

    private static func value(_ key: String) -> String {
        let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
        let s = raw.trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? "local" : s
    }
}
