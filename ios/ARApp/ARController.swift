import ARKit
import AVFoundation
import CoreImage
import ImageIO
import QuartzCore
import RealityKit
import UIKit

// The native AR layer under the transparent web page: camera, world tracking, LiDAR, occlusion,
// Vision hand pose and the boxes the page asks for. It is deliberately thin and has no logic of
// its own – the page decides everything and tells it through messages (docs/protocol.md is the
// contract; WebView.swift routes the messages here; web/src/ar.js is the other end):
//
//   ar.start {…options}        → runs the session (asks for camera permission the first time)
//   ar.stop                    → pauses it; removes all groups and the light; hands pause
//   ar.setOptions {…options}   → occlusion switches, render and debug options, planes, hands
//   ar.state
//   ar.raycast {x, y, allowing, alignment}   x, y in 0..1 of the screen → hits in world space
//   ar.capture {…what to include}   → one frame: LiDAR depth, camera pose, image, mesh, hands
//   ar.depth {rect?, step?, personDepth?}    → a piece of the LiDAR map (§7)
//   ar.planes                  → the detected planes (§6)
//   ar.setLight {on, direction?, intensity?, shadow?, shadowDistance?, color?}   (§8)
//   ar.hands {…config}         → HandTracker.swift (§4)
//   ar.setGroup / ar.updateGroups / ar.moveGroup / ar.removeGroup / ar.clearGroups / ar.groups
//                              → BoxGroups.swift (§5)
//   ar.setFurniture / ar.moveFurniture / ar.clearFurniture   stage 2: the group "furniture"
// and it sends events: "ar.status" a few times a second (camera pose, tracking, what ARKit sees,
// fps, heat, hand and box-update timing), "ar.hands" per processed camera frame, "ar.planes"
// when the planes change, "ar.error", "ar.interrupted".
//
// There are no gestures: the web page is on top and gets every touch.
// World space: metres, Y up (gravity), right-handed. Matrices are 16 numbers, column-major.
// BLIND TEST: never log the furniture's boxes or size.
@MainActor
final class ARController: NSObject, ARSessionDelegate {
    /// Sits under the web view. The ARView is created inside it on the first ar.start.
    let container: UIView
    /// Sends an event to the page.
    var emit: (([String: Any]) -> Void)?

    /// Vision hand pose on the camera frames.
    let hands: HandTracker
    /// The boxes the page draws, the stage-2 furniture among them.
    let boxes: BoxGroups

    private var arView: ARView?
    private var origin: AnchorEntity?
    private var running = false
    private var light: DirectionalLight?

    private var statusInterval: TimeInterval = 0.25
    private var lastStatusTime: TimeInterval = 0
    private var framesSinceStart = 0
    private var frameTimes = RecentValues(span: 1)
    private var planeEvents = true
    private var planesInterval: TimeInterval = 0.5
    private var planesDirty = false
    private var lastPlanesTime: TimeInterval = 0
    private var started: [String: Any] = [:]
    private lazy var ciContext = CIContext()
    private var thermalObserver: NSObjectProtocol?

    /// ar.start / ar.setOptions keys (protocol §2). Others are logged once and ignored.
    private static let optionKeys: Set<String> = [
        "personSegmentationWithDepth", "sceneDepth", "smoothedSceneDepth", "sceneReconstruction",
        "horizontalPlanes", "verticalPlanes", "reset",
        "personOcclusion", "meshOcclusion", "disable", "debug", "statusHz", "followAnchor",
        "meshReceivesLighting", "planeEvents", "planesHz", "hands",
    ]
    private static let lightKeys: Set<String> = ["on", "direction", "intensity", "shadow", "shadowDistance", "color"]
    private static let depthKeys: Set<String> = ["rect", "step", "personDepth"]

