import CoreVideo
import Foundation

// Reading ARKit's small per-frame maps: the LiDAR depth map and its confidence, the person mask
// and ARKit's person depth (all 256×192 on this phone, in the camera sensor's landscape
// orientation, like the camera image). Used by the hand worker (joint depth samples, patches),
// by ar.depth and by ar.capture's hands. Any thread; a buffer is only read while it is locked.
//
// Encodings (docs/protocol.md §4, §7): depth as Uint16 little-endian millimetres (0 = no value);
// info as Uint8, bits 0–1 = LiDAR confidence (0 low, 1 medium, 2 high), bit 2 = person.

/// A single-plane pixel buffer of a known format, locked read-only. Rows are addressed with
/// bytesPerRow (rows can be padded). Callers keep 0 ≤ u < width, 0 ≤ v < height.
struct PixelPlane {
    let width: Int
    let height: Int
    private let buffer: CVPixelBuffer
    private let base: UnsafeRawPointer
    private let rowBytes: Int

    private init(buffer: CVPixelBuffer, base: UnsafeRawPointer, width: Int, height: Int, rowBytes: Int) {
        self.buffer = buffer
        self.base = base
        self.width = width
        self.height = height
        self.rowBytes = rowBytes
    }

    /// nil when the buffer is absent or not what is expected (another format, planar, empty);
    /// an unexpected buffer is logged once per name and format, then skipped quietly.
    static func lock(_ buffer: CVPixelBuffer?, name: String, format: OSType, bytesPerPixel: Int) -> PixelPlane? {
        guard let buffer else { return nil }
        let actual = CVPixelBufferGetPixelFormatType(buffer)
        let planar = CVPixelBufferIsPlanar(buffer)
        guard actual == format, !planar else {
            LogOnce.shared.log("format \(name) \(actual) \(planar)", "pixel buffer skipped: unexpected format",
                               data: ["buffer": name, "format": fourCC(actual), "expected": fourCC(format), "planar": planar])
            return nil
        }
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else {
            LogOnce.shared.log("lock \(name)", "pixel buffer skipped: could not lock it", data: ["buffer": name])
            return nil
        }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        guard width > 0, height > 0, width <= 16_384, height <= 16_384, rowBytes >= width * bytesPerPixel,
              let base = CVPixelBufferGetBaseAddress(buffer) else {
            CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
            LogOnce.shared.log("empty \(name)", "pixel buffer skipped: empty or odd size",
                               data: ["buffer": name, "width": width, "height": height, "bytesPerRow": rowBytes])
            return nil
        }
        return PixelPlane(buffer: buffer, base: UnsafeRawPointer(base), width: width, height: height, rowBytes: rowBytes)
    }

    func unlock() {
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
    }

    @inline(__always) func float(_ u: Int, _ v: Int) -> Float {
        base.loadUnaligned(fromByteOffset: v * rowBytes + u * 4, as: Float32.self)
    }

    @inline(__always) func byte(_ u: Int, _ v: Int) -> UInt8 {
        base.load(fromByteOffset: v * rowBytes + u, as: UInt8.self)
    }
}

/// The maps of one frame, any of them possibly missing, locked together. The LiDAR depth map is
/// the grid that joint windows and patches are measured in (protocol §0: pixel (u, v) has its
/// centre at ((u + 0.5) / W, (v + 0.5) / H)); the other maps are addressed at the same normalized
/// point through their own size, so a map of another resolution still lines up.
struct DepthMaps {
    let depth: PixelPlane?
    let confidence: PixelPlane?
    let person: PixelPlane?
    let personDepth: PixelPlane?

    static func lock(depth: CVPixelBuffer?, confidence: CVPixelBuffer?, person: CVPixelBuffer?, personDepth: CVPixelBuffer?) -> DepthMaps {
        DepthMaps(
            depth: PixelPlane.lock(depth, name: "depth", format: kCVPixelFormatType_DepthFloat32, bytesPerPixel: 4),
            confidence: PixelPlane.lock(confidence, name: "confidence", format: kCVPixelFormatType_OneComponent8, bytesPerPixel: 1),
            person: PixelPlane.lock(person, name: "personMask", format: kCVPixelFormatType_OneComponent8, bytesPerPixel: 1),
            personDepth: PixelPlane.lock(personDepth, name: "personDepth", format: kCVPixelFormatType_DepthFloat32, bytesPerPixel: 4)
        )
    }

