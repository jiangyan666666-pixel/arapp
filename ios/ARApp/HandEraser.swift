import ARKit
import CoreVideo
import Metal
import RealityKit
import UIKit

// Stage 3, "the hand as a model", layer 2: erases the person (the real hand) from the camera
// picture, so only the hand model the page draws is seen. Shaders: HandEraser.metal.
//
// RealityKit renders the virtual content; then a post-process (ARView.renderCallbacks.postProcess)
// draws the picture itself: the camera image, where the person mask is (dilated, soft edge)
// filled from the pixels around it (pull-push over a mip pyramid of the known pixels: coarse
// levels fill the holes), and the virtual content on top. How virtual content is told apart from
// the camera ("mask"):
//   'alpha'  RealityKit draws on a clear background (environment.background = .color(.clear)):
//            the source's alpha is the virtual coverage; out = src + (1 − a) · picture.
//   'depth'  RealityKit draws its camera picture as usual and a pixel whose depth is not the clear
//            value is virtual. The LiDAR occlusion mesh writes depth too, so meshOcclusion must be
//            off for this one.
// The page switches person occlusion off while erasing (the real hand is no longer in the
// picture, so it must not hide anything either).
//
// All of it is set from the page: ar.setOptions {erase: {on, mask, dilate, feather, maxDepth,
// strength, view, srcSpace, dstSpace, depthClear, probe}} (docs/protocol.md §2). `probe: true`
// measures one frame (alpha and depth of the source, its colour against our camera image) and
// sends it as an "ar.erase" event and a log line, with the texture formats: what the PC needs to
// know which mask works on this phone.
//
// Threads: the configuration is set on the main thread; the render callback reads a copy under a
// lock. Everything GPU-side is touched only inside the callback.

struct EraseConfig: Equatable {
    var on = false
    var mask = "alpha"
    /// Person-mask pixels (the mask is 256 × 192 over the whole camera image).
    var dilate = 3
    var feather = 2
    /// Metres; person pixels farther than this are kept. 0 = all of them.
    var maxDepth: Double = 0
    /// 1 = fully erased; less lets the real hand show through.
    var strength: Double = 1
    var view = "normal"
    /// How the source / target hold colour: 'auto' (by pixel format), 'linear' or 'gamma'.
    var srcSpace = "auto"
    var dstSpace = "auto"
    /// The source depth's value where nothing was drawn ('depth' mask; reverse Z → 0).
    var depthClear: Double = 0

    static let known: Set<String> = [
        "on", "mask", "dilate", "feather", "maxDepth", "strength", "view", "srcSpace", "dstSpace",
        "depthClear", "probe",
    ]
    static let views = ["normal", "mask", "coverage", "camera", "source", "split"]
    static let spaces = ["auto", "linear", "gamma"]

    /// Applies the keys present (absent or null ones stay); on a bad value nothing changes.
    mutating func apply(_ p: [String: Any]) throws {
        var c = self
        if let on = try optionalBool(p, "on") { c.on = on }
        if let s = try optionalString(p, "mask") {
            guard ["alpha", "depth"].contains(s) else { throw PayloadError("mask: alpha or depth") }
            c.mask = s
        }
        if let v = given(p, "dilate") {
            guard let n = integer(v), n >= 0, n <= 16 else { throw PayloadError("dilate: 0 to 16") }
            c.dilate = n
        }
        if let v = given(p, "feather") {
            guard let n = integer(v), n >= 0, n <= 8 else { throw PayloadError("feather: 0 to 8") }
            c.feather = n
        }
        if let v = try optionalNumber(p, "maxDepth") {
            guard v >= 0 else { throw PayloadError("maxDepth: 0 or more (metres)") }
            c.maxDepth = min(v, 100)
        }
        if let v = try optionalNumber(p, "strength") { c.strength = min(max(v, 0), 1) }
        if let s = try optionalString(p, "view") {
            guard Self.views.contains(s) else { throw PayloadError("view: \(Self.views.joined(separator: ", "))") }
            c.view = s
        }
        if let s = try optionalString(p, "srcSpace") {
            guard Self.spaces.contains(s) else { throw PayloadError("srcSpace: auto, linear or gamma") }
            c.srcSpace = s
        }
        if let s = try optionalString(p, "dstSpace") {
            guard Self.spaces.contains(s) else { throw PayloadError("dstSpace: auto, linear or gamma") }
            c.dstSpace = s
        }
        if let v = try optionalNumber(p, "depthClear") {
            guard v == 0 || v == 1 else { throw PayloadError("depthClear: 0 or 1") }
            c.depthClear = v
        }
        _ = try optionalBool(p, "probe")
        self = c
    }

