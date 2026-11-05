import CoreAudio
import Foundation

/// "Which microphone am I talking into?" Opens every candidate input at once for a moment
/// and ranks them by how loud and how much speech-like signal each one picked up.
enum Scanner {
    /// Candidates: physical inputs. Bluetooth headsets only when already the default input,
    /// because opening their mic switches them into low-quality call mode.
    static func candidates() -> [AudioDevice] {
        let def = Devices.defaultInput()
        return Devices.inputs().filter { d in
            !d.isVirtual && (d.transport != "bluetooth" || d.id == def)
        }
    }

    static func scan(durationMs: Int, done: @escaping ([[String: Any]]) -> Void) {
        let devices = candidates()
        let lock = NSLock()
        var levels: [AudioObjectID: [Float]] = [:]
        var opened: [AudioInput] = []
        for d in devices {
            guard let input = try? AudioInput(deviceID: d.id, label: "scan\(d.id)") else { continue }
            input.onChunk = { _, db in
                lock.lock()
                levels[d.id, default: []].append(db)
                lock.unlock()
            }
            if (try? input.start()) != nil { opened.append(input) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(durationMs)) {
            opened.forEach { $0.stop() }
            lock.lock()
            let snapshot = levels
            lock.unlock()
            let rows = devices.map { d -> [String: Any] in
                let dbs = (snapshot[d.id] ?? []).sorted()
                guard dbs.count >= 4 else {
                    return ["uid": d.uid, "name": d.name, "transport": d.transport, "score": -999.0, "speech": 0.0, "peakDb": -120.0, "floorDb": -120.0]
                }
                let floor = dbs[dbs.count / 10]
                let peak = dbs[min(dbs.count - 1, Int(Double(dbs.count) * 0.9))]
                let speech = Double(dbs.filter { $0 > max(floor + 12, -55) }.count) / Double(dbs.count)
                let score = Double(peak) + 40 * speech
                return ["uid": d.uid, "name": d.name, "transport": d.transport, "score": score, "speech": speech,
                        "peakDb": Double(peak), "floorDb": Double(floor)]
            }.sorted { ($0["score"] as? Double ?? -999) > ($1["score"] as? Double ?? -999) }
            _ = opened  // keep inputs alive until here
            done(rows)
        }
    }
}
