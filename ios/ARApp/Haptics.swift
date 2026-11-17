import UIKit

// A tap of the vibration motor (docs/protocol.md §9), e.g. when the hand touches a virtual object.
// Works without AR. The generators are kept and prepared again after each use, so the next tap
// comes without the motor's start-up delay.
@MainActor
enum Haptics {
    private static var impacts: [UIImpactFeedbackGenerator.FeedbackStyle: UIImpactFeedbackGenerator] = [:]
    private static var selection: UISelectionFeedbackGenerator?
    private static var notification: UINotificationFeedbackGenerator?
    private static let keys: Set<String> = ["kind", "style", "intensity"]

    /// haptic {kind?: 'impact' | 'selection' | 'success' | 'warning' | 'error',
    ///         style?: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid', intensity?: 1} → {ok}
    static func play(_ p: [String: Any]) -> [String: Any] {
        logUnknownKeys(p, known: keys, in: "haptic")
        let kind = (given(p, "kind") as? String) ?? "impact"
        switch kind {
        case "impact":
            let name = (given(p, "style") as? String) ?? "medium"
            guard let style = impactStyle(name) else { return ["error": "style: light, medium, heavy, soft or rigid"] }
            var intensity = 1.0
            if let v = given(p, "intensity") {
                guard let n = number(v) else { return ["error": "intensity: a number 0..1"] }
                intensity = min(max(n, 0), 1)
            }
            let generator = impacts[style] ?? UIImpactFeedbackGenerator(style: style)
            impacts[style] = generator
            generator.impactOccurred(intensity: CGFloat(intensity))
            generator.prepare()
        case "selection":
            let generator = selection ?? UISelectionFeedbackGenerator()
            selection = generator
            generator.selectionChanged()
            generator.prepare()
        case "success", "warning", "error":
            let generator = notification ?? UINotificationFeedbackGenerator()
            notification = generator
            let type: UINotificationFeedbackGenerator.FeedbackType = kind == "success" ? .success : (kind == "warning" ? .warning : .error)
            generator.notificationOccurred(type)
            generator.prepare()
        default:
            return ["error": "kind: impact, selection, success, warning or error"]
        }
        return ["ok": true]
    }

    private static func impactStyle(_ name: String) -> UIImpactFeedbackGenerator.FeedbackStyle? {
        switch name {
        case "light": return .light
        case "medium": return .medium
        case "heavy": return .heavy
        case "soft": return .soft
        case "rigid": return .rigid
        default: return nil
        }
    }
}