    var json: [String: Any] {
        [
            "on": on, "mask": mask, "dilate": dilate, "feather": feather, "maxDepth": round5(maxDepth),
            "strength": round5(strength), "view": view, "srcSpace": srcSpace, "dstSpace": dstSpace,
            "depthClear": depthClear,
        ]
    }
}

/// The same layout as EraseParams in HandEraser.metal.
private struct EraseParams {
    var viewToImage0 = SIMD4<Float>(repeating: 0)
    var viewToImage1 = SIMD4<Float>(repeating: 0)
    var mask = SIMD4<Float>(repeating: 0)
    var misc = SIMD4<Float>(repeating: 0)
    var modes = SIMD4<Int32>(repeating: 0)
    var has = SIMD4<Int32>(repeating: 0)
}

private struct EraseFailure: Error {
    let text: String
    init(_ text: String) { self.text = text }
}

final class HandEraser: @unchecked Sendable {
    /// Sends an event to the page; called on the main thread.
    var emit: (([String: Any]) -> Void)?

    private let lock = NSLock()
    private var config = EraseConfig()
    private var probeWanted = false
    private var probeSeq = 0
    private var stats: [String: Any] = [:]

    // main thread
    private var attached = false

    // render callback only
    private var device: MTLDevice?
    private var setupError: String?
    private var cache: CVMetalTextureCache?
    private var dilatePipeline: MTLComputePipelineState?
    private var featherPipeline: MTLComputePipelineState?
    private var fillPipeline: MTLComputePipelineState?
    private var probeDepthPipeline: MTLComputePipelineState?
    private var probeColourPipeline: MTLComputePipelineState?
    private var kernelAlpha: MTLComputePipelineState?
    private var kernelDepth: MTLComputePipelineState?
    private var library: MTLLibrary?
    private var renderPipelines: [String: MTLRenderPipelineState] = [:]
    private var dilated: MTLTexture?
    private var feathered: MTLTexture?
    private var fill: MTLTexture?
    private var personRing: [MTLTexture?] = Array(repeating: nil, count: 4)
    private var depthRing: [MTLTexture?] = Array(repeating: nil, count: 4)
    private var ring = 0
    private var zeroMask: MTLTexture?
    private var zeroDepth: MTLTexture?
    private var zeroFill: MTLTexture?
    private var frames = 0
    private var failures = 0
    private var described = false
    private var lastFailure = ""

    // MARK: main thread

    /// ar.start / ar.setOptions {erase: {...}}: nil, or why it was refused (then nothing changed).
    @MainActor
    func check(_ p: [String: Any]) -> String? {
        var probe = currentConfig
        do {
            try probe.apply(p)
            return nil
        } catch {
            return "erase: \(errorText(error))"
        }
    }

    @MainActor
    func configure(_ p: [String: Any], view: ARView) -> String? {
        logUnknownKeys(p, known: EraseConfig.known, in: "erase")
        var next = currentConfig
        do {
            try next.apply(p)
        } catch {
            return "erase: \(errorText(error))"
        }
        let changed = next != currentConfig
        lock.lock()
        config = next
        if (p["probe"] as? Bool) == true { probeWanted = true }
        lock.unlock()
        attach(view, next)
        if changed {
            NativeLog.shared.log("erase: config", data: ["config": next.json])
        }
        return nil
    }

    /// A new page: erasing off.
    @MainActor
    func reset(_ view: ARView?) {
        lock.lock()
        let wasOn = config.on
        config = EraseConfig()
        probeWanted = false
        lock.unlock()
        if let view { attach(view, EraseConfig()) }
        if wasOn { NativeLog.shared.log("erase: off (new page)") }
    }

    @MainActor
    var currentConfig: EraseConfig {
        lock.lock()
        defer { lock.unlock() }
        return config
    }

    @MainActor
    var json: [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        var out = config.json
        for (k, v) in stats { out[k] = v }
        // what RealityKit draws under the virtual content now
        out["background"] = attached && config.mask == "alpha" ? "clear" : "camera"
        out["attached"] = attached
        return out
    }

