import AVFoundation
import CoreAudio
import Foundation

/// Captures one CoreAudio input device (a microphone, or the aggregate device of a process tap),
/// mixes it down to mono and delivers 16 kHz Int16 chunks of 50 ms with their level in dBFS.
final class AudioInput {
    static let chunkSamples = 800

    let deviceID: AudioObjectID
    var onChunk: (([Int16], Float) -> Void)?

    private let queue: DispatchQueue
    private var procID: AudioDeviceIOProcID?
    private let inFormat: AVAudioFormat
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    private let converter: AVAudioConverter
    private let bytesPerSample: Int
    private let isFloat: Bool
    private var pending: [Int16] = []

    init(deviceID: AudioObjectID, label: String, format: AudioStreamBasicDescription? = nil) throws {
        self.deviceID = deviceID
        queue = DispatchQueue(label: "audio.\(label)", qos: .userInteractive)
        guard let asbd = format ?? CA.inputFormat(deviceID), asbd.mSampleRate > 0 else {
            throw HelperError("device \(deviceID) has no input format")
        }
        bytesPerSample = max(Int(asbd.mBitsPerChannel / 8), 2)
        isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: asbd.mSampleRate, channels: 1, interleaved: false)!
        guard let conv = AVAudioConverter(from: inFormat, to: outFormat) else { throw HelperError("no converter") }
        conv.sampleRateConverterQuality = AVAudioQuality.high.rawValue
        converter = conv
    }

    deinit { stop() }

    func start() throws {
        var pid: AudioDeviceIOProcID?
        let st = AudioDeviceCreateIOProcIDWithBlock(&pid, deviceID, queue) { [weak self] _, inData, _, _, _ in
            self?.process(inData)
        }
        guard st == noErr, let pid else { throw HelperError("cannot open device \(deviceID) (\(st))") }
        procID = pid
        let started = AudioDeviceStart(deviceID, pid)
        guard started == noErr else {
            AudioDeviceDestroyIOProcID(deviceID, pid)
            procID = nil
            throw HelperError("cannot start device \(deviceID) (\(started))")
        }
    }

    func stop() {
        guard let pid = procID else { return }
        AudioDeviceStop(deviceID, pid)
        AudioDeviceDestroyIOProcID(deviceID, pid)
        procID = nil
        queue.sync { pending.removeAll() }
    }

    private func process(_ data: UnsafePointer<AudioBufferList>) {
        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: data))
        guard let first = list.first, first.mDataByteSize > 0 else { return }
        let frames = Int(first.mDataByteSize) / (bytesPerSample * max(Int(first.mNumberChannels), 1))
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buf.frameLength = AVAudioFrameCount(frames)
        let mono = buf.floatChannelData![0]
        mono.initialize(repeating: 0, count: frames)

        var channels = 0
        for b in list {
            guard let p = b.mData else { continue }
            let ch = max(Int(b.mNumberChannels), 1)
            let n = min(frames, Int(b.mDataByteSize) / (bytesPerSample * ch))
            switch (isFloat, bytesPerSample) {
            case (true, 4):
                let s = p.assumingMemoryBound(to: Float.self)
                for i in 0..<n { for c in 0..<ch { mono[i] += s[i * ch + c] } }
            case (false, 2):
                let s = p.assumingMemoryBound(to: Int16.self)
                for i in 0..<n { for c in 0..<ch { mono[i] += Float(s[i * ch + c]) / 32768 } }
            case (false, 4):
                let s = p.assumingMemoryBound(to: Int32.self)
                for i in 0..<n { for c in 0..<ch { mono[i] += Float(s[i * ch + c]) / 2_147_483_648 } }
            default:
                continue
            }
            channels += ch
        }
        if channels > 1 {
            let k = 1 / Float(channels)
            for i in 0..<frames { mono[i] *= k }
        }
        convert(buf)
    }

    private func convert(_ input: AVAudioPCMBuffer) {
        let capacity = AVAudioFrameCount(Double(input.frameLength) * outFormat.sampleRate / inFormat.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, out.frameLength > 0, let p = out.int16ChannelData?[0] else { return }
        pending.append(contentsOf: UnsafeBufferPointer(start: p, count: Int(out.frameLength)))
        let size = AudioInput.chunkSamples
        while pending.count >= size {
            let part = Array(pending[0..<size])
            pending.removeFirst(size)
            onChunk?(part, dbfs(part))
        }
    }
}

func dbfs(_ samples: [Int16]) -> Float {
    guard !samples.isEmpty else { return -120 }
    var sum: Double = 0
    for s in samples { sum += Double(s) * Double(s) }
    let rms = sqrt(sum / Double(samples.count)) / 32768
    return Float(max(20 * log10(rms + 1e-9), -120))
}
