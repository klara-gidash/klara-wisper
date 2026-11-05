import CoreAudio
import Foundation

/// Small typed wrappers over AudioObjectGetPropertyData.
enum CA {
    static let system = AudioObjectID(kAudioObjectSystemObject)

    static func addr(
        _ sel: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
        _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: element)
    }

    static func value<T>(
        _ obj: AudioObjectID, _ sel: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, initial: T
    ) -> T? {
        var a = addr(sel, scope)
        var v = initial
        var size = UInt32(MemoryLayout<T>.size)
        return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : nil
    }

    static func ids(
        _ obj: AudioObjectID, _ sel: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> [AudioObjectID] {
        var a = addr(sel, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(obj, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
        var out = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &out) == noErr else { return [] }
        return Array(out.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    static func string(
        _ obj: AudioObjectID, _ sel: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> String? {
        var a = addr(sel, scope)
        var ref: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let st = withUnsafeMutablePointer(to: &ref) { AudioObjectGetPropertyData(obj, &a, 0, nil, &size, $0) }
        guard st == noErr, let r = ref else { return nil }
        return r.takeRetainedValue() as String
    }

    static func inputChannels(_ dev: AudioObjectID) -> Int {
        var a = addr(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(dev, &a, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(dev, &a, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    /// Format of the first input stream of a device (what its IOProc delivers).
    static func inputFormat(_ dev: AudioObjectID) -> AudioStreamBasicDescription? {
        if let stream = ids(dev, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput).first,
           let f = value(stream, kAudioStreamPropertyVirtualFormat, initial: AudioStreamBasicDescription()) {
            return f
        }
        return value(dev, kAudioDevicePropertyStreamFormat, scope: kAudioObjectPropertyScopeInput, initial: AudioStreamBasicDescription())
    }

    static func listen(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ block: @escaping () -> Void) {
        var a = addr(sel)
        AudioObjectAddPropertyListenerBlock(obj, &a, DispatchQueue.main) { _, _ in block() }
    }
}