    @MainActor
    private func attach(_ view: ARView, _ c: EraseConfig) {
        if c.on {
            if !attached {
                view.renderCallbacks.postProcess = Self.callback(self, view.session)
                attached = true
            }
            // 'alpha' needs RealityKit to draw on a clear background; 'depth' keeps its camera
            view.environment.background = c.mask == "alpha" ? .color(.clear) : .cameraFeed()
        } else if attached {
            view.renderCallbacks.postProcess = nil
            view.environment.background = .cameraFeed()
            attached = false
        }
    }

    // MARK: render callback

    /// Made outside the main actor, so the closure is not main-actor isolated: RealityKit may call
    /// it on its render thread (the first "erase: textures" log line says which).
    private static func callback(_ eraser: HandEraser, _ session: ARSession) -> (ARView.PostProcessContext) -> Void {
        { context in eraser.render(context, frame: session.currentFrame) }
    }

    private func render(_ context: ARView.PostProcessContext, frame: ARFrame?) {
        lock.lock()
        let c = config
        let probe = probeWanted
        probeWanted = false
        lock.unlock()
        do {
            try setUp(context.device)
            guard let frame else { throw EraseFailure("no camera frame yet") }
            if !described {
                described = true
                logAnyThread("erase: textures", data: describe(context))
            }
            try draw(context, frame: frame, config: c, probe: probe)
            frames += 1
            if frames % 120 == 1 { publishStats() }
        } catch {
            failures += 1
            let text = (error as? EraseFailure)?.text ?? String(describing: error)
            if text != lastFailure || failures % 300 == 1 {
                lastFailure = text
                logAnyThread("erase: frame failed, showing RealityKit's picture", level: "warn", data: ["error": text, "failures": failures])
            }
            publishStats()
            passThrough(context)
        }
    }

    private func publishStats() {
        lock.lock()
        stats = ["frames": frames, "failures": failures, "lastFailure": lastFailure]
        lock.unlock()
    }

