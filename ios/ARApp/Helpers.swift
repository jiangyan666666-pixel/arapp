import ARKit
import Foundation
import QuartzCore
import simd

// Small helpers shared by the native files. No state of their own except the two log helpers at
// the end, and all of them can be called from any thread (the hand worker uses them too).

// MARK: - reading the page's payloads
//
// Payloads arrive from WKScriptMessage as NSDictionary / NSArray / NSNumber / NSString / NSNull.
// Nothing here traps on odd input: a wrong type, NaN, infinity or an absurd number reads as
// "not given", or makes a parse function throw a PayloadError that the handler turns into
// {error: "..."}. A wrong payload must never cost a reinstall.

/// Why a payload was refused; the handler replies {error: text}. It names the key that was
/// wrong, never a value from the payload (blind test: a box size must not end up in a log).
struct PayloadError: Error {
    let text: String
    init(_ text: String) { self.text = text }
}

func errorText(_ error: Error) -> String {
    (error as? PayloadError)?.text ?? String(describing: error)
}

/// The value of `key`, or nil when it is absent or null.
func given(_ p: [String: Any], _ key: String) -> Any? {
    guard let v = p[key], !(v is NSNull) else { return nil }
    return v
}

func flag(_ options: [String: Any], _ key: String, _ fallback: Bool) -> Bool {
    (options[key] as? Bool) ?? fallback
}

func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber else { return nil }
    let d = n.doubleValue
    return d.isFinite ? d : nil
}

/// A whole number (fractions are rounded). Limited to ±1e9 so the conversion to Int cannot trap.
func integer(_ value: Any?) -> Int? {
    guard let d = number(value), abs(d) <= 1e9 else { return nil }
    return Int(d.rounded())
}

/// Exactly `count` finite numbers.
func numbers(_ value: Any?, count: Int) -> [Double]? {
    guard let a = value as? [Any], a.count == count else { return nil }
    var out: [Double] = []
    out.reserveCapacity(count)
    for item in a {
        guard let d = number(item) else { return nil }
        out.append(d)
    }
    return out
}

/// [x, y, z]; nil unless all three are finite, also after the conversion to Float.
func vector(_ value: Any?) -> SIMD3<Float>? {
    guard let d = numbers(value, count: 3) else { return nil }
    let v = SIMD3<Float>(Float(d[0]), Float(d[1]), Float(d[2]))
    return allFinite(v) ? v : nil
}

func allFinite(_ v: SIMD3<Float>) -> Bool {
    v.x.isFinite && v.y.isFinite && v.z.isFinite
}

/// [x, y, z, w] → a unit quaternion; nil unless 4 finite numbers of non-zero length.
func quaternion(_ value: Any?) -> simd_quatf? {
    guard let d = numbers(value, count: 4) else { return nil }
    return unitQuaternion(Float(d[0]), Float(d[1]), Float(d[2]), Float(d[3]))
}

func unitQuaternion(_ x: Float, _ y: Float, _ z: Float, _ w: Float) -> simd_quatf? {
    let v = SIMD4<Float>(x, y, z, w)
    let length = simd_length(v)
    guard length.isFinite, length > 1e-6 else { return nil }
    return simd_quatf(vector: v / length)
}

let identityRotation = simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)

/// A turn about world Y (gravity). Angles beyond ±1e4 rad are refused by the callers, so the
/// Float conversion stays finite.
func yawRotation(_ yaw: Double) -> simd_quatf {
    simd_quatf(angle: Float(yaw), axis: SIMD3<Float>(0, 1, 0))
}

// Throwing readers for the handlers: nil = not given; a value of the wrong kind throws.

func optionalBool(_ p: [String: Any], _ key: String) throws -> Bool? {
    guard let v = given(p, key) else { return nil }
    guard let b = v as? Bool else { throw PayloadError("\(key): true or false") }
    return b
}

func optionalNumber(_ p: [String: Any], _ key: String, limit: Double = 1e6) throws -> Double? {
    guard let v = given(p, key) else { return nil }
    guard let d = number(v), abs(d) <= limit else { throw PayloadError("\(key): a number") }
    return d
}

func optionalString(_ p: [String: Any], _ key: String) throws -> String? {
    guard let v = given(p, key) else { return nil }
    guard let s = v as? String else { throw PayloadError("\(key): a string") }
    return s
}

