import Foundation

/// Reports which apps are recording from a microphone, plus the open tabs of any browser that is.
/// The app decides what counts as a meeting (Zoom, Teams, Slack huddle, Meet in a tab…).
final class MeetingWatcher {
    private let queue = DispatchQueue(label: "meetings")
    private var timer: DispatchSourceTimer?
    private var lastSignature = ""
    private var lastTabsCheck = Date.distantPast
    private var tabs: [String: [[String: String]]] = [:]

    func start() {
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .seconds(1))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
        lastSignature = ""
    }

    private func tick() {
        let users = Processes.list().filter(\.input)
        let browsers = Set(users.flatMap { BrowserTabs.browser(forProcessBundle: $0.bundleID) }).filter(BrowserTabs.isRunning)
        if browsers.isEmpty {
            tabs = [:]
            lastTabsCheck = .distantPast // the next browser call gets its tabs right away, not up to 3 s later
        } else if Date().timeIntervalSince(lastTabsCheck) >= 3 || !browsers.isSubset(of: Set(tabs.keys)) {
            lastTabsCheck = Date()
            var fresh: [String: [[String: String]]] = [:]
            // A failed read (osascript timed out while the browser was busy) keeps the last list
            // instead of reporting "no tabs", which would look like the meeting tab was closed.
            for b in browsers { fresh[b] = BrowserTabs.tabs(of: b) ?? tabs[b] ?? [] }
            tabs = fresh
        }
        let usersDict = users.map(\.dict)
        let payload: [String: Any] = ["users": usersDict, "tabs": tabs]
        let signature = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? ""
        if signature != lastSignature {
            lastSignature = signature
            IPC.event("micUsers", payload)
        }
    }
}
