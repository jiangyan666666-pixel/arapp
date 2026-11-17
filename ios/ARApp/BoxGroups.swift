import ARKit
import QuartzCore
import RealityKit
import UIKit

// Everything the page shows in the 3D picture – the hand model, the furniture, debug markers – is
// a group of boxes (docs/protocol.md §5). A group has its own pose; each box has a pose inside the
// group, a size and a look. The page moves them every frame (ar.updateGroups), so that path only
// sets transforms: no mesh or material is made there. All boxes share one unit-cube mesh scaled
// to their size, and materials are cached by look.
//
// Entities: world-origin anchor → group entity (the group's pose) → one holder per box (the box's
// pose, never scaled) → the drawn parts: one unit cube scaled to the size ('solid'), or 12 thin
// bars ('edges', so the edge thickness stays in metres whatever the size).
//
// Anchored groups also have an ARKit anchor at their pose: when ARKit corrects its map, the anchor
// moves with the real surroundings and the group follows it. The stage-2 furniture is the
// anchored group "furniture". BLIND TEST: never log a box size.
@MainActor
final class BoxGroups {
    static let maxGroups = 64
    static let maxBoxes = 400
    static let furnitureID = "furniture"

    /// Anchored groups follow ARKit's corrections (the "followAnchor" option).
    var followAnchor = true

    private weak var root: Entity?
    private weak var session: ARSession?
    private var groups: [String: BoxGroup] = [:]
    private var anchorOwners: [UUID: String] = [:]
    private var latency = RecentValues(span: 1)
    private var materials: [MaterialKey: any RealityKit.Material] = [:]
    private var unitBoxMesh: MeshResource?
    private var limitLog = Throttle(every: 5)
    private var updateLog = Throttle(every: 5)

    private static let groupKeys: Set<String> = ["id", "boxes", "position", "rotation", "yaw", "anchored", "shadow", "visible"]
    private static let updateKeys: Set<String> = ["id", "position", "rotation", "yaw", "visible", "boxes"]
    private static let boxKeys: Set<String> = [
        "i", "size", "position", "rotation", "color", "opacity", "material", "roughness", "metallic", "style", "edge", "visible",
    ]

    /// Called once the AR view exists: groups hang under its world-origin anchor.
    func attach(root: Entity, session: ARSession) {
        self.root = root
        self.session = session
    }

    var count: Int { groups.count }

    func has(_ id: String) -> Bool { groups[id] != nil }

    private var unitBox: MeshResource {
        if let mesh = unitBoxMesh { return mesh }
        let mesh = MeshResource.generateBox(size: 1)
        unitBoxMesh = mesh
        return mesh
    }

    // MARK: messages

    /// ar.setGroup {id, boxes, position?, rotation? | yaw?, anchored?, shadow?, visible?} → {ok, count}
    func setGroup(_ p: [String: Any]) -> [String: Any] {
        guard let root else { return ["error": "ar-not-started"] }
        logUnknownKeys(p, known: Self.groupKeys, in: "ar.setGroup")
        do {
            let id = try groupID(p)
            guard let raw = given(p, "boxes") as? [Any] else { throw PayloadError("boxes: a list of boxes") }
            guard raw.count <= Self.maxBoxes else {
                limitHit("boxes per group")
                throw PayloadError("too many boxes (at most \(Self.maxBoxes) per group)")
            }
            if groups[id] == nil && groups.count >= Self.maxGroups {
                limitHit("groups")
                throw PayloadError("too many groups (at most \(Self.maxGroups))")
            }
            var specs: [BoxSpec] = []
            specs.reserveCapacity(raw.count)
            for (k, item) in raw.enumerated() {
                guard let b = item as? [String: Any] else { throw PayloadError("box \(k): an object") }
                logUnknownKeys(b, known: Self.boxKeys, in: "ar.setGroup box")
                specs.append(try parseBox(b, index: k))
            }
            let change = try poseChange(p)
            let anchored = try optionalBool(p, "anchored") ?? false
            let shadow = try optionalBool(p, "shadow") ?? false
            let visible = try optionalBool(p, "visible") ?? true
            let pose = Transform(scale: .one, rotation: change.rotation ?? identityRotation, translation: change.translation ?? .zero)
            install(id: id, specs: specs, pose: pose, anchored: anchored, shadow: shadow, visible: visible, root: root)
            return ["ok": true, "count": specs.count]
        } catch {
            return ["error": errorText(error)]
        }
    }