    private func setUp(_ device: MTLDevice) throws {
        if self.device === device {
            if let setupError { throw EraseFailure(setupError) }
            return
        }
        self.device = device
        renderPipelines = [:]
        dilated = nil
        feathered = nil
        fill = nil
        personRing = Array(repeating: nil, count: personRing.count)
        depthRing = Array(repeating: nil, count: depthRing.count)
        do {
            guard let library = device.makeDefaultLibrary() else { throw EraseFailure("no Metal library in the app") }
            self.library = library
            func kernel(_ name: String) throws -> MTLComputePipelineState {
                guard let f = library.makeFunction(name: name) else { throw EraseFailure("no Metal function \(name)") }
                return try device.makeComputePipelineState(function: f)
            }
            dilatePipeline = try kernel("eraseDilate")
            featherPipeline = try kernel("eraseFeather")
            fillPipeline = try kernel("eraseFillBase")
            probeDepthPipeline = try kernel("eraseProbeDepth")
            probeColourPipeline = try kernel("eraseProbeColour")
            kernelAlpha = try kernel("eraseKernelAlpha")
            kernelDepth = try kernel("eraseKernelDepth")
            var made: CVMetalTextureCache?
            guard CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &made) == kCVReturnSuccess, let made else {
                throw EraseFailure("no CVMetalTextureCache")
            }
            cache = made
            zeroMask = try texture(device, .r16Float, 1, 1, write: false)
            zeroDepth = try texture(device, .r32Float, 1, 1, write: false)
            zeroFill = try texture(device, .rgba16Float, 1, 1, write: false)
            var zeros = [UInt8](repeating: 0, count: 16)
            for t in [zeroMask, zeroDepth, zeroFill] {
                guard let t else { continue }
                zeros.withUnsafeMutableBytes { raw in
                    t.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: raw.baseAddress!, bytesPerRow: 16)
                }
            }
            setupError = nil
            logAnyThread("erase: ready", data: ["gpu": device.name])
        } catch {
            let text = (error as? EraseFailure)?.text ?? String(describing: error)
            setupError = text
            logAnyThread("erase: set-up failed", level: "error", data: ["error": text])
            throw EraseFailure(text)
        }
    }

    private func texture(_ device: MTLDevice, _ format: MTLPixelFormat, _ w: Int, _ h: Int, write: Bool, mipmapped: Bool = false) throws -> MTLTexture {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: w, height: h, mipmapped: mipmapped)
        d.usage = write ? [.shaderRead, .shaderWrite, .renderTarget] : [.shaderRead]
        d.storageMode = write ? .private : .shared
        guard let t = device.makeTexture(descriptor: d) else { throw EraseFailure("could not make a \(w)×\(h) texture") }
        return t
    }

    private func draw(_ context: ARView.PostProcessContext, frame: ARFrame, config c: EraseConfig, probe: Bool) throws {
        guard let device, let cache, let dilatePipeline, let featherPipeline, let fillPipeline,
              let zeroMask, let zeroDepth, let zeroFill else { throw EraseFailure("not set up") }
        let source = context.sourceColorTexture
        let target = context.targetColorTexture
        let cb = context.commandBuffer
        let depthMode = c.mask == "depth"

        // the camera image (Y and CbCr planes, no copy)
        let image = frame.capturedImage
        guard CVPixelBufferGetPlaneCount(image) >= 2 else { throw EraseFailure("camera image is not two-plane YCbCr") }
        let (yTex, yRef) = try planeTexture(cache, image, plane: 0, format: .r8Unorm)
        let (cTex, cRef) = try planeTexture(cache, image, plane: 1, format: .rg8Unorm)

        // the person mask and its depth (small: copied into a ring of textures)
        ring = (ring + 1) % personRing.count
        var person: MTLTexture?
        var personDepth: MTLTexture?
        if c.strength > 0, let seg = frame.segmentationBuffer {
            person = try upload(device, seg, into: &personRing, format: .r8Unorm, cvFormat: kCVPixelFormatType_OneComponent8, bytesPerPixel: 1)
            if person != nil, c.maxDepth > 0, let pd = frame.estimatedDepthData {
                personDepth = try upload(device, pd, into: &depthRing, format: .r32Float, cvFormat: kCVPixelFormatType_DepthFloat32, bytesPerPixel: 4)
            }
        }

        // where the picture's pixels are in the camera image
        let viewport = CGSize(width: target.width, height: target.height)
        let toImage = frame.displayTransform(for: .portrait, viewportSize: viewport).inverted()
        var params = EraseParams()
        params.viewToImage0 = SIMD4<Float>(Float(toImage.a), Float(toImage.c), Float(toImage.tx), 0)
        params.viewToImage1 = SIMD4<Float>(Float(toImage.b), Float(toImage.d), Float(toImage.ty), 0)
        params.mask = SIMD4<Float>(Float(c.dilate), Float(c.feather), Float(c.maxDepth), Float(c.strength))
        params.modes = SIMD4<Int32>(
            Int32(EraseConfig.views.firstIndex(of: c.view) ?? 0),
            depthMode ? 1 : 0,
            Self.isLinear(source.pixelFormat, c.srcSpace) ? 1 : 0,
            Self.isLinear(target.pixelFormat, c.dstSpace) ? 1 : 0
        )
        params.has = SIMD4<Int32>(person != nil ? 1 : 0, personDepth != nil ? 1 : 0, 0, 0)

        let depthTexture = context.sourceDepthTexture
        let depthUsable = depthTexture.textureType == .type2D && Self.isDepthFormat(depthTexture.pixelFormat)
        if depthMode && !depthUsable {
            throw EraseFailure("the depth texture cannot be read (\(depthTexture.textureType.rawValue), \(depthTexture.pixelFormat.rawValue)): use mask 'alpha'")
        }

        // the mask and the fill
        var maskTexture: MTLTexture = zeroMask
        var fillTexture: MTLTexture = zeroFill
        if let person {
            if dilated == nil || dilated!.width != person.width || dilated!.height != person.height {
                dilated = try texture(device, .r16Float, person.width, person.height, write: true)
                feathered = try texture(device, .r16Float, person.width, person.height, write: true)
            }
            let fw = max(16, CVPixelBufferGetWidth(image) / 4)
            let fh = max(16, CVPixelBufferGetHeight(image) / 4)
            if fill == nil || fill!.width != fw || fill!.height != fh {
                fill = try texture(device, .rgba16Float, fw, fh, write: true, mipmapped: true)
            }
            guard let dilated, let feathered, let fill else { throw EraseFailure("no mask textures") }
            params.misc = SIMD4<Float>(Float(c.depthClear), Float(fill.mipmapLevelCount), 0, 0)
            guard let enc = cb.makeComputeCommandEncoder() else { throw EraseFailure("no compute encoder") }
            enc.label = "erase mask"
            enc.setComputePipelineState(dilatePipeline)
            enc.setTexture(person, index: 0)
            enc.setTexture(personDepth ?? zeroDepth, index: 1)
            enc.setTexture(dilated, index: 2)
            enc.setBytes(&params, length: MemoryLayout<EraseParams>.stride, index: 0)
            dispatch(enc, dilatePipeline, dilated.width, dilated.height)
            enc.setComputePipelineState(featherPipeline)
            enc.setTexture(dilated, index: 0)
            enc.setTexture(feathered, index: 1)
            enc.setBytes(&params, length: MemoryLayout<EraseParams>.stride, index: 0)
            dispatch(enc, featherPipeline, feathered.width, feathered.height)
            enc.setComputePipelineState(fillPipeline)
            enc.setTexture(yTex, index: 0)
            enc.setTexture(cTex, index: 1)
            enc.setTexture(feathered, index: 2)
            enc.setTexture(fill, index: 3)
            dispatch(enc, fillPipeline, fill.width, fill.height)
            enc.endEncoding()
            guard let blit = cb.makeBlitCommandEncoder() else { throw EraseFailure("no blit encoder") }
            blit.label = "erase fill mipmaps"
            blit.generateMipmaps(for: fill)
            blit.endEncoding()
            maskTexture = feathered
            fillTexture = fill
        } else {
            params.misc = SIMD4<Float>(Float(c.depthClear), 1, 0, 0)
        }

        if probe {
            encodeProbe(cb, source: source, depth: depthUsable ? depthTexture : nil, y: yTex, cbcr: cTex, params: params, config: c, context: context)
        }

        // the picture
        if target.usage.contains(.renderTarget) {
            let pass = MTLRenderPassDescriptor()
            pass.colorAttachments[0].texture = target
            pass.colorAttachments[0].loadAction = .dontCare
            pass.colorAttachments[0].storeAction = .store
            guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { throw EraseFailure("no render encoder") }
            enc.label = "erase picture"
            enc.setRenderPipelineState(try renderPipeline(device, format: target.pixelFormat, depth: depthMode))
            enc.setFragmentTexture(source, index: 0)
            enc.setFragmentTexture(yTex, index: 1)
            enc.setFragmentTexture(cTex, index: 2)
            enc.setFragmentTexture(maskTexture, index: 3)
            enc.setFragmentTexture(fillTexture, index: 4)
            if depthMode { enc.setFragmentTexture(depthTexture, index: 5) }
            enc.setFragmentBytes(&params, length: MemoryLayout<EraseParams>.stride, index: 0)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            enc.endEncoding()
        } else if target.usage.contains(.shaderWrite) {
            guard let pipeline = depthMode ? kernelDepth : kernelAlpha else { throw EraseFailure("no picture kernel") }
            guard let enc = cb.makeComputeCommandEncoder() else { throw EraseFailure("no compute encoder") }
            enc.label = "erase picture"
            enc.setComputePipelineState(pipeline)
            enc.setTexture(source, index: 0)
            enc.setTexture(yTex, index: 1)
            enc.setTexture(cTex, index: 2)
            enc.setTexture(maskTexture, index: 3)
            enc.setTexture(fillTexture, index: 4)
            if depthMode { enc.setTexture(depthTexture, index: 5) }
            enc.setTexture(target, index: 6)
            enc.setBytes(&params, length: MemoryLayout<EraseParams>.stride, index: 0)
            dispatch(enc, pipeline, target.width, target.height)
            enc.endEncoding()
        } else {
            throw EraseFailure("the target texture is neither a render target nor writable (usage \(target.usage.rawValue))")
        }

        // the camera textures must live until the GPU is done with them
        let keep: [CVMetalTexture] = [yRef, cRef]
        cb.addCompletedHandler { _ in withExtendedLifetime(keep) {} }
    }

    private func dispatch(_ enc: MTLComputeCommandEncoder, _ pipeline: MTLComputePipelineState, _ w: Int, _ h: Int) {
        let tw = max(1, pipeline.threadExecutionWidth)
        let th = max(1, pipeline.maxTotalThreadsPerThreadgroup / tw)
        enc.dispatchThreads(MTLSize(width: w, height: h, depth: 1), threadsPerThreadgroup: MTLSize(width: tw, height: th, depth: 1))
    }

    private func planeTexture(_ cache: CVMetalTextureCache, _ buffer: CVPixelBuffer, plane: Int, format: MTLPixelFormat) throws -> (MTLTexture, CVMetalTexture) {
        let w = CVPixelBufferGetWidthOfPlane(buffer, plane)
        let h = CVPixelBufferGetHeightOfPlane(buffer, plane)
        var ref: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, cache, buffer, nil, format, w, h, plane, &ref)
        guard status == kCVReturnSuccess, let ref, let t = CVMetalTextureGetTexture(ref) else {
            throw EraseFailure("camera plane \(plane) as a texture: \(status)")
        }
        return (t, ref)
    }

    /// Copies a small one-plane buffer (person mask, its depth) into this frame's ring texture.
    private func upload(_ device: MTLDevice, _ buffer: CVPixelBuffer, into ringTextures: inout [MTLTexture?], format: MTLPixelFormat, cvFormat: OSType, bytesPerPixel: Int) throws -> MTLTexture? {
        guard CVPixelBufferGetPixelFormatType(buffer) == cvFormat, !CVPixelBufferIsPlanar(buffer) else {
            LogOnce.shared.log("erase format \(fourCC(CVPixelBufferGetPixelFormatType(buffer)))", "erase: unexpected buffer format; not used", data: ["format": fourCC(CVPixelBufferGetPixelFormatType(buffer))])
            return nil
        }
        let w = CVPixelBufferGetWidth(buffer)
        let h = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        guard w > 0, h > 0, rowBytes >= w * bytesPerPixel else { return nil }
        if ringTextures[ring] == nil || ringTextures[ring]!.width != w || ringTextures[ring]!.height != h {
            ringTextures[ring] = try texture(device, format, w, h, write: false)
        }
        guard let t = ringTextures[ring] else { return nil }
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        t.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: base, bytesPerRow: rowBytes)
        return t
    }

    private func renderPipeline(_ device: MTLDevice, format: MTLPixelFormat, depth: Bool) throws -> MTLRenderPipelineState {
        let key = "\(format.rawValue)-\(depth)"
        if let p = renderPipelines[key] { return p }
        guard let library,
              let v = library.makeFunction(name: "eraseVertex"),
              let f = library.makeFunction(name: depth ? "eraseFragmentDepth" : "eraseFragmentAlpha") else {
            throw EraseFailure("no Metal functions for the picture")
        }
        let d = MTLRenderPipelineDescriptor()
        d.label = "erase picture"
        d.vertexFunction = v
        d.fragmentFunction = f
        d.colorAttachments[0].pixelFormat = format
        let p = try device.makeRenderPipelineState(descriptor: d)
        renderPipelines[key] = p
        return p
    }

    /// When a frame cannot be drawn: RealityKit's own picture, so the screen is not garbage. (With
    /// the 'alpha' mask that is the virtual content on black.)
    private func passThrough(_ context: ARView.PostProcessContext) {
        let s = context.sourceColorTexture
        let t = context.targetColorTexture
        guard s.pixelFormat == t.pixelFormat, s.width == t.width, s.height == t.height,
              let blit = context.commandBuffer.makeBlitCommandEncoder() else {
            LogOnce.shared.log("erase passthrough", "erase: cannot copy RealityKit's picture through", level: "error", data: describe(context))
            return
        }
        blit.copy(from: s, to: t)
        blit.endEncoding()
    }

    private func encodeProbe(_ cb: MTLCommandBuffer, source: MTLTexture, depth: MTLTexture?, y: MTLTexture, cbcr: MTLTexture, params: EraseParams, config c: EraseConfig, context: ARView.PostProcessContext) {
        guard let device, let pipeline = depth != nil ? probeDepthPipeline : probeColourPipeline,
              let counts = device.makeBuffer(length: 32 * 4, options: .storageModeShared),
              let enc = cb.makeComputeCommandEncoder() else {
            logAnyThread("erase: probe could not start", level: "warn")
            return
        }
        memset(counts.contents(), 0, counts.length)
        var p = params
        enc.label = "erase probe"
        enc.setComputePipelineState(pipeline)
        enc.setTexture(source, index: 0)
        if let depth { enc.setTexture(depth, index: 1) }
        enc.setTexture(y, index: 2)
        enc.setTexture(cbcr, index: 3)
        enc.setBuffer(counts, offset: 0, index: 0)
        enc.setBytes(&p, length: MemoryLayout<EraseParams>.stride, index: 1)
        dispatch(enc, pipeline, (source.width + 7) / 8, (source.height + 7) / 8)
        enc.endEncoding()
        probeSeq += 1
        let seq = probeSeq
        var facts = describe(context)
        facts["config"] = c.json
        facts["seq"] = seq
        facts["depthRead"] = depth != nil
        facts["personMask"] = params.has.x != 0
        let srcLinear = params.modes.z != 0
        let dstLinear = params.modes.w != 0
        cb.addCompletedHandler { [weak self] _ in
            let v = counts.contents().bindMemory(to: UInt32.self, capacity: 32)
            let n = max(1, Double(v[0]))
            let bg = Double(v[7])
            let mean = { (i: Int) -> [Double] in
                bg > 0 ? (0..<3).map { round3(Double(v[i + $0]) / bg / 255) } : []
            }
            var out = facts
            out["samples"] = Int(v[0])
            out["alpha"] = ["low": round3(Double(v[1]) / n), "mid": round3(Double(v[2]) / n), "high": round3(Double(v[3]) / n)]
            if depth != nil {
                out["depth"] = ["zero": round3(Double(v[4]) / n), "one": round3(Double(v[5]) / n), "other": round3(Double(v[6]) / n)]
            }
            out["background"] = [
                "samples": Int(bg), "source": mean(8), "cameraGamma": mean(11), "cameraLinear": mean(14),
            ]
            out["srcLinear"] = srcLinear
            out["dstLinear"] = dstLinear
            let result = ProbeResult(data: out)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    NativeLog.shared.log("erase: probe", data: result.data)
                    self?.emit?(["type": "ar.erase", "probe": result.data])
                }
            }
        }
    }

    private func describe(_ context: ARView.PostProcessContext) -> [String: Any] {
        func t(_ x: MTLTexture) -> [String: Any] {
            [
                "format": Self.formatName(x.pixelFormat), "size": [x.width, x.height], "usage": x.usage.rawValue,
                "type": x.textureType.rawValue, "samples": x.sampleCount,
            ]
        }
        return [
            "source": t(context.sourceColorTexture),
            "depth": t(context.sourceDepthTexture),
            "target": t(context.targetColorTexture),
            "mainThread": Thread.isMainThread,
        ]
    }

    // MARK: pixel formats

    /// Does a texture of this format hold linear colour (sRGB formats decode on read and encode on
    /// write; float formats hold linear values)? 'linear' / 'gamma' override.
    static func isLinear(_ format: MTLPixelFormat, _ override: String) -> Bool {
        if override == "linear" { return true }
        if override == "gamma" { return false }
        switch format {
        case .bgra8Unorm_srgb, .rgba8Unorm_srgb, .bgr10_xr_srgb, .bgra10_xr_srgb, .rgba16Float, .rgba32Float, .rg11b10Float, .rgb9e5Float:
            return true
        default:
            return false
        }
    }

    static func isDepthFormat(_ format: MTLPixelFormat) -> Bool {
        switch format {
        case .depth16Unorm, .depth32Float, .depth32Float_stencil8:
            return true
        default:
            return false
        }
    }

    static func formatName(_ format: MTLPixelFormat) -> String {
        switch format {
        case .bgra8Unorm: return "bgra8Unorm"
        case .bgra8Unorm_srgb: return "bgra8Unorm_srgb"
        case .rgba8Unorm: return "rgba8Unorm"
        case .rgba8Unorm_srgb: return "rgba8Unorm_srgb"
        case .rgba16Float: return "rgba16Float"
        case .rgba32Float: return "rgba32Float"
        case .bgr10_xr: return "bgr10_xr"
        case .bgr10_xr_srgb: return "bgr10_xr_srgb"
        case .bgra10_xr: return "bgra10_xr"
        case .bgra10_xr_srgb: return "bgra10_xr_srgb"
        case .rgb10a2Unorm: return "rgb10a2Unorm"
        case .bgr10a2Unorm: return "bgr10a2Unorm"
        case .rg11b10Float: return "rg11b10Float"
        case .depth16Unorm: return "depth16Unorm"
        case .depth32Float: return "depth32Float"
        case .depth32Float_stencil8: return "depth32Float_stencil8"
        default: return "format \(format.rawValue)"
        }
    }
}

/// A probe's result on its way from the GPU's completion thread to the main thread.
private struct ProbeResult: @unchecked Sendable {
    let data: [String: Any]
}
