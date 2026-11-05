import AVFoundation
import Foundation

/// Turns the raw 16 kHz Int16 recordings of a meeting into one AAC file
/// (channel 1 = my mic, channel 2 = the other side, when there are two).
enum Encoder {
    static func encode(inputs: [String], output: String) throws -> Double {
        let files = try inputs.map { try Data(contentsOf: URL(fileURLWithPath: $0), options: .alwaysMapped) }
        guard !files.isEmpty else { throw HelperError("no inputs") }
        let channels = files.count
        let frames = files.map { $0.count / 2 }.max() ?? 0
        let url = URL(fileURLWithPath: output)
        try? FileManager.default.removeItem(at: url)

        var settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRatePerChannelKey: 32000,
        ]
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            settings.removeValue(forKey: AVEncoderBitRatePerChannelKey)
            file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000,
                                         channels: AVAudioChannelCount(channels), interleaved: false) else {
            throw HelperError("bad format")
        }
        let block = 16000 * 10
        var pos = 0
        while pos < frames {
            let n = min(block, frames - pos)
            guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)) else { break }
            buf.frameLength = AVAudioFrameCount(n)
            for (c, data) in files.enumerated() {
                let dst = buf.floatChannelData![c]
                data.withUnsafeBytes { raw in
                    let src = raw.bindMemory(to: Int16.self)
                    for i in 0..<n {
                        let j = pos + i
                        dst[i] = j < src.count ? Float(Int16(littleEndian: src[j])) / 32768 : 0
                    }
                }
            }
            try file.write(from: buf)
            pos += n
        }
        return Double(frames) / 16000
    }
}
