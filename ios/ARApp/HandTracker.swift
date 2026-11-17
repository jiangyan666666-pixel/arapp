import ARKit
import CoreVideo
import Foundation
import ImageIO
import QuartzCore
import Vision

// Vision hand pose on the camera frames (docs/protocol.md §4). The native side only finds the
// 21 joints in the picture and reads the LiDAR depth around each one; turning that into a hand
// in world space (sizes, binding, the box model) is the page's work.
//
// Threading: ARKit hands frames to ARController on the main thread. HandTracker (main) decides
// whether a frame is taken – at most `hz` per second and never while one is in flight – copies
// out the buffers and camera numbers it needs (HandFrame; the ARFrame itself is never kept) and
// gives them to HandWorker, which runs Vision and the depth sampling on its own serial queue.
// The finished event comes back to the main thread and goes to the page.

/// The ar.hands config (protocol §4). Every value is checked on the way in, so the worker can
/// use it without further checks.
struct HandsConfig: Equatable {
    var on = false
    var hz: Double = 30
    var maxHands = 2
    var orientation = "right"
    var pointTransform: [Double] = HandsConfig.defaultTransform("right")
    var window = 2
    var minJointConfidence: Double = 0
    var patchEvery = 0
    var patchMargin = 12
    var patchStep = 1
    var patchMax = 6000

    static let known: Set<String> = [
        "on", "hz", "maxHands", "orientation", "pointTransform", "window", "minJointConfidence",
        "patchEvery", "patchMargin", "patchStep", "patchMax",
    ]

    /// Vision's normalized point (vx, vy; origin bottom-left, in the picture turned by the
    /// orientation) → image (x, y) = (a·vx + c·vy + tx, b·vx + d·vy + ty), [a, b, c, d, tx, ty].
    /// "right" comes from the displayTransform measured on this phone: (1 − vy, 1 − vx).
    static func defaultTransform(_ orientation: String) -> [Double] {
        switch orientation {
        case "up": return [1, 0, 0, -1, 0, 1]
        case "left": return [0, 1, 1, 0, 0, 0]
        case "down": return [-1, 0, 0, 1, 1, 0]
        default: return [0, -1, -1, 0, 1, 1]
        }
    }

    var visionOrientation: CGImagePropertyOrientation {
        switch orientation {
        case "up": return .up
        case "left": return .left
        case "down": return .down
        default: return .right
        }
    }

    /// Applies the keys present in `p` (absent or null keys stay as they are; a null
    /// pointTransform goes back to the default for the orientation). A new orientation without
    /// a pointTransform also takes that orientation's default. On any bad value nothing changes.
    mutating func apply(_ p: [String: Any]) throws {
        var c = self
        if let on = try optionalBool(p, "on") { c.on = on }
        if let hz = try optionalNumber(p, "hz") {
            guard hz > 0 else { throw PayloadError("hz: a number > 0") }
            c.hz = min(hz, 60)
        }
        if let v = given(p, "maxHands") {
            guard let n = integer(v), n >= 1 else { throw PayloadError("maxHands: 1 or more") }
            c.maxHands = min(n, 8)
        }
        var newOrientation = false
        if let v = given(p, "orientation") {
            guard let s = v as? String, ["up", "right", "left", "down"].contains(s) else {
                throw PayloadError("orientation: up, right, left or down")
            }
            c.orientation = s
            newOrientation = true
        }
        if p.keys.contains("pointTransform") {
            if let v = given(p, "pointTransform") {
                guard let t = numbers(v, count: 6), t.allSatisfy({ abs($0) <= 100 }) else {
                    throw PayloadError("pointTransform: 6 numbers [a, b, c, d, tx, ty]")
                }
                c.pointTransform = t
            } else {
                c.pointTransform = Self.defaultTransform(c.orientation)
            }
        } else if newOrientation {
            c.pointTransform = Self.defaultTransform(c.orientation)
        }
        if let v = given(p, "window") {
            guard let n = integer(v), n >= 0, n <= 10 else { throw PayloadError("window: 0 to 10") }
            c.window = n
        }
        if let v = try optionalNumber(p, "minJointConfidence") {
            c.minJointConfidence = min(max(v, 0), 1)
        }
        if let v = given(p, "patchEvery") {
            guard let n = integer(v), n >= 0 else { throw PayloadError("patchEvery: 0 or more") }
            c.patchEvery = min(n, 1_000_000)
        }
        if let v = given(p, "patchMargin") {
            guard let n = integer(v), n >= 0 else { throw PayloadError("patchMargin: 0 or more") }
            c.patchMargin = min(n, 256)
        }
        if let v = given(p, "patchStep") {
            guard let n = integer(v), n >= 1 else { throw PayloadError("patchStep: 1 or more") }
            c.patchStep = min(n, 64)
        }
        if let v = given(p, "patchMax") {
            guard let n = integer(v), n >= 1 else { throw PayloadError("patchMax: 1 or more") }
            c.patchMax = min(n, 49_152)
        }
        self = c
    }

