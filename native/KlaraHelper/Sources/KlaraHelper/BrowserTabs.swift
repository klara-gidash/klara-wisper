import AppKit
import Foundation

/// Reads open tab URLs from browsers via AppleScript (needs the Automation permission once per browser).
enum BrowserTabs {
    static let chromium = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "company.thebrowser.Browser",
        "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    ]
    static let safari = ["com.apple.Safari", "com.apple.SafariTechnologyPreview"]
    static var all: [String] { chromium + safari }

    /// Browser whose helper process (e.g. "com.google.Chrome.helper", "com.apple.WebKit.GPU") is using audio.
    static func browser(forProcessBundle id: String) -> [String] {
        // Case-insensitive: helper bundles don't always keep the browser's case (e.g. Arc's helper).
        let lower = id.lowercased()
        if let b = chromium.first(where: { lower.hasPrefix($0.lowercased()) }) { return [b] }
        if safari.contains(where: { lower.hasPrefix($0.lowercased()) }) || lower.hasPrefix("com.apple.webkit") { return safari }
        return []
    }

    static func isRunning(_ bundleID: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }

    static func tabs(of bundleID: String) -> [[String: String]]? {
        // Only known browsers: the ID is placed inside an AppleScript string.
        guard all.contains(bundleID), isRunning(bundleID) else { return nil }
        let titleProp = safari.contains(bundleID) ? "name" : "title"
        let script = """
        set out to ""
        set sep to character id 9
        tell application id "\(bundleID)"
          repeat with w in windows
            repeat with t in tabs of w
              set out to out & (URL of t as text) & sep & (\(titleProp) of t as text) & linefeed
            end repeat
          end repeat
        end tell
        return out
        """
        guard let output = run(script) else { return nil }
        return output.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
            guard let url = parts.first, url.hasPrefix("http") else { return nil }
            return ["url": String(url), "title": parts.count > 1 ? String(parts[1]) : ""]
        }
    }

    private static func run(_ script: String, timeout: TimeInterval = 4) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return p.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
    }
}