    /// ar.updateGroups {groups: [{id, position?, rotation? | yaw?, visible?, boxes?: [update]}], frameT?}
    /// → {ok, now}. Usually sent without an id (no reply), every frame. What is valid is applied;
    /// anything invalid is skipped, logged (throttled) and makes the reply an error.
    func updateGroups(_ p: [String: Any]) -> [String: Any] {
        guard let list = given(p, "groups") as? [Any] else {
            noteUpdateProblem("groups: a list")
            return ["error": "groups: a list"]
        }
        var problems = 0
        var firstProblem: String?
        func problem(_ text: String) {
            problems += 1
            if firstProblem == nil { firstProblem = text }
        }
        for item in list {
            guard let g = item as? [String: Any] else { problem("a group update is not an object"); continue }
            guard let id = g["id"] as? String, let group = groups[id] else { problem("unknown group"); continue }
            logUnknownKeys(g, known: Self.updateKeys, in: "ar.updateGroups")
            do {
                let change = try poseChange(g)
                if change.translation != nil || change.rotation != nil { applyPose(change, to: group) }
                if let visible = try optionalBool(g, "visible") { group.entity.isEnabled = visible }
            } catch {
                problem(errorText(error))
            }
            guard let rawRows = given(g, "boxes") else { continue }
            guard let rows = rawRows as? [Any] else { problem("boxes: a list"); continue }
            for row in rows {
                if let values = row as? [NSNumber] {
                    if !applyRow(values, to: group) { problem("a box row is not [i, px, py, pz, qx, qy, qz, qw(, sx, sy, sz)]") }
                } else if let object = row as? [String: Any] {
                    do {
                        try applyBoxObject(object, to: group)
                    } catch {
                        problem(errorText(error))
                    }
                } else {
                    problem("a box update is neither a list nor an object")
                }
            }
        }
        let now = CACurrentMediaTime()
        if let frameT = number(p["frameT"]) {
            latency.add((now - frameT) * 1000, at: now)
        }
        if let firstProblem {
            noteUpdateProblem(firstProblem, count: problems)
            return ["error": "\(problems) update(s) skipped: \(firstProblem)"]
        }
        return ["ok": true, "now": now]
    }

    /// ar.moveGroup {id, dx?, dy?, dz?, dyaw?}: from where the group is now (after ARKit's
    /// corrections), along its own axes, then turned about world Y. → {ok, transform}
    func moveGroup(_ p: [String: Any]) -> [String: Any] {
        do {
            let id = try groupID(p)
            guard let group = groups[id] else { throw PayloadError("no such group") }
            let dx = try optionalNumber(p, "dx", limit: 1000) ?? 0
            let dy = try optionalNumber(p, "dy", limit: 1000) ?? 0
            let dz = try optionalNumber(p, "dz", limit: 1000) ?? 0
            let dyaw = try optionalNumber(p, "dyaw", limit: 1000) ?? 0
            var t = group.entity.transform
            t.translation += t.rotation.act(SIMD3<Float>(Float(dx), Float(dy), Float(dz)))
            t.rotation = simd_normalize(yawRotation(dyaw) * t.rotation)
            t.scale = .one
            group.entity.transform = t
            if group.anchored { anchor(group) }
            return ["ok": true, "transform": list(group.entity.transform.matrix)]
        } catch {
            return ["error": errorText(error)]
        }
    }

    /// ar.removeGroup {id} → {ok}. Removing a group that is not there is fine.
    func removeGroup(_ p: [String: Any]) -> [String: Any] {
        do {
            let id = try groupID(p)
            remove(id)
            return ["ok": true]
        } catch {
            return ["error": errorText(error)]
        }
    }

    /// ar.clearGroups → {ok}; also on ar.stop and on a start that resets the session.
    func removeAll() {
        for id in Array(groups.keys) { remove(id) }
        anchorOwners.removeAll()
    }

