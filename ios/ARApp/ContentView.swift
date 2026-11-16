import SwiftUI

// The whole screen is the web page from the PC, transparent, on top of the native AR picture
// (stage 2). Pages that are not AR paint their own black background. Native UI only appears
// when the page can't load (ErrorPanel) or when the page asks for the server-address screen
// (SettingsView).
struct ContentView: View {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ARLayer(controller: model.ar)
                .ignoresSafeArea()
            WebView(model: model)
                .ignoresSafeArea()
            if let error = model.loadError {
                ErrorPanel(model: model, error: error)
            }
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView(model: model)
        }
        .task {
            model.sendStartupLog()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { NativeLog.shared.flush() }
        }
        .preferredColorScheme(.dark)
    }
}

/// The plain view the AR picture is drawn into (ARController creates the ARView on demand).
private struct ARLayer: UIViewRepresentable {
    let controller: ARController

    func makeUIView(context: Context) -> UIView { controller.container }

    func updateUIView(_ uiView: UIView, context: Context) {}
}

private struct ErrorPanel: View {
    @ObservedObject var model: AppModel
    let error: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("连不上电脑")
                .font(.title2.bold())
            Text(error)
                .foregroundStyle(.red)
            Text("地址：\(model.serverURL)")
                .font(.body.monospaced())
            VStack(alignment: .leading, spacing: 6) {
                Text("· 电脑上要开着开发服务器（npm.cmd run dev）")
                Text("· 手机和电脑要连同一个 Wi-Fi")
                Text("· 第一次打开时，要在弹窗里允许「本地网络」")
                Text("· 电脑的地址变了，就点「改地址」")
            }
            .font(.callout)
            .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button("重试") { model.retry() }
                    .buttonStyle(.borderedProminent)
                Button("改地址") { model.showSettings = true }
                    .buttonStyle(.bordered)
            }
            Text(BuildInfo.label)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, 40)
        .background(Color.black)
    }
}

private struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var draft = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(AppModel.defaultServer, text: $draft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("电脑的地址")
                } footer: {
                    Text("电脑上运行 npm.cmd run dev 后，终端里「Network」那一行就是这个地址。")
                }
                Section {
                    Button("恢复默认（\(AppModel.defaultServer)）") {
                        draft = AppModel.defaultServer
                    }
                }
                Section {
                    Text(BuildInfo.label)
                        .font(.footnote.monospaced())
                } header: {
                    Text("这个 app 的版本")
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        model.setServer(draft)
                        dismiss()
                    }
                }
            }
            .onAppear { draft = model.serverURL }
        }
    }
}