    var json: [String: Any] {
        [
            "on": on, "hz": round5(hz), "maxHands": maxHands, "orientation": orientation,
            "pointTransform": pointTransform.map { round5($0) }, "window": window,
            "minJointConfidence": round5(minJointConfidence), "patchEvery": patchEvery,
            "patchMargin": patchMargin, "patchStep": patchStep, "patchMax": patchMax,
        ]
    }
}

/// One camera frame's inputs, copied out of the ARFrame on the main thread. ARKit recycles a
/// small pool of frames, and holding on to one stalls the camera, so only the pixel buffers and
/// the numbers travel to the worker (and at most one frame's worth is in flight).
struct HandFrame: @unchecked Sendable {
    let image: CVPixelBuffer
    let depth: CVPixelBuffer?
    let confidence: CVPixelBuffer?
    let person: CVPixelBuffer?
    let personDepth: CVPixelBuffer?
    let timestamp: TimeInterval
    let transform: simd_float4x4
    let intrinsics: simd_float3x3
    let imageResolution: CGSize
    let display: CGAffineTransform
    let viewport: CGSize

    init(_ frame: ARFrame, viewport: CGSize) {
        let lidar = frame.sceneDepth ?? frame.smoothedSceneDepth
        image = frame.capturedImage
        depth = lidar?.depthMap
        confidence = lidar?.confidenceMap
        person = frame.segmentationBuffer
        personDepth = frame.estimatedDepthData
        timestamp = frame.timestamp
        transform = frame.camera.transform
        intrinsics = frame.camera.intrinsics
        imageResolution = frame.camera.imageResolution
        display = frame.displayTransform(for: .portrait, viewportSize: viewport)
        self.viewport = viewport
    }

    /// The event fields that describe this frame (protocol §4).
    var frameJSON: [String: Any] {
        var depthSize: Any = NSNull()
        if let depth {
            depthSize = [CVPixelBufferGetWidth(depth), CVPixelBufferGetHeight(depth)]
        }
        return [
            "t": timestamp,
            "camera": cameraJSON(transform: transform, intrinsics: intrinsics, imageResolution: imageResolution),
            "display": list(display),
            "viewport": list(viewport),
            "depthSize": depthSize,
        ]
    }
}

/// Vision's answer for one frame plus the depth around each joint, ready for JSON.
struct HandAnalysis: @unchecked Sendable {
    var hands: [[String: Any]] = []
    var patches: [[String: Any]] = []
    var tv0: TimeInterval = 0
    var tv1: TimeInterval = 0
    /// Vision failed on the frame: no event.
    var error: String?
    /// One hand's joints could not be read; the event still goes out without it.
    var warning: String?
}

enum HandPose {
    /// Protocol §4 order: wrist, then thumb, index, middle, ring, little, each from the palm out.
    static let joints: [VNHumanHandPoseObservation.JointName] = [
        .wrist,
        .thumbCMC, .thumbMP, .thumbIP, .thumbTip,
        .indexMCP, .indexPIP, .indexDIP, .indexTip,
        .middleMCP, .middlePIP, .middleDIP, .middleTip,
        .ringMCP, .ringPIP, .ringDIP, .ringTip,
        .littleMCP, .littlePIP, .littleDIP, .littleTip,
    ]

    private static let missing: [Double] = [0, 0, 0, 0, 0, 0, 0, 0, 0]

