import ARKit
import AVFoundation
import CoreImage
import ImageIO
import RealityKit
import UIKit

// The native AR layer under the transparent web page: camera, world tracking, LiDAR, occlusion,
// and the furniture. It is deliberately thin and has no logic of its own – the page decides
// everything (where the furniture goes, which options are on) and tells it through messages
// (WebView.swift routes "ar.*" here; web/src/ar.js is the other end):
//
//   ar.start {…options}        → runs the session (asks for camera permission the first time)
//   ar.stop
//   ar.setOptions {…options}   → occlusion switches, render and debug options
//   ar.raycast {x, y, allowing, alignment}   x, y in 0..1 of the screen → hits in world space
//   ar.setFurniture {boxes, position, yaw, shadow}   boxes from web/src/furniture-spec.js
//   ar.moveFurniture {position, yaw}
//   ar.clearFurniture
//   ar.capture {…what to include}   → one frame: LiDAR depth, camera pose, image, mesh
//   ar.state
// and it sends "ar.status" events a few times a second (camera pose, tracking, what ARKit sees).
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

    private var arView: ARView?
    private var origin: AnchorEntity?
    private var running = false

    private var furniture: Entity?
    private var furnitureAnchor: ARAnchor?
    private var followAnchor = true
    private var anchorUpdates = 0
    private var anchorShift: Float = 0

    private var statusInterval: TimeInterval = 0.25
    private var lastStatusTime: TimeInterval = 0
    private var framesSinceStart = 0
    private var started: [String: Any] = [:]
    private lazy var ciContext = CIContext()

    override init() {
        container = UIView()
        container.backgroundColor = .black
        container.isUserInteractionEnabled = false
        super.init()
    }

    // MARK: session

    func start(_ options: [String: Any]) async -> [String: Any] {
        NativeLog.shared.log("ar start: requested")
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
        apply(options)

        var runOptions: ARSession.RunOptions = []
        if flag(options, "reset", true) {
            runOptions = [.resetTracking, .removeExistingAnchors, .resetSceneReconstruction]
            removeFurniture()
        }
        started = [
            "ok": true,
            "support": support,
            "frameSemantics": used,
            "skippedSemantics": skipped,
            "sceneReconstruction": meshOn,
            "viewport": [Double(view.bounds.width), Double(view.bounds.height)],
        ]
        NativeLog.shared.log("ar start: running the session", data: started)
        framesSinceStart = 0
        lastStatusTime = 0
        view.session.run(config, options: runOptions)
        running = true
        UIApplication.shared.isIdleTimerDisabled = true
        NativeLog.shared.log("ar start: session.run returned")
        return started
    }

    func stop() -> [String: Any] {
        guard let view = arView, running else { return ["ok": true, "wasRunning": false] }
        view.session.pause()
        running = false
        removeFurniture()
        view.isHidden = true
        UIApplication.shared.isIdleTimerDisabled = false
        NativeLog.shared.log("ar stopped")
        return ["ok": true, "wasRunning": true]
    }

    func setOptions(_ options: [String: Any]) -> [String: Any] {
        guard arView != nil else { return ["error": "ar-not-started"] }
        apply(options)
        return state()
    }

    func state() -> [String: Any] {
        guard let view = arView else { return ["ok": true, "running": false] }
        var result = started
        result["running"] = running
        result["meshOcclusion"] = view.environment.sceneUnderstanding.options.contains(.occlusion)
        result["personOcclusion"] = !view.renderOptions.contains(.disablePersonOcclusion)
        result["hasFurniture"] = furniture != nil
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
        view.session.delegate = self
        arView = view
        return view
    }

    /// The options that can change while the session runs. Keys that are absent stay as they are.
    private func apply(_ options: [String: Any]) {
        guard let view = arView else { return }
        // Real objects (the LiDAR mesh) hide the furniture behind them.
        if let on = options["meshOcclusion"] as? Bool {
            if on {
                view.environment.sceneUnderstanding.options.insert(.occlusion)
            } else {
                view.environment.sceneUnderstanding.options.remove(.occlusion)
            }
        }
        // People (the hand) hide the furniture behind them.
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
            followAnchor = follow
        }
    }

    // MARK: raycast

    func raycast(_ p: [String: Any]) -> [String: Any] {
        guard let view = arView, running else { return ["error": "ar-not-running"] }
        let x = number(p["x"]) ?? 0.5
        let y = number(p["y"]) ?? 0.5
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

    // MARK: furniture

    /// boxes: [{size: [w, h, d], position: [x, y, z], color: [r, g, b] 0..1 sRGB, roughness}],
    /// in the furniture's own space (origin bottom centre, front +Z). Then position + yaw in world.
    func setFurniture(_ p: [String: Any]) -> [String: Any] {
        guard arView != nil, let origin = origin else { return ["error": "ar-not-started"] }
        guard let boxes = p["boxes"] as? [[String: Any]], !boxes.isEmpty, boxes.count <= 200 else {
            return ["error": "bad-boxes"]
        }
        let shadow = flag(p, "shadow", true)
        let root = Entity()
        for box in boxes {
            guard let size = vector(box["size"]), let position = vector(box["position"]),
                  size.x > 0, size.y > 0, size.z > 0 else {
                return ["error": "bad-box"]
            }
            let rgb = vector(box["color"]) ?? SIMD3<Float>(0.7, 0.55, 0.4)
            let color = UIColor(red: CGFloat(rgb.x), green: CGFloat(rgb.y), blue: CGFloat(rgb.z), alpha: 1)
            let roughness = Float(number(box["roughness"]) ?? 0.8)
            let material = SimpleMaterial(color: color, roughness: .float(roughness), isMetallic: false)
            let mesh = MeshResource.generateBox(width: size.x, height: size.y, depth: size.z)
            let entity = ModelEntity(mesh: mesh, materials: [material])
            entity.position = position
            if shadow {
                entity.components.set(GroundingShadowComponent(castsShadow: true))
            }
            root.addChild(entity)
        }
        removeFurniture()
        origin.addChild(root)
        furniture = root
        return moveFurniture(p)
    }

    func moveFurniture(_ p: [String: Any]) -> [String: Any] {
        guard let view = arView, let root = furniture else { return ["error": "no-furniture"] }
        guard let position = vector(p["position"]) else { return ["error": "bad-position"] }
        let yaw = Float(number(p["yaw"]) ?? 0)
        let transform = Transform(scale: .one, rotation: simd_quatf(angle: yaw, axis: SIMD3<Float>(0, 1, 0)), translation: position)
        root.transform = transform
        // An ARKit anchor at the same pose: when ARKit corrects its map, the anchor moves with
        // the real surroundings, and the furniture follows it (session(_:didUpdate anchors:)).
        if let old = furnitureAnchor { view.session.remove(anchor: old) }
        let anchor = ARAnchor(name: "furniture", transform: transform.matrix)
        view.session.add(anchor: anchor)
        furnitureAnchor = anchor
        anchorUpdates = 0
        anchorShift = 0
        return ["ok": true]
    }

    func clearFurniture() -> [String: Any] {
        removeFurniture()
        return ["ok": true]
    }

    private func removeFurniture() {
        furniture?.removeFromParent()
        furniture = nil
        if let anchor = furnitureAnchor {
            arView?.session.remove(anchor: anchor)
        }
        furnitureAnchor = nil
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
                "imageResolution": [Double(camera.imageResolution.width), Double(camera.imageResolution.height)],
                "viewport": [Double(viewport.width), Double(viewport.height)],
                "projectionPortrait": list(camera.projectionMatrix(for: .portrait, viewportSize: viewport, zNear: 0.01, zFar: 100)),
                "viewMatrixPortrait": list(camera.viewMatrix(for: .portrait)),
                "displayTransform": [Double(display.a), Double(display.b), Double(display.c), Double(display.d), Double(display.tx), Double(display.ty)],
            ],
        ]
        if let root = furniture {
            // pose only – never the size (blind test)
            out["furniture"] = ["position": list(root.position), "transform": list(root.transform.matrix)]
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
            let maxWidth = number(p["imageMaxWidth"]) ?? 960
            let image = CIImage(cvPixelBuffer: frame.capturedImage)
            let scale = min(1, maxWidth / Double(image.extent.width))
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

        var planes: [[String: Any]] = []
        var meshes: [[String: Any]] = []
        let wantMesh = flag(p, "mesh", false)
        let radius = Float(number(p["meshRadius"]) ?? 4)
        let eye = camera.transform.columns.3
        for anchor in frame.anchors {
            if let plane = anchor as? ARPlaneAnchor {
                planes.append([
                    "alignment": plane.alignment == .horizontal ? "horizontal" : "vertical",
                    "class": planeClass(plane.classification),
                    "transform": list(plane.transform),
                    "center": list(plane.center),
                    "extent": [round5(plane.planeExtent.width), round5(plane.planeExtent.height)],
                    "rotationOnYAxis": round5(plane.planeExtent.rotationOnYAxis),
                ])
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
        ])
        return out
    }

    /// A single-plane pixel buffer as {width, height, format, bytesPerPixel, base64}, rows packed.
    private func encode(_ buffer: CVPixelBuffer) -> [String: Any] {
        let format = CVPixelBufferGetPixelFormatType(buffer)
        let name = fourCC(format)
        if CVPixelBufferIsPlanar(buffer) { return ["error": "planar pixel buffer", "format": name] }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
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

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard running, let view = arView else { return }
        framesSinceStart += 1
        if framesSinceStart == 60 {
            // Once per start: what this configuration really delivers on this phone.
            var data: [String: Any] = [
                "sceneDepth": frame.sceneDepth != nil,
                "smoothedSceneDepth": frame.smoothedSceneDepth != nil,
                "personMask": frame.segmentationBuffer != nil,
                "personDepth": frame.estimatedDepthData != nil,
                "image": [Double(frame.camera.imageResolution.width), Double(frame.camera.imageResolution.height)],
                "tracking": trackingText(frame.camera.trackingState),
            ]
            if let depth = frame.sceneDepth?.depthMap {
                data["depthSize"] = [CVPixelBufferGetWidth(depth), CVPixelBufferGetHeight(depth)]
            }
            NativeLog.shared.log("ar frame 60", data: data)
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
        var status: [String: Any] = [
            "type": "ar.status",
            "t": frame.timestamp,
            "tracking": trackingText(frame.camera.trackingState),
            "mapping": mappingText(frame.worldMappingStatus),
            "camera": list(frame.camera.transform),
            "projection": list(frame.camera.projectionMatrix(for: .portrait, viewportSize: view.bounds.size, zNear: 0.01, zFar: 100)),
            "view": list(frame.camera.viewMatrix(for: .portrait)),
            "planes": ["horizontal": horizontal, "vertical": vertical],
            "meshAnchors": meshes,
            "hasDepth": frame.sceneDepth != nil || frame.smoothedSceneDepth != nil,
        ]
        if let person = personSummary(frame) {
            status["person"] = person
        }
        if let root = furniture {
            status["furniture"] = [
                "transform": list(root.transform.matrix),
                "anchorUpdates": anchorUpdates,
                "anchorShift": round5(anchorShift),
            ]
        }
        emit?(status)
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        guard followAnchor, let mine = furnitureAnchor, let root = furniture else { return }
        for anchor in anchors where anchor.identifier == mine.identifier {
            let before = root.position
            root.transform = Transform(matrix: anchor.transform)
            anchorShift += simd_distance(before, root.position)
            anchorUpdates += 1
        }
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        NativeLog.shared.log("ar tracking", data: ["state": trackingText(camera.trackingState)])
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        let ns = error as NSError
        NativeLog.shared.log("ar session failed", level: "error", data: ["code": ns.code, "domain": ns.domain, "text": ns.localizedDescription])
        running = false
        UIApplication.shared.isIdleTimerDisabled = false
        emit?(["type": "ar.error", "code": ns.code, "message": ns.localizedDescription])
    }

    func sessionWasInterrupted(_ session: ARSession) {
        NativeLog.shared.log("ar interrupted")
        emit?(["type": "ar.interrupted", "interrupted": true])
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        NativeLog.shared.log("ar interruption ended")
        emit?(["type": "ar.interrupted", "interrupted": false])
    }

    /// How much of the picture ARKit sees as a person (the hand), and how far away:
    /// {fraction 0..1, nearest, mean} in metres. nil without person segmentation.
    private func personSummary(_ frame: ARFrame) -> [String: Any]? {
        guard let mask = frame.segmentationBuffer,
              CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent8 else { return nil }
        CVPixelBufferLockBaseAddress(mask, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
        let width = CVPixelBufferGetWidth(mask)
        let height = CVPixelBufferGetHeight(mask)
        let maskRow = CVPixelBufferGetBytesPerRow(mask)
        guard width > 0, height > 0, let maskBase = CVPixelBufferGetBaseAddress(mask) else { return nil }

        var depthBase: UnsafeMutableRawPointer?
        var depthRow = 0
        let depth = frame.estimatedDepthData
        if let depth,
           CVPixelBufferGetPixelFormatType(depth) == kCVPixelFormatType_DepthFloat32,
           CVPixelBufferGetWidth(depth) == width, CVPixelBufferGetHeight(depth) == height {
            CVPixelBufferLockBaseAddress(depth, .readOnly)
            depthBase = CVPixelBufferGetBaseAddress(depth)
            depthRow = CVPixelBufferGetBytesPerRow(depth)
        }
        defer {
            if depthBase != nil, let depth { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
        }

        var count = 0
        var depthCount = 0
        var sum: Float = 0
        var nearest = Float.greatestFiniteMagnitude
        for y in 0..<height {
            let maskLine = maskBase.advanced(by: y * maskRow).assumingMemoryBound(to: UInt8.self)
            let depthLine = depthBase?.advanced(by: y * depthRow).assumingMemoryBound(to: Float32.self)
            for x in 0..<width where maskLine[x] != 0 {
                count += 1
                if let depthLine {
                    let d = depthLine[x]
                    if d.isFinite && d > 0 {
                        depthCount += 1
                        sum += d
                        nearest = min(nearest, d)
                    }
                }
            }
        }
        var result: [String: Any] = ["fraction": round5(Float(count) / Float(width * height))]
        if depthCount > 0 {
            result["nearest"] = round5(nearest)
            result["mean"] = round5(sum / Float(depthCount))
        }
        return result
    }
}

// MARK: - small helpers

private func flag(_ options: [String: Any], _ key: String, _ fallback: Bool) -> Bool {
    (options[key] as? Bool) ?? fallback
}

private func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber else { return nil }
    let d = n.doubleValue
    return d.isFinite ? d : nil
}

private func vector(_ value: Any?) -> SIMD3<Float>? {
    guard let a = value as? [Any], a.count == 3,
          let x = number(a[0]), let y = number(a[1]), let z = number(a[2]) else { return nil }
    return SIMD3<Float>(Float(x), Float(y), Float(z))
}

/// JSON cannot hold NaN or infinity, and 5 decimals (0.01 mm) is plenty.
private func round5(_ v: Float) -> Double {
    v.isFinite ? (Double(v) * 100_000).rounded() / 100_000 : 0
}

private func list(_ v: SIMD3<Float>) -> [Double] {
    [round5(v.x), round5(v.y), round5(v.z)]
}

private func list(_ v: SIMD4<Float>) -> [Double] {
    [round5(v.x), round5(v.y), round5(v.z)]
}

private func list(_ m: simd_float4x4) -> [Double] {
    [m.columns.0, m.columns.1, m.columns.2, m.columns.3].flatMap { [round5($0.x), round5($0.y), round5($0.z), round5($0.w)] }
}

private func list(_ m: simd_float3x3) -> [Double] {
    [m.columns.0, m.columns.1, m.columns.2].flatMap { [round5($0.x), round5($0.y), round5($0.z)] }
}

private func trackingText(_ state: ARCamera.TrackingState) -> String {
    switch state {
    case .normal: return "normal"
    case .notAvailable: return "notAvailable"
    case .limited(let reason):
        switch reason {
        case .initializing: return "initializing"
        case .excessiveMotion: return "excessiveMotion"
        case .insufficientFeatures: return "insufficientFeatures"
        case .relocalizing: return "relocalizing"
        @unknown default: return "limited"
        }
    }
}

private func mappingText(_ status: ARFrame.WorldMappingStatus) -> String {
    switch status {
    case .notAvailable: return "notAvailable"
    case .limited: return "limited"
    case .extending: return "extending"
    case .mapped: return "mapped"
    @unknown default: return "unknown"
    }
}

private func planeClass(_ c: ARPlaneAnchor.Classification) -> String {
    switch c {
    case .wall: return "wall"
    case .floor: return "floor"
    case .ceiling: return "ceiling"
    case .table: return "table"
    case .seat: return "seat"
    case .window: return "window"
    case .door: return "door"
    default: return "none"
    }
}

private func fourCC(_ code: OSType) -> String {
    let bytes = [UInt8((code >> 24) & 255), UInt8((code >> 16) & 255), UInt8((code >> 8) & 255), UInt8(code & 255)]
    return String(bytes: bytes, encoding: .ascii) ?? "\(code)"
}
