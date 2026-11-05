import ApplicationServices
import Foundation

/// Global push-to-talk key (Fn/🌐 by default) through a listen-only event tap.
/// Needs Input Monitoring. Emits hotkey down/up, "chord" when another key is pressed while held
/// (e.g. Fn+arrow, so dictation can be cancelled), and Escape while armed.
final class Hotkey {
    enum Key: String {
        case fn, rightOption, rightCommand, rightControl
    }

    var key: Key = .fn
    var armEscape = false
    private var tap: CFMachPort?
    private var isDown = false

    var running: Bool { tap != nil }

    func start() -> Bool {
        if tap != nil { return true }
        let mask: CGEventMask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let me = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask,
            callback: { _, type, event, info in
                if let info { Unmanaged<Hotkey>.fromOpaque(info).takeUnretainedValue().handle(type, event) }
                return Unmanaged.passUnretained(event)
            },
            userInfo: me
        ) else { return false }
        self.tap = tap
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    private var watched: (codes: Set<Int64>, flag: CGEventFlags) {
        switch key {
        case .fn: return ([63, 179], .maskSecondaryFn)
        case .rightOption: return ([61], .maskAlternate)
        case .rightCommand: return ([54], .maskCommand)
        case .rightControl: return ([62], .maskControl)
        }
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if type == .flagsChanged {
            let w = watched
            guard w.codes.contains(code) else { return }
            let down = event.flags.contains(w.flag)
            if down != isDown {
                isDown = down
                IPC.event("hotkey", ["state": down ? "down" : "up"])
            }
        } else if type == .keyDown {
            if code == 53 && armEscape {
                IPC.event("key", ["key": "escape"])
            } else if isDown {
                IPC.event("hotkey", ["state": "chord"])
            }
        }
    }
}