    /// ar.groups → {ok, groups: {id: {transform, anchored, count, visible}}}
    func listGroups() -> [String: Any] {
        var out: [String: Any] = [:]
        for (id, g) in groups {
            out[id] = [
                "transform": list(g.entity.transform.matrix),
                "anchored": g.anchored,
                "count": g.boxes.count,
                "visible": g.entity.isEnabled,
            ]
        }
        return ["ok": true, "groups": out]
    }

    // MARK: the stage-2 furniture = the anchored group "furniture"

    /// ar.setFurniture {boxes: [{size, position, color, roughness}], position, yaw, shadow}, in the
    /// furniture's own space (origin bottom centre, front +Z). Same look as stage 2.
    func setFurniture(_ p: [String: Any]) -> [String: Any] {
        guard let root else { return ["error": "ar-not-started"] }
        guard let raw = p["boxes"] as? [[String: Any]], !raw.isEmpty, raw.count <= Self.maxBoxes else {
            return ["error": "bad-boxes"]
        }
        var specs: [BoxSpec] = []
        for box in raw {
            guard let size = vector(box["size"]), let position = vector(box["position"]),
                  size.x > 0, size.y > 0, size.z > 0, size.max() <= 1000 else {
                return ["error": "bad-box"]
            }
            var look = BoxLook()
            if let rgb = vector(box["color"]) { look.color = rgb.clamped(lowerBound: .zero, upperBound: .one) }
            if let r = number(box["roughness"]) { look.roughness = Float(min(max(r, 0), 1)) }
            specs.append(BoxSpec(size: size, position: position, rotation: identityRotation, look: look, visible: true))
        }
        guard let position = try? optionalVector(p, "position") else { return ["error": "bad-position"] }
        guard let yaw = furnitureYaw(p) else { return ["error": "bad-yaw"] }
        if groups[Self.furnitureID] == nil && groups.count >= Self.maxGroups {
            limitHit("groups")
            return ["error": "too many groups (at most \(Self.maxGroups))"]
        }
        let pose = Transform(scale: .one, rotation: yawRotation(yaw), translation: position)
        install(id: Self.furnitureID, specs: specs, pose: pose, anchored: true, shadow: flag(p, "shadow", true), visible: true, root: root)
        return ["ok": true]
    }

    /// ar.moveFurniture {position, yaw}: an absolute pose; re-anchors.
    func moveFurniture(_ p: [String: Any]) -> [String: Any] {
        guard let group = groups[Self.furnitureID] else { return ["error": "no-furniture"] }
        guard let position = try? optionalVector(p, "position") else { return ["error": "bad-position"] }
        guard let yaw = furnitureYaw(p) else { return ["error": "bad-yaw"] }
        group.entity.transform = Transform(scale: .one, rotation: yawRotation(yaw), translation: position)
        if group.anchored { anchor(group) }
        return ["ok": true]
    }

    func clearFurniture() -> [String: Any] {
        remove(Self.furnitureID)
        return ["ok": true]
    }

    private func furnitureYaw(_ p: [String: Any]) -> Double? {
        guard let v = given(p, "yaw") else { return 0 }
        guard let yaw = number(v), abs(yaw) <= 1e4 else { return nil }
        return yaw
    }

    // MARK: status

    /// ar.status.groups: {id: {transform, anchorUpdates, anchorShift}} for anchored groups.
    func anchoredStatus() -> [String: Any] {
        var out: [String: Any] = [:]
        for (id, g) in groups where g.anchored {
            out[id] = anchorJSON(g)
        }
        return out
    }

    /// ar.status.furniture (stage 2).
    func furnitureStatus() -> [String: Any]? {
        guard let g = groups[Self.furnitureID] else { return nil }
        return anchorJSON(g)
    }

    /// ar.capture's furniture: its pose only, never its size (blind test).
    func furniturePose() -> [String: Any]? {
        guard let g = groups[Self.furnitureID] else { return nil }
        return ["position": list(g.entity.position), "transform": list(g.entity.transform.matrix)]
    }

