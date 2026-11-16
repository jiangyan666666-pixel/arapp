import SwiftUI

@main
struct ARAppApp: App {
    init() {
        CrashNote.install()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
