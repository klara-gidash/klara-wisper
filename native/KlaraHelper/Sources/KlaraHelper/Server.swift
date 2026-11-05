import AVFoundation
import AppKit
import CoreAudio
import Foundation

/// `KlaraHelper serve`: the long-running helper the Electron app talks to over stdin/stdout.
final class Server {
    private let calendar = CalendarSource()
    private let watcher = MeetingWatcher()
    private let hotkey = Hotkey()
    private var mic: AudioInput?
    private var micDevice: AudioDevice?
    private var tap: SystemTap?
    private var tapPrefixes: [String] = []
    private var tapOutputUID: String?
    private let encodeQueue = DispatchQueue(label: "encode")

    func run() -> Never {
        Devices.watch { [weak self] in self?.devicesChanged() }
        IPC.readCommands { [weak self] cmd in self?.handle(cmd) }
        IPC.event("hello", [
            "version": "0.1.0", "pid": Int(getpid()),
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "permissions": Permissions.status(calendar: calendar),
        ])
        RunLoop.main.run()
        exit(0)
    }

    private func devicesChanged() {
        IPC.event("devices", Devices.snapshot())
        // A tap is bound to the output device it started on; follow the user to new headphones.
        // (Creating the tap's own aggregate device also fires this, so compare the output first.)
        guard tap != nil, let out = Devices.defaultOutput(), let uid = CA.string(out, kAudioDevicePropertyDeviceUID),
              uid != tapOutputUID else { return }
        restartTap()
    }

    private func handle(_ cmd: [String: Any]) {
        let id = cmd["id"]
        let name = cmd["cmd"] as? String ?? ""
        do {
            switch name {
            case "ping":
                IPC.reply(id)
            case "devices":
                IPC.reply(id, Devices.snapshot())
            case "scan":
                let ms = cmd["durationMs"] as? Int ?? 2500
                if mic != nil { throw HelperError("cannot scan while recording") }
                Scanner.scan(durationMs: ms) { rows in IPC.reply(id, ["results": rows]) }
            case "startMic":
                let uid = cmd["uid"] as? String
                switch AVCaptureDevice.authorizationStatus(for: .audio) {
                case .notDetermined:
                    // Opening the device before the user answers the prompt would just record silence.
                    AVCaptureDevice.requestAccess(for: .audio) { granted in
                        DispatchQueue.main.async {
                            do {
                                guard granted else { throw HelperError("microphone permission denied") }
                                IPC.reply(id, try self.startMic(uid: uid))
                            } catch {
                                IPC.fail(id, error)
                            }
                        }
                    }
                case .denied, .restricted:
                    throw HelperError("microphone permission denied")
                default:
                    IPC.reply(id, try startMic(uid: uid))
                }
            case "stopMic":
                mic?.stop()
                mic = nil
                micDevice = nil
                IPC.reply(id)
            case "startSystem":
                tapPrefixes = cmd["bundlePrefixes"] as? [String] ?? []
                IPC.reply(id, try startTap())
            case "stopSystem":
                tap?.stop()
                tap = nil
                tapOutputUID = nil
                IPC.reply(id)
            case "watchMeetings":
                (cmd["enabled"] as? Bool ?? true) ? watcher.start() : watcher.stop()
                IPC.reply(id)
            case "setHotkey":
                if let k = cmd["key"] as? String, let key = Hotkey.Key(rawValue: k) { hotkey.key = key }
                let ok = hotkey.start()
                IPC.reply(id, ["running": ok, "key": hotkey.key.rawValue])
            case "armEscape":
                hotkey.armEscape = cmd["value"] as? Bool ?? false
                IPC.reply(id)
            case "paste":
                let ok = Paster.paste(cmd["text"] as? String ?? "", restoreClipboard: cmd["restore"] as? Bool ?? true)
                if !ok { Paster.copy(cmd["text"] as? String ?? "") }
                IPC.reply(id, ["pasted": ok])
            case "frontmostApp":
                let app = NSWorkspace.shared.frontmostApplication
                IPC.reply(id, ["bundleID": app?.bundleIdentifier ?? "", "name": app?.localizedName ?? ""])
            case "permissions":
                IPC.reply(id, Permissions.status(calendar: calendar))
            case "requestPermission":
                Permissions.request(cmd["kind"] as? String ?? "", bundleID: cmd["bundleID"] as? String, calendar: calendar) { r in
                    IPC.reply(id, ["result": r])
                }
            case "calendarEvents":
                let from = (cmd["from"] as? String).flatMap(isoFormatter.date(from:)) ?? Date()
                let to = (cmd["to"] as? String).flatMap(isoFormatter.date(from:)) ?? from.addingTimeInterval(86400)
                IPC.reply(id, ["events": calendar.events(from: from, to: to), "status": calendar.status()])
            case "tabs":
                let bundle = cmd["bundleID"] as? String ?? "com.google.Chrome"
                DispatchQueue.global().async { IPC.reply(id, ["tabs": BrowserTabs.tabs(of: bundle) ?? []]) }
            case "encode":
                let inputs = cmd["inputs"] as? [String] ?? []
                let output = cmd["output"] as? String ?? ""
                encodeQueue.async {
                    do { IPC.reply(id, ["seconds": try Encoder.encode(inputs: inputs, output: output)]) }
                    catch { IPC.fail(id, error) }
                }
            case "openSettings":
                let pane = cmd["pane"] as? String ?? ""
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
                    NSWorkspace.shared.open(url)
                }
                IPC.reply(id)
            default:
                throw HelperError("unknown command \(name)")
            }
        } catch {
            IPC.fail(id, error)
        }
    }

    private func startMic(uid: String?) throws -> [String: Any] {
        mic?.stop()
        let device: AudioDevice
        if let uid, let d = Devices.byUID(uid) {
            device = d
        } else if let def = Devices.defaultInput(), let d = Devices.inputs().first(where: { $0.id == def }) {
            device = d
        } else {
            throw HelperError("no microphone")
        }
        let input = try AudioInput(deviceID: device.id, label: "mic")
        input.onChunk = { samples, db in Server.emitAudio("mic", samples, db) }
        try input.start()
        mic = input
        micDevice = device
        return ["device": device.dict]
    }

    private func startTap() throws -> [String: Any] {
        tap?.stop()
        let objects = tapPrefixes.isEmpty ? [] : Processes.objects(matching: tapPrefixes)
        let t = try SystemTap(processes: objects)
        t.input?.onChunk = { samples, db in Server.emitAudio("system", samples, db) }
        try t.start()
        tap = t
        tapOutputUID = Devices.defaultOutput().flatMap { CA.string($0, kAudioDevicePropertyDeviceUID) }
        return ["scope": t.scope, "processes": objects.count]
    }

    private func restartTap() {
        do {
            let info = try startTap()
            IPC.event("systemRestarted", info)
        } catch {
            IPC.event("error", ["message": "system audio: \(error)"])
        }
    }

    static func emitAudio(_ stream: String, _ samples: [Int16], _ db: Float) {
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        IPC.event("audio", ["stream": stream, "pcm": data.base64EncodedString(), "db": (Double(db) * 10).rounded() / 10])
    }
}
