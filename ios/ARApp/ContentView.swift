import SwiftUI

// Stage 0: an empty app whose only job is to prove the cloud build and the install work.
// Stage 1 replaces this with a full-screen WKWebView that loads the trial page from the PC.
struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("ARApp")
                .font(.largeTitle.bold())
            Text("阶段 0：只验证云端编译和安装。")
                .foregroundStyle(.secondary)
            Spacer()
            Text(BuildInfo.label)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .preferredColorScheme(.dark)
    }
}