/// A position or offset in metres. Bounded (±10 km) so an ARKit anchor never gets an absurd
/// transform.
func optionalVector(_ p: [String: Any], _ key: String, limit: Float = 10_000) throws -> SIMD3<Float>? {
    guard let v = given(p, key) else { return nil }
    guard let x = vector(v), abs(x.x) <= limit, abs(x.y) <= limit, abs(x.z) <= limit else {
        throw PayloadError("\(key): [x, y, z]")
    }
    return x
}

func optionalQuaternion(_ p: [String: Any], _ key: String) throws -> simd_quatf? {
    guard let v = given(p, key) else { return nil }
    guard let q = quaternion(v) else { throw PayloadError("\(key): [qx, qy, qz, qw], not all zero") }
    return q
}

/// Keys a handler does not know are ignored, but logged once each: a typo in the page then shows
/// up in the PC's log instead of silently doing nothing.
func logUnknownKeys(_ p: [String: Any], known: Set<String>, in context: String) {
    for key in p.keys where !known.contains(key) {
        let name = String(key.prefix(40))
        LogOnce.shared.log("key \(context) \(name)", "unknown key ignored", data: ["in": context, "key": name])
    }
}

// MARK: - numbers JSON can hold

/// JSON cannot hold NaN or infinity, and 5 decimals (0.01 mm) is plenty.
func round5(_ v: Double) -> Double {
    guard v.isFinite else { return 0 }
    guard abs(v) < 1e12 else { return v }
    return (v * 100_000).rounded() / 100_000
}

func round5(_ v: Float) -> Double { round5(Double(v)) }

/// Depth in metres to 0.1 mm.
func round4(_ v: Float) -> Double {
    let d = Double(v)
    guard d.isFinite else { return 0 }
    guard abs(d) < 1e12 else { return d }
    return (d * 10_000).rounded() / 10_000
}

func list(_ v: SIMD3<Float>) -> [Double] {
    [round5(v.x), round5(v.y), round5(v.z)]
}

/// The x, y, z of a column (a position).
func list(_ v: SIMD4<Float>) -> [Double] {
    [round5(v.x), round5(v.y), round5(v.z)]
}

func list(_ m: simd_float4x4) -> [Double] {
    [m.columns.0, m.columns.1, m.columns.2, m.columns.3].flatMap { [round5($0.x), round5($0.y), round5($0.z), round5($0.w)] }
}

func list(_ m: simd_float3x3) -> [Double] {
    [m.columns.0, m.columns.1, m.columns.2].flatMap { [round5($0.x), round5($0.y), round5($0.z)] }
}

func list(_ s: CGSize) -> [Double] {
    [round5(Double(s.width)), round5(Double(s.height))]
}

/// [a, b, c, d, tx, ty] (docs/protocol.md §0).
func list(_ t: CGAffineTransform) -> [Double] {
    [t.a, t.b, t.c, t.d, t.tx, t.ty].map { round5(Double($0)) }
}

/// The camera numbers of one frame as the page gets them: {transform, intrinsics, imageResolution}.
func cameraJSON(transform: simd_float4x4, intrinsics: simd_float3x3, imageResolution: CGSize) -> [String: Any] {
    ["transform": list(transform), "intrinsics": list(intrinsics), "imageResolution": list(imageResolution)]
}

/// The safety net in front of JSONSerialization: everything sent goes through round5 already,
/// but a NaN that slipped through would make the whole message vanish. Replaces non-finite
/// numbers with 0 and anything that is not a JSON type with its description.
func jsonSafe(_ value: Any) -> Any {
    switch value {
    case let d as [String: Any]:
        return d.mapValues { jsonSafe($0) }
    case let a as [Any]:
        return a.map { jsonSafe($0) }
    case is String, is NSNull:
        return value
    case let n as NSNumber:
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n }
        return n.doubleValue.isFinite ? n : NSNumber(value: 0)
    default:
        return String(describing: value)
    }
}

// MARK: - ARKit and system values as text