    override init() {
        container = UIView()
        container.backgroundColor = .black
        container.isUserInteractionEnabled = false
        hands = HandTracker()
        boxes = BoxGroups()
        super.init()
        hands.emit = { [weak self] event in self?.emit?(event) }
        // The phone gets hot with LiDAR + mesh + Vision running; the PC's log shows when.
        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
        ) { _ in
            logAnyThread("thermal state changed", data: ["thermal": thermalText(ProcessInfo.processInfo.thermalState)])
        }
    }

    // MARK: session

    func start(_ options: [String: Any]) async -> [String: Any] {
        NativeLog.shared.log("ar start: requested")
        logUnknownKeys(options, known: Self.optionKeys, in: "ar.start")
        if let problem = checkHandsOption(options) { return ["error": problem] }
        guard ARWorldTrackingConfiguration.isSupported else {
            return ["error": "ar-unsupported"]
        }
        let permission = AVCaptureDevice.authorizationStatus(for: .video)
        if permission == .notDetermined {
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            NativeLog.shared.log("ar start: camera permission answered", data: ["granted": granted])
            if !granted { return ["error": "camera-denied"] }
        } else if permission != .authorized {
            NativeLog.shared.log("ar start: camera not allowed", level: "warn", data: ["status": permission.rawValue])
            return ["error": "camera-denied"]
        }

        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        config.environmentTexturing = .automatic
        var planes: ARWorldTrackingConfiguration.PlaneDetection = []
        if flag(options, "horizontalPlanes", true) { planes.insert(.horizontal) }
        if flag(options, "verticalPlanes", true) { planes.insert(.vertical) }
        config.planeDetection = planes

        var support: [String: Any] = [:]
        let meshSupported = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
        support["sceneReconstruction"] = meshSupported
        let meshOn = meshSupported && flag(options, "sceneReconstruction", true)
        if meshOn { config.sceneReconstruction = .mesh }

        // An unsupported combination of frame semantics throws, so each one is added only if
        // the combination so far still reports as supported.
        let wanted: [(String, ARConfiguration.FrameSemantics, Bool)] = [
            ("personSegmentationWithDepth", .personSegmentationWithDepth, true),
            ("sceneDepth", .sceneDepth, true),
            ("smoothedSceneDepth", .smoothedSceneDepth, false),
        ]
        var semantics: ARConfiguration.FrameSemantics = []
        var used: [String] = []
        var skipped: [String] = []
        for (name, semantic, defaultOn) in wanted {
            let supported = ARWorldTrackingConfiguration.supportsFrameSemantics(semantic)
            support[name] = supported
            guard flag(options, name, defaultOn) else { continue }
            let combined = semantics.union(semantic)
            if supported && ARWorldTrackingConfiguration.supportsFrameSemantics(combined) {
                semantics = combined
                used.append(name)
            } else {
                skipped.append(name)
            }
        }
        config.frameSemantics = semantics

        let view = ensureView()
        view.isHidden = false
        _ = apply(options) // cannot fail: the only failing option (hands) was checked above

        var runOptions: ARSession.RunOptions = []
        if flag(options, "reset", true) {
            runOptions = [.resetTracking, .removeExistingAnchors, .resetSceneReconstruction]
            boxes.removeAll()
        }
        started = [
            "ok": true,
            "support": support,
            "frameSemantics": used,
            "skippedSemantics": skipped,
            "sceneReconstruction": meshOn,
            "viewport": list(view.bounds.size),
            "vision": ["handPose": true],
        ]
        var logged = started
        logged["thermal"] = thermalText(ProcessInfo.processInfo.thermalState)
        logged["hands"] = hands.config.json
        NativeLog.shared.log("ar start: running the session", data: logged)
        framesSinceStart = 0
        lastStatusTime = 0
        frameTimes = RecentValues(span: 1)
        planesDirty = true
        lastPlanesTime = 0
        let wasRunning = running
        view.session.run(config, options: runOptions)
        running = true
        if wasRunning {
            hands.sessionRestarted()
        } else {
            hands.sessionStarted()
        }
        UIApplication.shared.isIdleTimerDisabled = true
        NativeLog.shared.log("ar start: session.run returned")
        return started
    }

    /// A new page committed (or the web content process died): stop AR, and hand tracking goes
    /// back to its defaults (off). Unlike stop(), this also works before AR was ever started.
    func pageChanged() {
        _ = stop()
        hands.resetForNewPage()
    }

    func stop() -> [String: Any] {
        guard let view = arView else { return ["ok": true, "wasRunning": false] }
        // No boxes, no light after a stop. The hands config is kept (pageChanged resets it).
        boxes.removeAll()
        removeLight()
        hands.sessionStopped()
        guard running else { return ["ok": true, "wasRunning": false] }
        view.session.pause()
        running = false
        view.isHidden = true
        UIApplication.shared.isIdleTimerDisabled = false
        NativeLog.shared.log("ar stopped")
        return ["ok": true, "wasRunning": true]
    }

    func setOptions(_ options: [String: Any]) -> [String: Any] {
        guard arView != nil else { return ["error": "ar-not-started"] }
        logUnknownKeys(options, known: Self.optionKeys, in: "ar.setOptions")
        if let problem = apply(options) { return ["error": problem] }
        return state()
    }

    func state() -> [String: Any] {
        guard let view = arView else { return ["ok": true, "running": false, "hands": hands.config.json] }
        var result = started
        result["running"] = running
        result["meshOcclusion"] = view.environment.sceneUnderstanding.options.contains(.occlusion)
        result["meshReceivesLighting"] = view.environment.sceneUnderstanding.options.contains(.receivesLighting)
        result["personOcclusion"] = !view.renderOptions.contains(.disablePersonOcclusion)
        result["hasFurniture"] = boxes.has(BoxGroups.furnitureID)
        result["hands"] = hands.config.json
        result["groups"] = boxes.count
        result["light"] = light != nil
        result["planeEvents"] = planeEvents
        result["planesHz"] = round3(1 / planesInterval)
        result["followAnchor"] = boxes.followAnchor
        return result
    }

    private func ensureView() -> ARView {
        if let view = arView { return view }
        let view = ARView(frame: container.bounds, cameraMode: .ar, automaticallyConfigureSession: false)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.isUserInteractionEnabled = false
        container.addSubview(view)
        let anchor = AnchorEntity(world: matrix_identity_float4x4)
        view.scene.addAnchor(anchor)
        origin = anchor
        boxes.attach(root: anchor, session: view.session)
        view.session.delegate = self
        arView = view
        return view
    }

    /// nil, or why the "hands" option is not a valid ar.hands config.
    private func checkHandsOption(_ options: [String: Any]) -> String? {
        guard let h = given(options, "hands") else { return nil }
        guard let config = h as? [String: Any] else { return "hands: an ar.hands config object" }
        return hands.check(config).map { "hands: \($0)" }
    }

    /// The options that can change while the session runs. Keys that are absent stay as they are.
    /// Returns why it refused (only a bad "hands" config; then nothing is changed).
    private func apply(_ options: [String: Any]) -> String? {
        guard let view = arView else { return nil }
        if let problem = checkHandsOption(options) { return problem }
        // Real objects (the LiDAR mesh) hide the virtual boxes behind them.
        if let on = options["meshOcclusion"] as? Bool {
            if on {
                view.environment.sceneUnderstanding.options.insert(.occlusion)
            } else {
                view.environment.sceneUnderstanding.options.remove(.occlusion)
            }
        }
        // Virtual lights light the LiDAR mesh, so virtual objects cast shadows on real things.
        if let on = options["meshReceivesLighting"] as? Bool {
            if on {
                view.environment.sceneUnderstanding.options.insert(.receivesLighting)
            } else {
                view.environment.sceneUnderstanding.options.remove(.receivesLighting)
            }
        }
        // People (the hand) hide the virtual boxes behind them.
        if let on = options["personOcclusion"] as? Bool {
            if on {
                view.renderOptions.remove(.disablePersonOcclusion)
            } else {
                view.renderOptions.insert(.disablePersonOcclusion)
            }
        }
        if let names = options["disable"] as? [String] {
            let all: [(String, ARView.RenderOptions)] = [
                ("motionBlur", .disableMotionBlur),
                ("depthOfField", .disableDepthOfField),
                ("cameraGrain", .disableCameraGrain),
                ("hdr", .disableHDR),
                ("groundingShadows", .disableGroundingShadows),
                ("environmentLighting", .disableAREnvironmentLighting),
            ]
            for (name, option) in all {
                if names.contains(name) {
                    view.renderOptions.insert(option)
                } else {
                    view.renderOptions.remove(option)
                }
            }
        }
        if let names = options["debug"] as? [String] {
            var debug: ARView.DebugOptions = []
            if names.contains("mesh") { debug.insert(.showSceneUnderstanding) }
            if names.contains("planes") { debug.insert(.showAnchorGeometry) }
            if names.contains("anchors") { debug.insert(.showAnchorOrigins) }
            if names.contains("featurePoints") { debug.insert(.showFeaturePoints) }
            if names.contains("worldOrigin") { debug.insert(.showWorldOrigin) }
            if names.contains("statistics") { debug.insert(.showStatistics) }
            view.debugOptions = debug
        }
        if let hz = number(options["statusHz"]), hz > 0 {
            statusInterval = 1 / min(hz, 30)
        }
        if let follow = options["followAnchor"] as? Bool {
            boxes.followAnchor = follow
        }
        if let on = options["planeEvents"] as? Bool {
            planeEvents = on
            if on { planesDirty = true }
        }
        if let hz = number(options["planesHz"]), hz > 0 {
            planesInterval = 1 / min(hz, 30)
        }
        if let config = given(options, "hands") as? [String: Any] {
            _ = hands.configure(config) // checked above
        }
        return nil
    }

    // MARK: raycast

    func raycast(_ p: [String: Any]) -> [String: Any] {
        guard let view = arView, running else { return ["error": "ar-not-running"] }
        let x = min(max(number(p["x"]) ?? 0.5, -10), 10)
        let y = min(max(number(p["y"]) ?? 0.5, -10), 10)
        let point = CGPoint(x: x * Double(view.bounds.width), y: y * Double(view.bounds.height))

        let target: ARRaycastQuery.Target
        switch p["allowing"] as? String {
        case "existingPlaneGeometry": target = .existingPlaneGeometry
        case "existingPlaneInfinite": target = .existingPlaneInfinite
        default: target = .estimatedPlane
        }
        let alignment: ARRaycastQuery.TargetAlignment
        switch p["alignment"] as? String {
        case "horizontal": alignment = .horizontal
        case "vertical": alignment = .vertical
        default: alignment = .any
        }

        let results = view.raycast(from: point, allowing: target, alignment: alignment)
        let hits: [[String: Any]] = results.prefix(6).map { r in
            var hit: [String: Any] = [
                "position": list(r.worldTransform.columns.3),
                "transform": list(r.worldTransform),
                "alignment": r.targetAlignment == .horizontal ? "horizontal" : (r.targetAlignment == .vertical ? "vertical" : "any"),
            ]
            if let plane = r.anchor as? ARPlaneAnchor {
                hit["plane"] = planeClass(plane.classification)
            }
            return hit
        }
        var reply: [String: Any] = ["ok": true, "hits": hits]
        if let camera = view.session.currentFrame?.camera {
            reply["camera"] = list(camera.transform)
        }
        return reply
    }

    // MARK: capture

    /// One frame for tuning algorithms on the PC. Everything is in the camera sensor's own
    /// (landscape) orientation; "camera" has what is needed to map between the depth image,
    /// the screen and world space. Binary data is base64.
    func capture(_ p: [String: Any]) -> [String: Any] {
        guard let view = arView, running, let frame = view.session.currentFrame else {
            return ["error": "ar-not-running"]
        }
        let camera = frame.camera
        let viewport = view.bounds.size
        let display = frame.displayTransform(for: .portrait, viewportSize: viewport)
        var out: [String: Any] = [
            "ok": true,
            "timestamp": frame.timestamp,
            "tracking": trackingText(camera.trackingState),
            "camera": [
                "transform": list(camera.transform),
                "intrinsics": list(camera.intrinsics),
                "imageResolution": list(camera.imageResolution),
                "viewport": list(viewport),
                "projectionPortrait": list(camera.projectionMatrix(for: .portrait, viewportSize: viewport, zNear: 0.01, zFar: 100)),
                "viewMatrixPortrait": list(camera.viewMatrix(for: .portrait)),
                "displayTransform": list(display),
            ],
        ]
        if let pose = boxes.furniturePose() {
            out["furniture"] = pose // pose only – never the size (blind test)
        }

        if flag(p, "depth", true) {
            if let depth = frame.sceneDepth {
                out["depth"] = encode(depth.depthMap)
                out["depthSource"] = "sceneDepth"
                if let confidence = depth.confidenceMap { out["confidence"] = encode(confidence) }
            } else if let depth = frame.smoothedSceneDepth {
                out["depth"] = encode(depth.depthMap)
                out["depthSource"] = "smoothedSceneDepth"
                if let confidence = depth.confidenceMap { out["confidence"] = encode(confidence) }
            } else {
                out["depthSource"] = "none"
            }
        }
        if flag(p, "person", true) {
            if let segmentation = frame.segmentationBuffer { out["personMask"] = encode(segmentation) }
            if let estimated = frame.estimatedDepthData { out["personDepth"] = encode(estimated) }
        }
        if flag(p, "image", true) {
            let maxWidth = min(max(number(p["imageMaxWidth"]) ?? 960, 16), 4096)
            let image = CIImage(cvPixelBuffer: frame.capturedImage)
            let scale = image.extent.width > 0 ? min(1, maxWidth / Double(image.extent.width)) : 1
            let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
            let quality: [CIImageRepresentationOption: Any] = [qualityKey: 0.75]
            if let jpeg = ciContext.jpegRepresentation(of: scaled, colorSpace: CGColorSpaceCreateDeviceRGB(), options: quality) {
                out["image"] = [
                    "width": Int(scaled.extent.width.rounded()),
                    "height": Int(scaled.extent.height.rounded()),
                    "type": "jpeg",
                    "base64": jpeg.base64EncodedString(),
                ]
            }
        }
        var handCount = 0
        if flag(p, "hands", true) {
            // Vision on this very frame, on the main thread, with the same joint format and
            // depth samples as the ar.hands events.
            let found = hands.capture(frame, viewport: viewport)
            for (key, value) in found { out[key] = value }
            handCount = (found["hands"] as? [Any])?.count ?? 0
            out["handsConfig"] = hands.config.json
        }

        var planes: [[String: Any]] = []
        var meshes: [[String: Any]] = []
        let wantMesh = flag(p, "mesh", false)
        let radius = Float(min(max(number(p["meshRadius"]) ?? 4, 0), 100))
        let eye = camera.transform.columns.3
        for anchor in frame.anchors {
            if let plane = anchor as? ARPlaneAnchor {
                planes.append(planeJSON(plane))
            } else if wantMesh, let mesh = anchor as? ARMeshAnchor {
                let at = mesh.transform.columns.3
                if simd_distance(SIMD3<Float>(at.x, at.y, at.z), SIMD3<Float>(eye.x, eye.y, eye.z)) > radius { continue }
                let vertices = mesh.geometry.vertices
                let faces = mesh.geometry.faces
                let vertexData = Data(bytes: vertices.buffer.contents().advanced(by: vertices.offset), count: vertices.stride * vertices.count)
                let faceData = Data(bytes: faces.buffer.contents(), count: faces.count * faces.indexCountPerPrimitive * faces.bytesPerIndex)
                meshes.append([
                    "transform": list(mesh.transform),
                    "vertexCount": vertices.count,
                    "vertexStride": vertices.stride,
                    "faceCount": faces.count,
                    "indicesPerFace": faces.indexCountPerPrimitive,
                    "bytesPerIndex": faces.bytesPerIndex,
                    "vertices": vertexData.base64EncodedString(),
                    "faces": faceData.base64EncodedString(),
                ])
            }
        }
        out["planes"] = planes
        if wantMesh { out["meshes"] = meshes }
        NativeLog.shared.log("ar capture", data: [
            "depth": out["depthSource"] ?? "not asked",
            "planes": planes.count,
            "meshes": meshes.count,
            "hands": handCount,
        ])
        return out
    }

    /// A single-plane pixel buffer as {width, height, format, bytesPerPixel, base64}, rows packed.
    private func encode(_ buffer: CVPixelBuffer) -> [String: Any] {
        let format = CVPixelBufferGetPixelFormatType(buffer)
        let name = fourCC(format)
        if CVPixelBufferIsPlanar(buffer) { return ["error": "planar pixel buffer", "format": name] }
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else {
            return ["error": "could not lock pixel buffer", "format": name]
        }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        guard width > 0, height > 0, let base = CVPixelBufferGetBaseAddress(buffer) else {
            return ["error": "empty pixel buffer", "format": name]
        }
        let bytesPerPixel: Int
        switch format {
        case kCVPixelFormatType_DepthFloat32, kCVPixelFormatType_DisparityFloat32, kCVPixelFormatType_OneComponent32Float:
            bytesPerPixel = 4
        case kCVPixelFormatType_OneComponent8:
            bytesPerPixel = 1
        default:
            bytesPerPixel = max(1, rowBytes / width)
        }
        guard rowBytes >= width * bytesPerPixel else {
            return ["error": "pixel buffer rows shorter than expected", "format": name]
        }
        var data = Data(capacity: width * height * bytesPerPixel)
        for row in 0..<height {
            let line = base.advanced(by: row * rowBytes).assumingMemoryBound(to: UInt8.self)
            data.append(line, count: width * bytesPerPixel)
        }
        return [
            "width": width,
            "height": height,
            "format": name,
            "bytesPerPixel": bytesPerPixel,
            "base64": data.base64EncodedString(),
        ]
    }

    // MARK: depth on request (§7)

    /// ar.depth {rect?: [x0, y0, x1, y1] image coordinates, step?: 2, personDepth?: false}
    /// → {ok, t, camera, display, viewport, depthSize, rect: [u0, v0, u1, v1], step, w, h,
    ///    depth, info, personDepth?}. The step is raised if needed to stay within the whole map
    ///    (49 152 pixels).
    func depth(_ p: [String: Any]) -> [String: Any] {
        guard let view = arView, running, let frame = view.session.currentFrame else {
            return ["error": "ar-not-running"]
        }
        logUnknownKeys(p, known: Self.depthKeys, in: "ar.depth")
        guard let lidar = frame.sceneDepth ?? frame.smoothedSceneDepth else { return ["error": "no-depth"] }
        var rect: [Double] = [0, 0, 1, 1]
        if let v = given(p, "rect") {
            guard let r = numbers(v, count: 4) else { return ["error": "rect: [x0, y0, x1, y1] in 0..1"] }
            rect = r.map { min(max($0, 0), 1) }
        }
        var step = 2
        if let v = given(p, "step") {
            guard let s = integer(v), s >= 1 else { return ["error": "step: 1 or more"] }
            step = min(s, 64)
        }
        let wantPD: Bool
        do {
            wantPD = try optionalBool(p, "personDepth") ?? false
        } catch {
            return ["error": errorText(error)]
        }
        let maps = DepthMaps.lock(
            depth: lidar.depthMap, confidence: lidar.confidenceMap,
            person: frame.segmentationBuffer, personDepth: wantPD ? frame.estimatedDepthData : nil
        )
        defer { maps.unlock() }
        guard let map = maps.depth else { return ["error": "depth map in an unexpected format"] }
        let W = map.width
        let H = map.height
        let u0 = Int((min(rect[0], rect[2]) * Double(W)).rounded(.down))
        let u1 = Int((max(rect[0], rect[2]) * Double(W)).rounded(.up))
        let v0 = Int((min(rect[1], rect[3]) * Double(H)).rounded(.down))
        let v1 = Int((max(rect[1], rect[3]) * Double(H)).rounded(.up))
        guard u1 > u0, v1 > v0 else { return ["error": "rect: empty"] }
        step = DepthMaps.fitStep(u1 - u0, v1 - v0, start: step, maxPixels: 49_152)
        guard let patch = maps.patch(u0: u0, v0: v0, u1: u1, v1: v1, step: step, withPersonDepth: wantPD) else {
            return ["error": "rect: empty"]
        }
        let viewport = view.bounds.size
        var out: [String: Any] = [
            "ok": true,
            "t": frame.timestamp,
            "camera": cameraJSON(transform: frame.camera.transform, intrinsics: frame.camera.intrinsics, imageResolution: frame.camera.imageResolution),
            "display": list(frame.displayTransform(for: .portrait, viewportSize: viewport)),
            "viewport": list(viewport),
            "depthSize": [W, H],
            "rect": patch.rect,
            "step": patch.step,
            "w": patch.w,
            "h": patch.h,
            "depth": patch.depth,
            "info": patch.info,
        ]
        if let pd = patch.personDepth { out["personDepth"] = pd }
        return out
    }

    // MARK: planes (§6)

    /// ar.planes → {ok, planes}
    func planes() -> [String: Any] {
        guard let view = arView, running, let frame = view.session.currentFrame else {
            return ["error": "ar-not-running"]
        }
        return ["ok": true, "planes": planeList(frame.anchors)]
    }

    private func planeList(_ anchors: [ARAnchor]) -> [[String: Any]] {
        anchors.compactMap { $0 as? ARPlaneAnchor }.map { planeJSON($0) }
    }

    /// {id, alignment, class, transform, center, extent, rotationOnYAxis, boundary}; center and
    /// boundary in the plane's own space, the boundary evenly thinned to at most 128 points.
    private func planeJSON(_ plane: ARPlaneAnchor) -> [String: Any] {
        let vertices = plane.geometry.boundaryVertices
        let n = vertices.count
        let take = min(n, 128)
        var boundary: [[Double]] = []
        boundary.reserveCapacity(take)
        for k in 0..<take {
            let v = vertices[take == n ? k : (k * n) / take]
            boundary.append([round5(v.x), round5(v.z)])
        }
        return [
            "id": plane.identifier.uuidString,
            "alignment": plane.alignment == .horizontal ? "horizontal" : "vertical",
            "class": planeClass(plane.classification),
            "transform": list(plane.transform),
            "center": list(plane.center),
            "extent": [round5(plane.planeExtent.width), round5(plane.planeExtent.height)],
            "rotationOnYAxis": round5(plane.planeExtent.rotationOnYAxis),
            "boundary": boundary,
        ]
    }

    // MARK: light (§8)

    /// ar.setLight {on, direction?: [0.3, -1, -0.2] (the way the light travels), intensity?: 2000
    /// lux, shadow?: true, shadowDistance?: 2, color?: [r, g, b]} → {ok}. One directional light.
    func setLight(_ p: [String: Any]) -> [String: Any] {
        guard let origin else { return ["error": "ar-not-started"] }
        logUnknownKeys(p, known: Self.lightKeys, in: "ar.setLight")
        do {
            guard try optionalBool(p, "on") ?? true else {
                removeLight()
                return ["ok": true]
            }
            let direction = try optionalVector(p, "direction") ?? SIMD3<Float>(0.3, -1, -0.2)
            let length = simd_length(direction)
            guard length.isFinite, length > 1e-6 else { throw PayloadError("direction: [x, y, z], not all zero") }
            let intensity = try optionalNumber(p, "intensity") ?? 2000
            let shadow = try optionalBool(p, "shadow") ?? true
            let shadowDistance = try optionalNumber(p, "shadowDistance") ?? 2
            var rgb = SIMD3<Float>(1, 1, 1)
            if let v = given(p, "color") {
                guard let c = vector(v) else { throw PayloadError("color: [r, g, b] 0..1") }
                rgb = c.clamped(lowerBound: .zero, upperBound: .one)
            }

            let created = light == nil
            let hadShadow = light?.shadow != nil
            let entity: DirectionalLight
            if let existing = light {
                entity = existing
            } else {
                entity = DirectionalLight()
                origin.addChild(entity)
                light = entity
            }
            entity.light.intensity = Float(min(max(intensity, 0), 1_000_000))
            entity.light.color = UIColor(red: CGFloat(rgb.x), green: CGFloat(rgb.y), blue: CGFloat(rgb.z), alpha: 1)
            entity.shadow = shadow
                ? DirectionalLightComponent.Shadow(maximumDistance: Float(min(max(shadowDistance, 0.1), 100)), depthBias: 1)
                : nil
            // A directional light shines along its forward axis (−Z); look(at:) points that axis
            // at the target. Straight up or down needs another up vector, or the turn is undefined.
            let d = direction / length
            let up = abs(d.y) > 0.99 ? SIMD3<Float>(0, 0, -1) : SIMD3<Float>(0, 1, 0)
            entity.look(at: d, from: .zero, upVector: up, relativeTo: origin)
            // A page may move the light every frame (e.g. to follow the camera): log only when it
            // appears or its shadow is switched, not each update.
            if created || hadShadow != shadow {
                NativeLog.shared.log("light set", data: [
                    "direction": list(d), "intensity": round3(intensity), "shadow": shadow,
                ])
            }
            return ["ok": true]
        } catch {
            return ["error": errorText(error)]
        }
    }

    private func removeLight() {
        light?.removeFromParent()
        light = nil
    }

    // MARK: ARSessionDelegate
    //
    // ARKit calls these on the main queue (the session's delegateQueue is not set). They are
    // nonisolated only because the protocol is; each one checks it really is the main thread
    // before touching main-thread state, instead of trapping if that ever changed.

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard Thread.isMainThread else { return Self.offMain("didUpdate frame") }
        MainActor.assumeIsolated { self.frameUpdated(frame) }
    }

    nonisolated func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        guard Thread.isMainThread else { return Self.offMain("didAdd anchors") }
        MainActor.assumeIsolated { self.anchorsChanged(anchors) }
    }

    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        guard Thread.isMainThread else { return Self.offMain("didUpdate anchors") }
        MainActor.assumeIsolated {
            self.boxes.anchorsUpdated(anchors)
            self.anchorsChanged(anchors)
        }
    }

    nonisolated func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        guard Thread.isMainThread else { return Self.offMain("didRemove anchors") }
        MainActor.assumeIsolated {
            self.boxes.anchorsRemoved(anchors)
            self.anchorsChanged(anchors)
        }
    }

    nonisolated func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let state = trackingText(camera.trackingState)
        logAnyThread("ar tracking", data: ["state": state])
    }

    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        let ns = error as NSError
        let code = ns.code
        let text = ns.localizedDescription
        logAnyThread("ar session failed", level: "error", data: ["code": code, "domain": ns.domain, "text": text])
        guard Thread.isMainThread else { return Self.offMain("didFailWithError") }
        MainActor.assumeIsolated {
            self.running = false
            self.hands.sessionStopped()
            UIApplication.shared.isIdleTimerDisabled = false
            self.emit?(["type": "ar.error", "code": code, "message": text])
        }
    }

    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        logAnyThread("ar interrupted")
        guard Thread.isMainThread else { return Self.offMain("sessionWasInterrupted") }
        MainActor.assumeIsolated { self.emit?(["type": "ar.interrupted", "interrupted": true]) }
    }

    nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        logAnyThread("ar interruption ended")
        guard Thread.isMainThread else { return Self.offMain("sessionInterruptionEnded") }
        MainActor.assumeIsolated { self.emit?(["type": "ar.interrupted", "interrupted": false]) }
    }

    private nonisolated static func offMain(_ what: String) {
        LogOnce.shared.log("off main \(what)", "ARKit called the delegate off the main thread; call ignored", level: "error", data: ["call": what])
    }

    private func anchorsChanged(_ anchors: [ARAnchor]) {
        if !planesDirty && anchors.contains(where: { $0 is ARPlaneAnchor }) { planesDirty = true }
    }

    private func frameUpdated(_ frame: ARFrame) {
        guard running, let view = arView else { return }
        framesSinceStart += 1
        frameTimes.add(0, at: frame.timestamp)
        if framesSinceStart == 60 {
            // Once per start: what this configuration really delivers on this phone.
            var data: [String: Any] = [
                "sceneDepth": frame.sceneDepth != nil,
                "smoothedSceneDepth": frame.smoothedSceneDepth != nil,
                "personMask": frame.segmentationBuffer != nil,
                "personDepth": frame.estimatedDepthData != nil,
                "image": list(frame.camera.imageResolution),
                "tracking": trackingText(frame.camera.trackingState),
            ]
            if let depth = frame.sceneDepth?.depthMap {
                data["depthSize"] = [CVPixelBufferGetWidth(depth), CVPixelBufferGetHeight(depth)]
                data["depthFormat"] = fourCC(CVPixelBufferGetPixelFormatType(depth))
            }
            if let mask = frame.segmentationBuffer {
                data["personMaskSize"] = [CVPixelBufferGetWidth(mask), CVPixelBufferGetHeight(mask)]
            }
            NativeLog.shared.log("ar frame 60", data: data)
        }
        let viewport = view.bounds.size
        hands.offer(frame, viewport: viewport)

        if planeEvents && planesDirty && frame.timestamp - lastPlanesTime >= planesInterval {
            planesDirty = false
            lastPlanesTime = frame.timestamp
            emit?(["type": "ar.planes", "planes": planeList(frame.anchors)])
        }

        guard frame.timestamp - lastStatusTime >= statusInterval else { return }
        lastStatusTime = frame.timestamp

        var horizontal = 0
        var vertical = 0
        var meshes = 0
        for anchor in frame.anchors {
            if let plane = anchor as? ARPlaneAnchor {
                if plane.alignment == .horizontal { horizontal += 1 } else { vertical += 1 }
            } else if anchor is ARMeshAnchor {
                meshes += 1
            }
        }
        let now = CACurrentMediaTime()
        var status: [String: Any] = [
            "type": "ar.status",
            "t": frame.timestamp,
            "now": now,
            "tracking": trackingText(frame.camera.trackingState),
            "mapping": mappingText(frame.worldMappingStatus),
            "camera": list(frame.camera.transform),
            "projection": list(frame.camera.projectionMatrix(for: .portrait, viewportSize: viewport, zNear: 0.01, zFar: 100)),
            "view": list(frame.camera.viewMatrix(for: .portrait)),
            "viewport": list(viewport),
            "display": list(frame.displayTransform(for: .portrait, viewportSize: viewport)),
            "fps": frameTimes.times.count,
            "thermal": thermalText(ProcessInfo.processInfo.thermalState),
            "planes": ["horizontal": horizontal, "vertical": vertical],
            "meshAnchors": meshes,
            "hasDepth": frame.sceneDepth != nil || frame.smoothedSceneDepth != nil,
            "hands": hands.status(now: now),
            "latency": boxes.latencyStatus(now: now),
            "groups": boxes.anchoredStatus(),
        ]
        if let person = personSummary(frame) {
            status["person"] = person
        }
        if let furniture = boxes.furnitureStatus() {
            status["furniture"] = furniture
        }
        emit?(status)
    }

    /// How much of the picture ARKit sees as a person (the hand), and how far away:
    /// {fraction 0..1, nearest, mean} in metres. nil without person segmentation.
    private func personSummary(_ frame: ARFrame) -> [String: Any]? {
        guard let mask = PixelPlane.lock(frame.segmentationBuffer, name: "personMask", format: kCVPixelFormatType_OneComponent8, bytesPerPixel: 1) else {
            return nil
        }
        defer { mask.unlock() }
        var depth = PixelPlane.lock(frame.estimatedDepthData, name: "personDepth", format: kCVPixelFormatType_DepthFloat32, bytesPerPixel: 4)
        if let d = depth, d.width != mask.width || d.height != mask.height {
            d.unlock()
            depth = nil
        }
        defer { depth?.unlock() }

        var count = 0
        var depthCount = 0
        var sum: Float = 0
        var nearest = Float.greatestFiniteMagnitude
        for y in 0..<mask.height {
            for x in 0..<mask.width where mask.byte(x, y) != 0 {
                count += 1
                if let depth {
                    let d = depth.float(x, y)
                    if d.isFinite && d > 0 {
                        depthCount += 1
                        sum += d
                        nearest = min(nearest, d)
                    }
                }
            }
        }
        var result: [String: Any] = ["fraction": round5(Float(count) / Float(mask.width * mask.height))]
        if depthCount > 0 {
            result["nearest"] = round5(nearest)
            result["mean"] = round5(sum / Float(depthCount))
        }
        return result
    }
}
