// FakeZoom: holds the default microphone for N seconds so Klara Wisper sees a "Zoom" call.
// Bundle id (embedded Info.plist) is us.zoom.xos.klaratest, which the detector prefix-matches as Zoom.
// Usage: FakeZoom [seconds]   (default 150)
import AVFoundation
import Foundation

setvbuf(stdout, nil, _IONBF, 0)
let seconds = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 150
print("FakeZoom (\(Bundle.main.bundleIdentifier ?? "no bundle id")) - holding the mic for \(Int(seconds)) s")

func requestMic() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined:
        print("Asking for microphone permission...")
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        AVCaptureDevice.requestAccess(for: .audio) { ok = $0; sem.signal() }
        sem.wait()
        return ok
    default: return false
    }
}

guard requestMic() else {
    print("ERROR: microphone permission denied. Allow it in System Settings > Privacy & Security > Microphone (for Terminal / FakeZoom).")
    exit(1)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
var buffers = 0
input.installTap(onBus: 0, bufferSize: 4096, format: format) { _, _ in buffers += 1 }  // discard audio
do {
    try engine.start()
} catch {
    print("ERROR: could not start the microphone: \(error)")
    exit(2)
}
print("Mic open (\(Int(format.sampleRate)) Hz, \(format.channelCount) ch). Klara Wisper should now detect a Zoom call.")

let start = Date()
while Date().timeIntervalSince(start) < seconds {
    Thread.sleep(forTimeInterval: 10)
    let left = max(0, Int(seconds - Date().timeIntervalSince(start)))
    print("  still holding the mic - \(left) s left (buffers: \(buffers))")
}
input.removeTap(onBus: 0)
engine.stop()
print("Mic released. FakeZoom done.")