func trackingText(_ state: ARCamera.TrackingState) -> String {
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

func mappingText(_ status: ARFrame.WorldMappingStatus) -> String {
    switch status {
    case .notAvailable: return "notAvailable"
    case .limited: return "limited"
    case .extending: return "extending"
    case .mapped: return "mapped"
    @unknown default: return "unknown"
    }
}

func planeClass(_ c: ARPlaneAnchor.Classification) -> String {
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

func thermalText(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
}

func fourCC(_ code: OSType) -> String {
    let bytes = [UInt8((code >> 24) & 255), UInt8((code >> 16) & 255), UInt8((code >> 8) & 255), UInt8(code & 255)]
    return String(bytes: bytes, encoding: .ascii) ?? "\(code)"
}

// MARK: - the last second

/// Values with the time they happened, kept for the last `span` seconds: frames per second, hand
/// events per second and their Vision time, box-update latency. Never more than `cap` entries, so
/// a burst cannot grow it without bound.
struct RecentValues {
    let span: TimeInterval
    private let cap = 1000
    private(set) var times: [TimeInterval] = []
    private(set) var values: [Double] = []

    init(span: TimeInterval) { self.span = span }

    mutating func add(_ value: Double, at t: TimeInterval) {
        times.append(t)
        values.append(value)
        prune(t)
        if times.count > cap {
            let extra = times.count - cap
            times.removeFirst(extra)
            values.removeFirst(extra)
        }
    }

    mutating func prune(_ now: TimeInterval) {
        var k = 0
        while k < times.count && times[k] <= now - span { k += 1 }
        if k > 0 {
            times.removeFirst(k)
            values.removeFirst(k)
        }
    }

    /// {n, mean, p50, p90, max} of the values (0s when there are none).
    func summary() -> [String: Any] {
        guard !values.isEmpty else { return ["n": 0, "mean": 0, "p50": 0, "p90": 0, "max": 0] }
        let sorted = values.sorted()
        let n = sorted.count
        let at = { (q: Double) -> Double in sorted[min(n - 1, max(0, Int((Double(n - 1) * q).rounded())))] }
        let mean = sorted.reduce(0, +) / Double(n)
        return ["n": n, "mean": round3(mean), "p50": round3(at(0.5)), "p90": round3(at(0.9)), "max": round3(sorted[n - 1])]
    }
}

func round3(_ v: Double) -> Double {
    guard v.isFinite else { return 0 }
    guard abs(v) < 1e12 else { return v }
    return (v * 1000).rounded() / 1000
}

// MARK: - logging from any thread

/// For failures that can repeat every frame: lets one log line through every `every` seconds and
/// counts the ones held back in between.
struct Throttle {
    let every: TimeInterval
    private var last: TimeInterval = -.infinity
    private var held = 0

    init(every: TimeInterval) { self.every = every }

    /// nil = do not log now; otherwise how many were held back since the last line.
    mutating func pass(_ now: TimeInterval = CACurrentMediaTime()) -> Int? {
        if now - last >= every {
            let n = held
            held = 0
            last = now
            return n
        }
        held += 1
        return nil
    }
}

private struct PendingLine: @unchecked Sendable {
    let message: String
    let level: String
    let data: [String: Any]
}

/// NativeLog belongs to the main thread; this can be called from any thread (the hand worker).
func logAnyThread(_ message: String, level: String = "info", data: [String: Any] = [:]) {
    if Thread.isMainThread {
        MainActor.assumeIsolated { _ = NativeLog.shared.log(message, level: level, data: data) }
    } else {
        let line = PendingLine(message: message, level: level, data: data)
        DispatchQueue.main.async {
            MainActor.assumeIsolated { _ = NativeLog.shared.log(line.message, level: line.level, data: line.data) }
        }
    }
}

/// Logs a message only the first time its key is seen in this launch (an odd pixel format, an
/// unknown option): enough to diagnose from the PC, without a line per frame. Any thread.
final class LogOnce: @unchecked Sendable {
    static let shared = LogOnce()
    private let lock = NSLock()
    private var seen = Set<String>()
    private let cap = 500

    func log(_ key: String, _ message: String, level: String = "warn", data: [String: Any] = [:]) {
        lock.lock()
        var first = false
        var full = false
        if !seen.contains(key) {
            if seen.count < cap {
                seen.insert(key)
                first = true
            } else if !seen.contains("(full)") {
                seen.insert("(full)")
                full = true
            }
        }
        lock.unlock()
        if first {
            logAnyThread(message, level: level, data: data)
        } else if full {
            logAnyThread("log-once: too many different messages, the rest are not logged", level: "warn")
        }
    }
}