    /// ar.status.latency: {n, mean, p50, p90, max} in ms of (applied − frameT) over the last second.
    func latencyStatus(now: TimeInterval) -> [String: Any] {
        latency.prune(now)
        return latency.summary()
    }

    private func anchorJSON(_ g: BoxGroup) -> [String: Any] {
        ["transform": list(g.entity.transform.matrix), "anchorUpdates": g.anchorUpdates, "anchorShift": round5(g.anchorShift)]
    }

    // MARK: ARKit anchors

    /// session(_:didUpdate anchors:): anchored groups follow their anchor.
    func anchorsUpdated(_ anchors: [ARAnchor]) {
        guard followAnchor, !anchorOwners.isEmpty else { return }
        for anchor in anchors {
            guard let id = anchorOwners[anchor.identifier], let group = groups[id] else { continue }
            let before = group.entity.position
            group.entity.transform = Transform(matrix: anchor.transform)
            group.anchorShift += simd_distance(before, group.entity.position)
            group.anchorUpdates += 1
        }
    }

    /// session(_:didRemove anchors:): ARKit dropped one of our anchors (we remove our own before
    /// ARKit reports it, so those are no longer listed). The group stays where it is.
    func anchorsRemoved(_ anchors: [ARAnchor]) {
        guard !anchorOwners.isEmpty else { return }
        for anchor in anchors {
            guard let id = anchorOwners.removeValue(forKey: anchor.identifier) else { continue }
            groups[id]?.anchor = nil
            LogOnce.shared.log("anchor removed \(id)", "groups: ARKit removed a group's anchor", data: ["group": String(id.prefix(40))])
        }
    }

    /// A new ARKit anchor at the group's pose (replacing the old one); counts start again.
    private func anchor(_ group: BoxGroup) {
        guard let session else { return }
        if let old = group.anchor {
            session.remove(anchor: old)
            anchorOwners[old.identifier] = nil
        }
        let name = group.id == Self.furnitureID ? "furniture" : "group"
        let anchor = ARAnchor(name: name, transform: group.entity.transform.matrix)
        session.add(anchor: anchor)
        anchorOwners[anchor.identifier] = group.id
        group.anchor = anchor
        group.anchorUpdates = 0
        group.anchorShift = 0
    }

    // MARK: building

    private func install(id: String, specs: [BoxSpec], pose: Transform, anchored: Bool, shadow: Bool, visible: Bool, root: Entity) {
        remove(id)
        let group = BoxGroup(id: id)
        group.anchored = anchored
        group.shadow = shadow
        for spec in specs {
            let node = BoxNode(size: spec.size, look: spec.look)
            node.holder.transform = Transform(scale: .one, rotation: spec.rotation, translation: spec.position)
            node.holder.isEnabled = spec.visible
            buildParts(node, shadow: shadow)
            group.entity.addChild(node.holder)
            group.boxes.append(node)
        }
        group.entity.transform = pose
        group.entity.isEnabled = visible
        root.addChild(group.entity)
        groups[id] = group
        if anchored { anchor(group) }
    }

    /// Removes the group's entities and its ARKit anchor. Nothing else holds them, so they are freed.
    private func remove(_ id: String) {
        guard let group = groups.removeValue(forKey: id) else { return }
        group.entity.removeFromParent()
        if let anchor = group.anchor {
            session?.remove(anchor: anchor)
            anchorOwners[anchor.identifier] = nil
        }
        group.anchor = nil
        group.boxes.removeAll()
    }

    /// (Re)makes the drawn parts of a box for its style; the slow path (setGroup, style changes).
    private func buildParts(_ node: BoxNode, shadow: Bool) {
        for part in node.parts { part.removeFromParent() }
        node.parts.removeAll()
        let material = self.material(node.look)
        let count = node.look.style == .edges ? 12 : 1
        for _ in 0..<count {
            let part = ModelEntity(mesh: unitBox, materials: [material])
            if shadow { part.components.set(GroundingShadowComponent(castsShadow: true)) }
            node.holder.addChild(part)
            node.parts.append(part)
        }
        layout(node)
    }