    /// Runs Vision on the frame and samples the depth maps around each joint. Any thread, but
    /// `request` and `sampler` must be used by one thread at a time.
    static func analyze(_ frame: HandFrame, config: HandsConfig, request: VNDetectHumanHandPoseRequest,
                        patches wantPatches: Bool, sampler: inout JointSampler) -> HandAnalysis {
        var out = HandAnalysis()
        request.maximumHandCount = config.maxHands
        let handler = VNImageRequestHandler(cvPixelBuffer: frame.image, orientation: config.visionOrientation, options: [:])
        out.tv0 = CACurrentMediaTime()
        do {
            try handler.perform([request])
        } catch {
            out.tv1 = CACurrentMediaTime()
            let ns = error as NSError
            out.error = "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
            return out
        }
        out.tv1 = CACurrentMediaTime()
        let observations = request.results ?? []
        guard !observations.isEmpty else { return out }

        let t = config.pointTransform.count == 6 ? config.pointTransform : HandsConfig.defaultTransform(config.orientation)
        let maps = DepthMaps.lock(depth: frame.depth, confidence: frame.confidence, person: frame.person, personDepth: frame.personDepth)
        defer { maps.unlock() }

        for observation in observations {
            let points: [VNHumanHandPoseObservation.JointName: VNRecognizedPoint]
            do {
                points = try observation.recognizedPoints(.all)
            } catch {
                let ns = error as NSError
                out.warning = "recognizedPoints: \(ns.domain) \(ns.code): \(ns.localizedDescription)"
                continue
            }
            let handIndex = out.hands.count
            var joints: [[Double]] = []
            joints.reserveCapacity(Self.joints.count)
            // Bounding box (depth pixels) of the joints Vision is fairly sure of, for the patch.
            var box: (u0: Int, v0: Int, u1: Int, v1: Int)?
            for name in Self.joints {
                guard let point = points[name], point.confidence > 0 else {
                    joints.append(Self.missing)
                    continue
                }
                let vx = Double(point.location.x)
                let vy = Double(point.location.y)
                let x = t[0] * vx + t[2] * vy + t[4]
                let y = t[1] * vx + t[3] * vy + t[5]
                let c = Double(point.confidence)
                if wantPatches, c > 0.1, let depth = maps.depth, let px = DepthMaps.pixel(x, y, depth.width, depth.height) {
                    let u = min(max(px.u, 0), depth.width - 1)
                    let v = min(max(px.v, 0), depth.height - 1)
                    if let b = box {
                        box = (min(b.u0, u), min(b.v0, v), max(b.u1, u), max(b.v1, v))
                    } else {
                        box = (u, v, u, v)
                    }
                }
                guard c >= config.minJointConfidence else {
                    // Still sent with its confidence – the page decides – but not worth a depth window.
                    joints.append([round5(x), round5(y), round5(c), 0, 0, 0, 0, 0, 0])
                    continue
                }
                let s = sampler.sample(maps, x: x, y: y, radius: config.window)
                joints.append([
                    round5(x), round5(y), round5(c),
                    round4(s.dAll), round4(s.dHand), Double(s.nHand), Double(s.nAll), round5(s.hi), round4(s.pd),
                ])
            }
            out.hands.append([
                "chirality": chiralityText(observation.chirality),
                "confidence": round5(Double(observation.confidence)),
                "joints": joints,
            ])
            if wantPatches, let b = box, let depth = maps.depth {
                let m = config.patchMargin
                let u0 = max(0, b.u0 - m), v0 = max(0, b.v0 - m)
                let u1 = min(depth.width, b.u1 + 1 + m), v1 = min(depth.height, b.v1 + 1 + m)
                let step = DepthMaps.fitStep(u1 - u0, v1 - v0, start: config.patchStep, maxPixels: config.patchMax)
                if let patch = maps.patch(u0: u0, v0: v0, u1: u1, v1: v1, step: step, withPersonDepth: false) {
                    out.patches.append([
                        "hand": handIndex, "rect": patch.rect, "step": patch.step, "w": patch.w, "h": patch.h,
                        "depth": patch.depth, "info": patch.info,
                    ])
                }
            }
        }
        return out
    }

    static func chiralityText(_ c: VNChirality) -> String {
        switch c {
        case .left: return "left"
        case .right: return "right"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }
}

/// Runs Vision off the main thread. Everything mutable is touched only on `queue`.
final class HandWorker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "arapp.hands", qos: .userInteractive)
    private var request: VNDetectHumanHandPoseRequest?
    private var sampler = JointSampler()

    /// `done` is called on the worker queue.
    func process(_ frame: HandFrame, config: HandsConfig, patches: Bool, done: @escaping @Sendable (HandAnalysis, [String: Any]) -> Void) {
        queue.async { [self] in
            let request = self.request ?? VNDetectHumanHandPoseRequest()
            self.request = request
            let result = HandPose.analyze(frame, config: config, request: request, patches: patches, sampler: &self.sampler)
            done(result, frame.frameJSON)
        }
    }
}

