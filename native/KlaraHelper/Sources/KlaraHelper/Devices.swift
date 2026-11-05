import CoreAudio
import Foundation

struct AudioDevice {
    let id: AudioObjectID
    let uid: String
    let name: String
    let transport: String
    let inputChannels: Int
    let outputChannels: Int

    /// Virtual or aggregate inputs (Zoom's, Teams', BlackHole…) never carry the user's voice directly.
    var isVirtual: Bool {
        if transport == "virtual" || transport == "aggregate" { return true }
        let n = name.lowercased()
        return Devices.virtualNames.contains { n.contains($0) }
    }

    var dict: [String: Any] {
        [
            "id": Int(id), "uid": uid, "name": name, "transport": transport,
            "inputChannels": inputChannels, "outputChannels": outputChannels, "virtual": isVirtual,
        ]
    }
}

enum Devices {
    static let virtualNames = [
        "zoomaudiodevice", "zoom audio", "microsoft teams audio", "teams audio", "blackhole", "loopback",
        "soundflower", "krisp", "klara wisper", "cadefault", "background music",
    ]

    static func all() -> [AudioDevice] {
        CA.ids(CA.system, kAudioHardwarePropertyDevices).compactMap { id in
            guard let uid = CA.string(id, kAudioDevicePropertyDeviceUID), !uid.hasPrefix("io.klara.wisper.tap") else { return nil }
            let name = CA.string(id, kAudioObjectPropertyName) ?? uid
            let t = CA.value(id, kAudioDevicePropertyTransportType, initial: UInt32(0)) ?? 0
            let outCh: Int = {
                var a = CA.addr(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput)
                var size: UInt32 = 0
                return AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size) == noErr && size > 8 ? 1 : 0
            }()
            return AudioDevice(id: id, uid: uid, name: name, transport: transportName(t),
                               inputChannels: CA.inputChannels(id), outputChannels: outCh)
        }
    }

    static func inputs() -> [AudioDevice] { all().filter { $0.inputChannels > 0 } }

    static func byUID(_ uid: String) -> AudioDevice? { all().first { $0.uid == uid } }

    static func defaultInput() -> AudioObjectID? {
        CA.value(CA.system, kAudioHardwarePropertyDefaultInputDevice, initial: AudioObjectID(0)).flatMap { $0 == 0 ? nil : $0 }
    }

    static func defaultOutput() -> AudioObjectID? {
        CA.value(CA.system, kAudioHardwarePropertyDefaultOutputDevice, initial: AudioObjectID(0)).flatMap { $0 == 0 ? nil : $0 }
    }

    static func transportName(_ t: UInt32) -> String {
        switch t {
        case kAudioDeviceTransportTypeBuiltIn: return "builtin"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
        case kAudioDeviceTransportTypeUSB: return "usb"
        case kAudioDeviceTransportTypeVirtual: return "virtual"
        case kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeAutoAggregate: return "aggregate"
        case kAudioDeviceTransportTypeContinuityCaptureWired, kAudioDeviceTransportTypeContinuityCaptureWireless: return "continuity"
        case kAudioDeviceTransportTypeDisplayPort, kAudioDeviceTransportTypeHDMI: return "display"
        case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt"
        default: return "other"
        }
    }

    static func snapshot() -> [String: Any] {
        let def = defaultInput()
        let out = defaultOutput()
        return [
            "inputs": inputs().map { d -> [String: Any] in
                var row = d.dict
                row["isDefault"] = d.id == def
                return row
            },
            "defaultInput": inputs().first { $0.id == def }?.uid ?? NSNull(),
            "defaultOutput": all().first { $0.id == out }.map { $0.dict } ?? NSNull(),
        ]
    }

    /// Calls `onChange` (on main) when devices are plugged/unplugged or defaults change.
    static func watch(_ onChange: @escaping () -> Void) {
        for sel in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice] {
            CA.listen(CA.system, sel, onChange)
        }
    }
}