    /// Positions and scales of the parts for the box's size (no new entities).
    private func layout(_ node: BoxNode) {
        if node.look.style == .edges {
            let bars = edgeBars(node.size, node.look.edge)
            for (part, bar) in zip(node.parts, bars) {
                part.position = bar.position
                part.scale = bar.scale
            }
        } else if let part = node.parts.first {
            part.position = .zero
            part.scale = node.size
        }
    }

    /// The 12 edges as bars `edge` thick, inside the box's outline. The bars along X run the full
    /// width; those along Y and Z stop short of the corners, so no two bars overlap (overlapping
    /// see-through bars would show darker corners).
    private func edgeBars(_ s: SIMD3<Float>, _ edge: Float) -> [(position: SIMD3<Float>, scale: SIMD3<Float>)] {
        let tiny: Float = 0.00001
        let e = max(tiny, min(edge, s.min() / 2))
        let hx = s.x / 2 - e / 2, hy = s.y / 2 - e / 2, hz = s.z / 2 - e / 2
        let ly = max(s.y - 2 * e, tiny), lz = max(s.z - 2 * e, tiny)
        var bars: [(position: SIMD3<Float>, scale: SIMD3<Float>)] = []
        bars.reserveCapacity(12)
        for a: Float in [-1, 1] {
            for b: Float in [-1, 1] {
                bars.append((SIMD3<Float>(0, a * hy, b * hz), SIMD3<Float>(s.x, e, e)))
                bars.append((SIMD3<Float>(a * hx, 0, b * hz), SIMD3<Float>(e, ly, e)))
                bars.append((SIMD3<Float>(a * hx, b * hy, 0), SIMD3<Float>(e, e, lz)))
            }
        }
        return bars
    }

    /// One material per look, made the first time it is needed. 'pbr' opaque is the stage-2
    /// furniture's SimpleMaterial, so the furniture looks exactly as before.
    private func material(_ look: BoxLook) -> any RealityKit.Material {
        let key = MaterialKey(look)
        if let cached = materials[key] { return cached }
        // A page that animates colours through the slow path must not grow this without bound.
        if materials.count >= 256 { materials.removeAll() }
        let color = UIColor(red: CGFloat(look.color.x), green: CGFloat(look.color.y), blue: CGFloat(look.color.z), alpha: 1)
        let seeThrough = look.opacity < 0.999
        let made: any RealityKit.Material
        switch look.material {
        case .occlusion:
            made = OcclusionMaterial()
        case .unlit:
            var m = UnlitMaterial(color: color)
            if seeThrough { m.blending = .transparent(opacity: .init(floatLiteral: look.opacity)) }
            made = m
        case .pbr:
            if seeThrough {
                var m = PhysicallyBasedMaterial()
                m.baseColor = .init(tint: color)
                m.roughness = .init(floatLiteral: look.roughness)
                m.metallic = .init(floatLiteral: look.metallic)
                m.blending = .transparent(opacity: .init(floatLiteral: look.opacity))
                made = m
            } else {
                var m = SimpleMaterial(color: color, roughness: .float(look.roughness), isMetallic: false)
                if look.metallic > 0 { m.metallic = .float(look.metallic) }
                made = m
            }
        }
        materials[key] = made
        return made
    }

    // MARK: updates

    /// Fast path: [i, px, py, pz, qx, qy, qz, qw] or [… , sx, sy, sz]. Only transforms change.
    private func applyRow(_ row: [NSNumber], to group: BoxGroup) -> Bool {
        guard row.count == 8 || row.count == 11 else { return false }
        let i = row[0].doubleValue
        guard i.isFinite, i >= 0, i < Double(group.boxes.count), i == i.rounded() else { return false }
        let node = group.boxes[Int(i)]
        let position = SIMD3<Float>(row[1].floatValue, row[2].floatValue, row[3].floatValue)
        guard allFinite(position), max(abs(position.x), abs(position.y), abs(position.z)) <= 10_000,
              let rotation = unitQuaternion(row[4].floatValue, row[5].floatValue, row[6].floatValue, row[7].floatValue) else {
            return false
        }
        var size = node.size
        if row.count == 11 {
            size = SIMD3<Float>(row[8].floatValue, row[9].floatValue, row[10].floatValue)
            guard validSize(size) else { return false }
        }
        node.holder.transform = Transform(scale: .one, rotation: rotation, translation: position)
        if size != node.size {
            node.size = size
            layout(node)
        }
        return true
    }

