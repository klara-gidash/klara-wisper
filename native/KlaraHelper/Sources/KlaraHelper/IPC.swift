import Foundation

struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Newline-delimited JSON over stdin/stdout. Every stdout line is one message:
/// replies carry "reply" (the command id) and "ok"; events carry "event".
enum IPC {
    private static let out = DispatchQueue(label: "ipc.out")

    static func send(_ obj: [String: Any]) {
        out.async {
            guard JSONSerialization.isValidJSONObject(obj),
                  var data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])
            else { return }
            data.append(0x0A)
            try? FileHandle.standardOutput.write(contentsOf: data)
        }
    }

    static func event(_ name: String, _ payload: [String: Any] = [:]) {
        var o = payload
        o["event"] = name
        send(o)
    }

    static func reply(_ id: Any?, _ result: [String: Any] = [:]) {
        var o = result
        o["reply"] = id ?? NSNull()
        o["ok"] = true
        send(o)
    }

    static func fail(_ id: Any?, _ error: Any) {
        send(["reply": id ?? NSNull(), "ok": false, "error": "\(error)"])
    }

    static func log(_ msg: String) {
        try? FileHandle.standardError.write(contentsOf: Data((msg + "\n").utf8))
    }

    /// Reads commands on a background thread and runs `handler` on the main queue.
    /// When stdin closes the app is gone, so the helper exits.
    static func readCommands(_ handler: @escaping ([String: Any]) -> Void) {
        Thread {
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { handler(obj) }
            }
            exit(0)
        }.start()
    }
}

func printJSON(_ obj: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .withoutEscapingSlashes]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()