    func unlock() {
        depth?.unlock()
        confidence?.unlock()
        person?.unlock()
        personDepth?.unlock()
    }

    /// The grid for joint windows: the LiDAR map; without LiDAR the person depth or mask.
    var grid: (width: Int, height: Int)? {
        if let m = depth ?? personDepth ?? person { return (m.width, m.height) }
        return nil
    }

    /// Pixel `u` of a row `size` pixels long → the pixel of a row `other` pixels long that
    /// contains the same normalized point (the pixel's centre). Integer maths, always in range.
    @inline(__always) static func map(_ u: Int, _ size: Int, _ other: Int) -> Int {
        if other == size { return u }
        return min(other - 1, max(0, ((2 * u + 1) * other) / (2 * size)))
    }

    @inline(__always) func isPerson(_ u: Int, _ v: Int, _ w: Int, _ h: Int) -> Bool {
        guard let person else { return false }
        return person.byte(Self.map(u, w, person.width), Self.map(v, h, person.height)) != 0
    }

    @inline(__always) func confidenceLevel(_ u: Int, _ v: Int, _ w: Int, _ h: Int) -> UInt8? {
        guard let confidence else { return nil }
        return confidence.byte(Self.map(u, w, confidence.width), Self.map(v, h, confidence.height))
    }

    @inline(__always) func personDepthValue(_ u: Int, _ v: Int, _ w: Int, _ h: Int) -> Float? {
        guard let personDepth else { return nil }
        return personDepth.float(Self.map(u, w, personDepth.width), Self.map(v, h, personDepth.height))
    }

    /// The depth-map pixel that contains image point (x, y) (0..1), or nil when the point is not
    /// finite or far outside the picture. May lie just outside the map; callers clamp.
    static func pixel(_ x: Double, _ y: Double, _ w: Int, _ h: Int) -> (u: Int, v: Int)? {
        guard x.isFinite, y.isFinite, x > -1, x < 2, y > -1, y < 2 else { return nil }
        return (Int((x * Double(w)).rounded(.down)), Int((y * Double(h)).rounded(.down)))
    }

    /// The smallest step ≥ `start` with ⌈w/step⌉·⌈h/step⌉ ≤ maxPixels.
    static func fitStep(_ w: Int, _ h: Int, start: Int, maxPixels: Int) -> Int {
        var step = max(1, start)
        let limit = max(1, maxPixels)
        while ((w + step - 1) / step) * ((h + step - 1) / step) > limit && step < max(w, h) {
            step += 1
        }
        return step
    }

    /// Depth-map pixels (u0 + i·step, v0 + j·step) inside [u0, u1) × [v0, v1), row by row, as
    /// base64. nil without a LiDAR map or for an empty rect. The rect is clamped to the map.
    func patch(u0: Int, v0: Int, u1: Int, v1: Int, step: Int, withPersonDepth: Bool) -> DepthPatch? {
        guard let depth else { return nil }
        let W = depth.width
        let H = depth.height
        let a0 = min(max(u0, 0), W), a1 = min(max(u1, 0), W)
        let b0 = min(max(v0, 0), H), b1 = min(max(v1, 0), H)
        guard a1 > a0, b1 > b0 else { return nil }
        let s = max(1, step)
        let w = (a1 - a0 + s - 1) / s
        let h = (b1 - b0 + s - 1) / s
        var depthBytes = [UInt8](repeating: 0, count: w * h * 2)
        var infoBytes = [UInt8](repeating: 0, count: w * h)
        let wantPD = withPersonDepth && personDepth != nil
        var pdBytes = [UInt8](repeating: 0, count: wantPD ? w * h * 2 : 0)
        for j in 0..<h {
            let v = b0 + j * s
            for i in 0..<w {
                let u = a0 + i * s
                let k = j * w + i
                let mm = millimetres(depth.float(u, v))
                depthBytes[2 * k] = UInt8(mm & 0xFF)
                depthBytes[2 * k + 1] = UInt8(mm >> 8)
                var info: UInt8 = 0
                if let c = confidenceLevel(u, v, W, H) { info |= min(c, 3) }
                if isPerson(u, v, W, H) { info |= 4 }
                infoBytes[k] = info
                if wantPD, let pd = personDepthValue(u, v, W, H) {
                    let pmm = millimetres(pd)
                    pdBytes[2 * k] = UInt8(pmm & 0xFF)
                    pdBytes[2 * k + 1] = UInt8(pmm >> 8)
                }
            }
        }
        return DepthPatch(
            rect: [a0, b0, a1, b1], step: s, w: w, h: h,
            depth: Data(depthBytes).base64EncodedString(),
            info: Data(infoBytes).base64EncodedString(),
            personDepth: wantPD ? Data(pdBytes).base64EncodedString() : nil
        )
    }
}