    /// Slow path: {i, position?, rotation?, size?, color?, opacity?, material?, style?, visible?}
    /// (also roughness?, metallic?, edge?). Everything is checked before anything changes.
    private func applyBoxObject(_ o: [String: Any], to group: BoxGroup) throws {
        guard let v = given(o, "i"), let i = number(v), i >= 0, i < Double(group.boxes.count), i == i.rounded() else {
            throw PayloadError("i: the index of a box in the group")
        }
        let node = group.boxes[Int(i)]
        let position = try optionalVector(o, "position")
        let rotation = try optionalQuaternion(o, "rotation")
        let size = try optionalVector(o, "size", limit: 1000)
        if let size, !validSize(size) { throw PayloadError("size: [w, h, d] > 0") }
        var look = node.look
        try look.apply(o)
        let visible = try optionalBool(o, "visible")

        if position != nil || rotation != nil {
            var t = node.holder.transform
            if let position { t.translation = position }
            if let rotation { t.rotation = rotation }
            t.scale = .one
            node.holder.transform = t
        }
        let resized = size != nil && size != node.size
        if let size { node.size = size }
        if look.style != node.look.style {
            node.look = look
            buildParts(node, shadow: group.shadow)
        } else {
            if look != node.look {
                let edgeChanged = look.edge != node.look.edge
                node.look = look
                let m = material(look)
                for part in node.parts { part.model?.materials = [m] }
                if edgeChanged { layout(node) }
            }
            if resized { layout(node) }
        }
        if let visible { node.holder.isEnabled = visible }
    }

    private func applyPose(_ change: PoseChange, to group: BoxGroup) {
        var t = group.entity.transform
        if let translation = change.translation { t.translation = translation }
        if let rotation = change.rotation { t.rotation = rotation }
        t.scale = .one
        group.entity.transform = t
        // An absolute pose re-anchors, so ARKit's next correction starts from here.
        if group.anchored { anchor(group) }
    }

    // MARK: parsing

    private func groupID(_ p: [String: Any]) throws -> String {
        guard let id = given(p, "id") as? String, !id.isEmpty, id.count <= 64 else {
            throw PayloadError("id: a non-empty string (at most 64 characters)")
        }
        return id
    }

    /// position? and rotation? | yaw? (rotation wins when both are given).
    private func poseChange(_ p: [String: Any]) throws -> PoseChange {
        var change = PoseChange()
        change.translation = try optionalVector(p, "position")
        if let rotation = try optionalQuaternion(p, "rotation") {
            change.rotation = rotation
        } else if let yaw = try optionalNumber(p, "yaw", limit: 1e4) {
            change.rotation = yawRotation(yaw)
        }
        return change
    }

    private func parseBox(_ b: [String: Any], index k: Int) throws -> BoxSpec {
        guard let size = try? optionalVector(b, "size", limit: 1000), validSize(size) else {
            throw PayloadError("box \(k): size [w, h, d], each > 0")
        }
        guard let position = try? optionalVector(b, "position") else {
            throw PayloadError("box \(k): position [x, y, z]")
        }
        do {
            let rotation = try optionalQuaternion(b, "rotation") ?? identityRotation
            var look = BoxLook()
            try look.apply(b)
            let visible = try optionalBool(b, "visible") ?? true
            return BoxSpec(size: size, position: position, rotation: rotation, look: look, visible: visible)
        } catch {
            throw PayloadError("box \(k): \(errorText(error))")
        }
    }

    private func validSize(_ s: SIMD3<Float>) -> Bool {
        allFinite(s) && s.x > 0 && s.y > 0 && s.z > 0 && s.max() <= 1000
    }

    private func limitHit(_ what: String) {
        if let held = limitLog.pass() {
            NativeLog.shared.log("groups: limit reached", level: "warn", data: [
                "limit": what, "groups": groups.count, "maxGroups": Self.maxGroups, "maxBoxes": Self.maxBoxes, "heldBack": held,
            ])
        }
    }

