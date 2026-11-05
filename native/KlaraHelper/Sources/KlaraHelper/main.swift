import AppKit
import Foundation

signal(SIGPIPE, SIG_IGN)

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "serve"

#if !DEBUG
// Release builds only do what the app needs: `serve`, and only for the Klara Wisper app itself.
// The test commands below (record the mic, the system audio, read the calendar…) would let any
// other program use this helper's permissions, so they exist only in debug builds.
guard command == "serve" else {
    FileHandle.standardError.write(Data("KlaraHelper: only `serve` is available\n".utf8))
    exit(2)
}
if ProcessInfo.processInfo.environment["KLARA_DISCLAIMED"] == nil {
    guard ParentCheck.launchedByKlaraWisper() else {
        FileHandle.standardError.write(Data("KlaraHelper: must be started by Klara Wisper\n".utf8))
        exit(77)
    }
}
#endif

// Permission-sensitive commands run as their own responsible process (see Disclaim.swift).
if command != "list-devices" && command != "processes" {
    Disclaim.reexecIfNeeded()
}

func writeWAV(_ samples: [Int16], to path: String) {
    var d = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + samples.count * 2)); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
    d.append(contentsOf: Array("data".utf8)); u32(UInt32(samples.count * 2))
    samples.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
    try? d.write(to: URL(fileURLWithPath: path))
}

/// Records `seconds` from an input (mic or system tap) and prints the level every half second.
func recordTest(stream: String, seconds: Double, out: String?, makeInput: () throws -> (AudioInput, () -> Void)) {
    do {
        let (input, cleanup) = try makeInput()
        var all: [Int16] = []
        var window: [Int16] = []
        let lock = NSLock()
        input.onChunk = { s, _ in
            lock.lock(); all += s; window += s
            if window.count >= 8000 { print(String(format: "%@ level %.1f dBFS", stream, dbfs(window))); window.removeAll() }
            lock.unlock()
        }
        try input.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            input.stop(); cleanup()
            lock.lock(); let samples = all; lock.unlock()
            print(String(format: "captured %.1fs, overall %.1f dBFS", Double(samples.count) / 16000, dbfs(samples)))
            if let out { writeWAV(samples, to: out); print("wrote \(out)") }
            exit(0)
        }
        RunLoop.main.run()
    } catch {
        print("error: \(error)")
        exit(1)
    }
}

if command == "serve" {
    let server = Server()  // global: kept alive for the whole run
    server.run()
}

#if DEBUG
switch command {

case "list-devices":
    printJSON(Devices.snapshot())

case "processes":
    printJSON(Processes.list().map(\.dict))

case "scan":
    print("Scanning microphones for 3 seconds, please speak…")
    Scanner.scan(durationMs: 3000) { rows in printJSON(rows); exit(0) }
    RunLoop.main.run()

case "mic-test":
    let seconds = Double(args.dropFirst().first ?? "5") ?? 5
    recordTest(stream: "mic", seconds: seconds, out: args.count > 2 ? args[2] : nil) {
        guard let def = Devices.defaultInput() else { throw HelperError("no default input") }
        return (try AudioInput(deviceID: def, label: "mic"), {})
    }

case "tap-test":
    // tap-test <seconds> [out.wav] [bundle-prefix…]
    let seconds = Double(args.dropFirst().first ?? "5") ?? 5
    let out = args.count > 2 ? args[2] : nil
    let prefixes = Array(args.dropFirst(3))
    recordTest(stream: "system", seconds: seconds, out: out) {
        let objects = prefixes.isEmpty ? [] : Processes.objects(matching: prefixes)
        let tap = try SystemTap(processes: objects)
        print("tap scope: \(tap.scope), processes: \(objects.count)")
        guard let input = tap.input else { throw HelperError("no tap input") }
        return (input, { tap.stop() })
    }

case "watch-meetings":
    print("Watching microphone users (Ctrl+C to stop)…")
    let watcher = MeetingWatcher()
    watcher.start()
    IPC.readCommands { _ in }
    RunLoop.main.run()

case "tabs":
    let bundle = args.count > 1 ? args[1] : "com.google.Chrome"
    printJSON(BrowserTabs.tabs(of: bundle) ?? [])

case "calendar":
    // calendar [days] — today's and the next days' events as JSON
    let cal = CalendarSource()
    let days = Double(args.count > 1 ? args[1] : "2") ?? 2
    cal.request { _ in
        let start = Calendar.current.startOfDay(for: Date())
        printJSON(["status": cal.status(), "events": cal.events(from: start, to: start.addingTimeInterval(days * 86400))])
        exit(0)
    }
    RunLoop.main.run()

case "permissions":
    printJSON(Permissions.status(calendar: CalendarSource()))

case "request":
    // request <microphone|systemAudio|accessibility|inputMonitoring|calendar|automation> [bundleID]
    let cal = CalendarSource()
    Permissions.request(args.count > 1 ? args[1] : "", bundleID: args.count > 2 ? args[2] : nil, calendar: cal) { r in
        print(r)
        exit(0)
    }
    RunLoop.main.run()

case "encode":
    // encode <out.m4a> <in1.pcm> [in2.pcm]
    do {
        let secs = try Encoder.encode(inputs: Array(args.dropFirst(2)), output: args[1])
        print("encoded \(secs)s")
    } catch {
        print("error: \(error)")
        exit(1)
    }

default:
    print("usage: KlaraHelper [serve|list-devices|processes|scan|mic-test|tap-test|watch-meetings|tabs|calendar|permissions|encode]")
    exit(2)
}
#endif