/// Metres → whole millimetres for a Uint16; 0 = no value (not finite, ≤ 0).
@inline(__always) func millimetres(_ d: Float) -> UInt16 {
    let mm = Double(d) * 1000
    guard mm.isFinite, mm > 0 else { return 0 }
    return UInt16(min(65_535, mm.rounded()))
}

struct DepthPatch {
    let rect: [Int]
    let step: Int
    let w: Int
    let h: Int
    let depth: String
    let info: String
    let personDepth: String?
}

/// What the depth window around one joint says (protocol §4).
struct JointDepth {
    var dAll: Float = 0
    var dHand: Float = 0
    var nHand = 0
    var nAll = 0
    var hi: Float = 0
    var pd: Float = 0
}

/// Samples the (2r+1)² window of depth-map pixels around a joint. Keeps its scratch arrays
/// between calls, so one sampler belongs to one thread.
struct JointSampler {
    private var all: [Float] = []
    private var hand: [Float] = []
    private var personDepths: [Float] = []

    /// Window around image point (x, y), clamped to the map:
    /// dAll = median LiDAR depth of the valid pixels, nAll = their number;
    /// nHand = person pixels in the window, dHand = median LiDAR depth of those with a valid depth;
    /// hi = fraction of the window's pixels with LiDAR confidence "high";
    /// pd = median ARKit person depth over the person pixels.
    mutating func sample(_ maps: DepthMaps, x: Double, y: Double, radius: Int) -> JointDepth {
        guard let grid = maps.grid, let c = DepthMaps.pixel(x, y, grid.width, grid.height) else { return JointDepth() }
        let W = grid.width
        let H = grid.height
        let r = max(0, min(radius, 10))
        let u0 = max(0, c.u - r), u1 = min(W - 1, c.u + r)
        let v0 = max(0, c.v - r), v1 = min(H - 1, c.v + r)
        guard u0 <= u1, v0 <= v1 else { return JointDepth() }
        all.removeAll(keepingCapacity: true)
        hand.removeAll(keepingCapacity: true)
        personDepths.removeAll(keepingCapacity: true)
        var window = 0
        var people = 0
        var high = 0
        for v in v0...v1 {
            for u in u0...u1 {
                window += 1
                var d: Float = 0
                var valid = false
                if let depth = maps.depth {
                    d = depth.float(DepthMaps.map(u, W, depth.width), DepthMaps.map(v, H, depth.height))
                    valid = d.isFinite && d > 0
                }
                if valid { all.append(d) }
                if let level = maps.confidenceLevel(u, v, W, H), level >= 2 { high += 1 }
                if maps.isPerson(u, v, W, H) {
                    people += 1
                    if valid { hand.append(d) }
                    if let pd = maps.personDepthValue(u, v, W, H), pd.isFinite, pd > 0 { personDepths.append(pd) }
                }
            }
        }
        var out = JointDepth()
        out.nAll = all.count
        out.dAll = Self.median(&all)
        out.nHand = people
        out.dHand = Self.median(&hand)
        out.hi = window > 0 ? Float(high) / Float(window) : 0
        out.pd = Self.median(&personDepths)
        return out
    }

    private static func median(_ values: inout [Float]) -> Float {
        let n = values.count
        guard n > 0 else { return 0 }
        values.sort()
        return n % 2 == 1 ? values[n / 2] : (values[n / 2 - 1] + values[n / 2]) / 2
    }
}
