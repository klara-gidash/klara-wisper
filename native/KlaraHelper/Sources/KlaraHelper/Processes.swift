import AppKit
import CoreAudio
import Foundation

/// Processes known to the audio server (macOS 14+): who is recording, who is playing.
enum Processes {
    struct AudioProcess {
        let object: AudioObjectID
        let pid: pid_t
        let bundleID: String
        let name: String
        let input: Bool
        let output: Bool
        let inputDevices: [AudioObjectID]

        var dict: [String: Any] {
            let uids = inputDevices.compactMap { CA.string($0, kAudioDevicePropertyDeviceUID) }
            return ["pid": Int(pid), "bundleID": bundleID, "name": name, "input": input, "output": output, "inputDevices": uids]
        }
    }

    static func processObject(pid: pid_t) -> AudioObjectID? {
        var a = CA.addr(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var p = pid
        var obj = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let st = AudioObjectGetPropertyData(CA.system, &a, UInt32(MemoryLayout<pid_t>.size), &p, &size, &obj)
        return st == noErr && obj != kAudioObjectUnknown ? obj : nil
    }

    static func list() -> [AudioProcess] {
        let me = getpid()
        return CA.ids(CA.system, kAudioHardwarePropertyProcessObjectList).compactMap { obj in
            let pid = CA.value(obj, kAudioProcessPropertyPID, initial: pid_t(-1)) ?? -1
            guard pid > 0, pid != me else { return nil }
            let bundle = CA.string(obj, kAudioProcessPropertyBundleID) ?? ""
            let input = (CA.value(obj, kAudioProcessPropertyIsRunningInput, initial: UInt32(0)) ?? 0) != 0
            let output = (CA.value(obj, kAudioProcessPropertyIsRunningOutput, initial: UInt32(0)) ?? 0) != 0
            let devices = input ? CA.ids(obj, kAudioProcessPropertyDevices, scope: kAudioObjectPropertyScopeInput) : []
            let app = NSRunningApplication(processIdentifier: pid)
            return AudioProcess(object: obj, pid: pid, bundleID: bundle, name: app?.localizedName ?? bundle,
                                input: input, output: output, inputDevices: devices)
        }
    }

    /// Audio process objects whose bundle ID starts with any of the prefixes (an app and its helpers).
    static func objects(matching prefixes: [String]) -> [AudioObjectID] {
        list().filter { p in prefixes.contains { p.bundleID.hasPrefix($0) } }.map(\.object)
    }
}
