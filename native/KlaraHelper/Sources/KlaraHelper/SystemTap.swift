import CoreAudio
import Foundation

/// Records what other apps play (the other side of a call) with a Core Audio process tap
/// (macOS 14.2+). No virtual driver; needs the "System Audio Recording" permission.
final class SystemTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private(set) var input: AudioInput?
    let scope: String

    /// - Parameter processes: audio process objects to record; empty = everything except this app.
    init(processes: [AudioObjectID]) throws {
        let desc: CATapDescription
        if processes.isEmpty {
            let own = Processes.processObject(pid: getpid()).map { [$0] } ?? []
            desc = CATapDescription(stereoGlobalTapButExcludeProcesses: own)
            scope = "global"
        } else {
            desc = CATapDescription(stereoMixdownOfProcesses: processes)
            scope = "processes"
        }
        desc.uuid = UUID()
        desc.name = "Klara Wisper"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted

        var st = AudioHardwareCreateProcessTap(desc, &tapID)
        guard st == noErr else { throw HelperError("cannot create audio tap (\(st)); is System Audio Recording allowed?") }

        guard let out = Devices.defaultOutput(), let outUID = CA.string(out, kAudioDevicePropertyDeviceUID) else {
            AudioHardwareDestroyProcessTap(tapID)
            throw HelperError("no output device")
        }
        let config: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Klara Wisper Tap",
            kAudioAggregateDeviceUIDKey: "io.klara.wisper.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        st = AudioHardwareCreateAggregateDevice(config as CFDictionary, &aggregateID)
        guard st == noErr else {
            AudioHardwareDestroyProcessTap(tapID)
            throw HelperError("cannot create tap device (\(st))")
        }
        let tapFormat = CA.value(tapID, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
        do {
            input = try AudioInput(deviceID: aggregateID, label: "system", format: tapFormat)
        } catch {
            teardown()
            throw error
        }
    }

    func start() throws { try input?.start() }

    func stop() {
        input?.stop()
        input = nil
        teardown()
    }

    private func teardown() {
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    deinit { stop() }
}