/// Main-thread side: the config, which frames go to the worker, the events to the page, and the
/// numbers for ar.status.hands.
@MainActor
final class HandTracker {
    /// Sends an event to the page.
    var emit: (([String: Any]) -> Void)?
    private(set) var config = HandsConfig()

    private var sessionRunning = false
    private let worker = HandWorker()
    /// Changes whenever processing starts or stops, so a result that was in flight across a
    /// stop/start is dropped instead of being numbered into the new run.
    private var generation = 0
    private var inFlight = false
    private var inFlightSince: TimeInterval = 0
    private var lastSubmit: TimeInterval = -.infinity
    private var seq = 0
    private var onSince: TimeInterval = 0
    private var processed = 0
    private var busySkips = 0
    private var firstHandLogged = false
    private var recent = RecentValues(span: 1)
    private var lastCount = 0
    private var errorLog = Throttle(every: 10)
    private var warningLog = Throttle(every: 10)
    private var slowLog = Throttle(every: 10)

    /// ar.capture runs Vision on the main thread; it has its own request so it never touches the
    /// worker's.
    private var captureRequest: VNDetectHumanHandPoseRequest?
    private var captureSampler = JointSampler()

    var isProcessing: Bool { config.on && sessionRunning }

    /// ar.hands message → {ok, config, available}.
    func configure(_ p: [String: Any]) -> [String: Any] {
        logUnknownKeys(p, known: HandsConfig.known, in: "ar.hands")
        var next = config
        do {
            try next.apply(p)
        } catch {
            let text = errorText(error)
            NativeLog.shared.log("hands: config refused", level: "warn", data: ["error": text])
            return ["error": text]
        }
        let was = isProcessing
        let changed = next != config
        config = next
        if changed {
            NativeLog.shared.log("hands: config", data: ["config": config.json, "sessionRunning": sessionRunning])
        }
        processingChanged(from: was)
        return ["ok": true, "config": config.json, "available": true]
    }

    /// Checks a config without applying it (ar.start refuses a bad one before starting anything).
    func check(_ p: [String: Any]) -> String? {
        var probe = config
        do {
            try probe.apply(p)
            return nil
        } catch {
            return errorText(error)
        }
    }

    func sessionStarted() {
        let was = isProcessing
        sessionRunning = true
        processingChanged(from: was)
    }

    /// The config is kept; processing resumes on the next start if it is on.
    func sessionStopped() {
        let was = isProcessing
        sessionRunning = false
        processingChanged(from: was)
    }

    private func processingChanged(from was: Bool) {
        let now = isProcessing
        guard now != was else { return }
        generation += 1
        if now {
            seq = 0
            processed = 0
            busySkips = 0
            firstHandLogged = false
            lastSubmit = -.infinity
            onSince = CACurrentMediaTime()
            NativeLog.shared.log("hands: on", data: config.json)
        } else {
            NativeLog.shared.log("hands: off", data: [
                "events": processed, "busySkips": busySkips,
                "seconds": round3(CACurrentMediaTime() - onSince),
            ])
            recent = RecentValues(span: 1)
            lastCount = 0
        }
    }

