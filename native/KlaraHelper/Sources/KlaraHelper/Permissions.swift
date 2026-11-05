import AVFoundation
import ApplicationServices
import CoreServices
import Foundation

enum Permissions {
    static func microphone() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    static func status(calendar: CalendarSource) -> [String: Any] {
        [
            "microphone": microphone(),
            "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
            "inputMonitoring": CGPreflightListenEventAccess() ? "granted" : "denied",
            "calendar": calendar.status(),
        ]
    }

    /// Asks macOS for a permission (shows the system prompt or opens the right Settings pane).
    static func request(_ kind: String, bundleID: String?, calendar: CalendarSource, done: @escaping (String) -> Void) {
        switch kind {
        case "microphone":
            AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { done(ok ? "granted" : "denied") } }
        case "accessibility":
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            done(AXIsProcessTrustedWithOptions(opts) ? "granted" : "denied")
        case "inputMonitoring":
            done(CGRequestListenEventAccess() ? "granted" : "denied")
        case "calendar":
            calendar.request { done($0 ? "granted" : "denied") }
        case "systemAudio":
            // There is no API to ask; the first tap shows the prompt.
            do {
                let tap = try SystemTap(processes: [])
                try tap.start()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { tap.stop(); done("requested") }
            } catch {
                done("denied")
            }
        case "automation":
            guard let bundleID else { return done("unknown") }
            DispatchQueue.global().async {
                let r = automation(bundleID: bundleID, ask: true)
                DispatchQueue.main.async { done(r) }
            }
        default:
            done("unknown")
        }
    }

    static func automation(bundleID: String, ask: Bool) -> String {
        guard BrowserTabs.isRunning(bundleID) else { return "notRunning" }
        var target = AEAddressDesc()
        let created = bundleID.withCString { AECreateDesc(typeApplicationBundleID, $0, strlen($0), &target) }
        guard created == noErr else { return "unknown" }
        defer { AEDisposeDesc(&target) }
        switch AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, ask) {
        case noErr: return "granted"
        case OSStatus(errAEEventNotPermitted): return "denied"
        case OSStatus(errAEEventWouldRequireUserConsent): return "notDetermined"
        case OSStatus(procNotFound): return "notRunning"
        default: return "unknown"
        }
    }
}