    /// updateGroups is usually fire-and-forget, so its problems only show up here.
    private func noteUpdateProblem(_ text: String, count: Int = 1) {
        if let held = updateLog.pass() {
            NativeLog.shared.log("groups: update skipped", level: "warn", data: ["problem": text, "count": count, "heldBack": held])
        }
    }
}

// MARK: - the pieces

private enum BoxMaterialKind: String {
    case pbr, unlit, occlusion
}

private enum BoxStyle: String {
    case solid, edges
}

private struct BoxLook: Equatable {
    var color = SIMD3<Float>(0.7, 0.55, 0.4)
    var opacity: Float = 1
    var material: BoxMaterialKind = .pbr
    var roughness: Float = 0.8
    var metallic: Float = 0
    var style: BoxStyle = .solid
    var edge: Float = 0.003

    /// The look keys present in `b`; values out of range are clamped, wrong kinds throw.
    mutating func apply(_ b: [String: Any]) throws {
        if let v = given(b, "color") {
            guard let c = vector(v) else { throw PayloadError("color: [r, g, b] 0..1") }
            color = c.clamped(lowerBound: .zero, upperBound: .one)
        }
        if let v = try optionalNumber(b, "opacity") { opacity = Float(min(max(v, 0), 1)) }
        if let v = try optionalString(b, "material") {
            guard let kind = BoxMaterialKind(rawValue: v) else { throw PayloadError("material: pbr, unlit or occlusion") }
            material = kind
        }
        if let v = try optionalNumber(b, "roughness") { roughness = Float(min(max(v, 0), 1)) }
        if let v = try optionalNumber(b, "metallic") { metallic = Float(min(max(v, 0), 1)) }
        if let v = try optionalString(b, "style") {
            guard let s = BoxStyle(rawValue: v) else { throw PayloadError("style: solid or edges") }
            style = s
        }
        if let v = try optionalNumber(b, "edge") {
            guard v > 0 else { throw PayloadError("edge: a thickness > 0") }
            edge = Float(min(v, 1))
        }
    }
}

/// Looks that would draw the same share one material. Colours to 1/1000.
private struct MaterialKey: Hashable {
    let kind: BoxMaterialKind
    let r: Int, g: Int, b: Int, opacity: Int, roughness: Int, metallic: Int

    init(_ look: BoxLook) {
        kind = look.material
        if look.material == .occlusion {
            r = 0; g = 0; b = 0; opacity = 0; roughness = 0; metallic = 0
        } else {
            r = Self.q(look.color.x)
            g = Self.q(look.color.y)
            b = Self.q(look.color.z)
            opacity = Self.q(look.opacity)
            roughness = look.material == .pbr ? Self.q(look.roughness) : 0
            metallic = look.material == .pbr ? Self.q(look.metallic) : 0
        }
    }

    /// Values are clamped to 0..1 before they get here, so this cannot trap.
    private static func q(_ v: Float) -> Int { Int((min(max(v, 0), 1) * 1000).rounded()) }
}

private struct BoxSpec {
    let size: SIMD3<Float>
    let position: SIMD3<Float>
    let rotation: simd_quatf
    let look: BoxLook
    let visible: Bool
}

private struct PoseChange {
    var translation: SIMD3<Float>?
    var rotation: simd_quatf?
}

@MainActor
private final class BoxGroup {
    let id: String
    let entity: Entity
    var boxes: [BoxNode] = []
    var anchored = false
    var shadow = false
    var anchor: ARAnchor?
    var anchorUpdates = 0
    var anchorShift: Float = 0

    init(id: String) {
        self.id = id
        self.entity = Entity()
    }
}

@MainActor
private final class BoxNode {
    /// The box's pose inside the group; never scaled, so 'edges' bars keep their thickness.
    let holder: Entity
    var size: SIMD3<Float>
    var look: BoxLook
    var parts: [ModelEntity] = []

    init(size: SIMD3<Float>, look: BoxLook) {
        self.holder = Entity()
        self.size = size
        self.look = look
    }
}