    /// Every ARKit frame (main thread). Takes it if it is time and the worker is free.
    func offer(_ frame: ARFrame, viewport: CGSize) {
        guard isProcessing else { return }
        let interval = 1 / config.hz
        // Camera frames come every 1/60 s with some jitter: a little slack keeps 30 Hz from
        // turning into 20 Hz when a frame is a millisecond early.
        let slack = min(0.005, interval * 0.25)
        guard frame.timestamp - lastSubmit >= interval - slack else { return }
        if inFlight {
            busySkips += 1
            let now = CACurrentMediaTime()
            if now - inFlightSince > 2, let held = slowLog.pass(now) {
                NativeLog.shared.log("hands: Vision busy for over 2 s", level: "warn", data: ["heldBack": held])
            }
            return
        }
        guard viewport.width > 0, viewport.height > 0 else {
            LogOnce.shared.log("hands viewport", "hands: no viewport size yet, frame skipped")
            return
        }
        let input = HandFrame(frame, viewport: viewport)
        seq += 1
        let job = seq
        if job == 1 {
            // Once per "on": what the worker really gets on this phone with this configuration.
            var data: [String: Any] = [
                "image": [CVPixelBufferGetWidth(input.image), CVPixelBufferGetHeight(input.image)],
                "imageFormat": fourCC(CVPixelBufferGetPixelFormatType(input.image)),
                "depth": input.depth != nil, "confidence": input.confidence != nil,
                "personMask": input.person != nil, "personDepth": input.personDepth != nil,
                "display": list(input.display), "viewport": list(viewport),
            ]
            if let depth = input.depth {
                data["depthSize"] = [CVPixelBufferGetWidth(depth), CVPixelBufferGetHeight(depth)]
            }
            NativeLog.shared.log("hands: first frame", data: data)
        }
        let gen = generation
        let patches = config.patchEvery > 0 && job % config.patchEvery == 0
        inFlight = true
        inFlightSince = CACurrentMediaTime()
        lastSubmit = frame.timestamp
        let window = config.window
        worker.process(input, config: config, patches: patches) { result, frameJSON in
            let delivery = HandDelivery(result: result, frame: frameJSON, seq: job, generation: gen, window: window, patches: patches)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.deliver(delivery) }
            }
        }
    }

    private func deliver(_ d: HandDelivery) {
        inFlight = false
        guard d.generation == generation, isProcessing else { return }
        let now = CACurrentMediaTime()
        let result = d.result
        if let error = result.error {
            if let held = errorLog.pass(now) {
                NativeLog.shared.log("hands: Vision failed", level: "error", data: ["error": error, "heldBack": held])
            }
            return
        }
        if let warning = result.warning, let held = warningLog.pass(now) {
            NativeLog.shared.log("hands: a hand was dropped", level: "warn", data: ["error": warning, "heldBack": held])
        }
        let visionMs = (result.tv1 - result.tv0) * 1000
        processed += 1
        recent.add(visionMs, at: now)
        lastCount = result.hands.count
        if lastCount > 0 && !firstHandLogged {
            firstHandLogged = true
            NativeLog.shared.log("hands: first hand seen", data: [
                "seq": d.seq, "hands": lastCount, "visionMs": round3(visionMs),
                "secondsSinceOn": round3(now - onSince),
                "chirality": result.hands.compactMap { $0["chirality"] },
            ])
        }
        var event = d.frame
        event["type"] = "ar.hands"
        event["seq"] = d.seq
        event["tv0"] = result.tv0
        event["tv1"] = result.tv1
        event["window"] = d.window
        event["hands"] = result.hands
        if d.patches { event["patches"] = result.patches }
        event["tSent"] = CACurrentMediaTime()
        emit?(event)
    }

    /// ar.status.hands: {on, rate (events/s), visionMs: [mean, max], hands (in the last event)}.
    func status(now: TimeInterval) -> [String: Any] {
        recent.prune(now)
        let ms = recent.values
        let mean = ms.isEmpty ? 0 : ms.reduce(0, +) / Double(ms.count)
        let top = ms.max() ?? 0
        return [
            "on": config.on,
            "rate": round3(Double(ms.count) / recent.span),
            "visionMs": [round3(mean), round3(top)],
            "hands": lastCount,
        ]
    }

    /// ar.capture's hands: Vision run synchronously on this frame, same format as the events.
    func capture(_ frame: ARFrame, viewport: CGSize) -> [String: Any] {
        let request = captureRequest ?? VNDetectHumanHandPoseRequest()
        captureRequest = request
        let input = HandFrame(frame, viewport: viewport)
        let result = HandPose.analyze(input, config: config, request: request, patches: false, sampler: &captureSampler)
        if let error = result.error {
            NativeLog.shared.log("hands: Vision failed on capture", level: "error", data: ["error": error])
            return ["hands": [] as [Any], "handsError": error]
        }
        return ["hands": result.hands, "handsVisionMs": round3((result.tv1 - result.tv0) * 1000)]
    }
}

/// A finished frame on its way back to the main thread.
private struct HandDelivery: @unchecked Sendable {
    let result: HandAnalysis
    let frame: [String: Any]
    let seq: Int
    let generation: Int
    let window: Int
    let patches: Bool
}
