import EventKit
import Foundation

/// Calendar events from the macOS Calendar app (which syncs Google/Exchange accounts), for naming recordings.
final class CalendarSource {
    private let store = EKEventStore()
    private static let linkPattern = try! NSRegularExpression(
        pattern: #"https?://(?:[\w-]+\.)*(?:zoom\.us/(?:j|my|w|wc)/[^\s<>"]+|meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}|teams\.microsoft\.com/l/meetup-join/[^\s<>"]+|teams\.live\.com/meet/[^\s<>"]+|teams\.cloud\.microsoft/[^\s<>"]+|app\.slack\.com/huddle/[^\s<>"]+)"#,
        options: [.caseInsensitive]
    )

    func status() -> String {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return "granted"
        case .writeOnly: return "writeOnly"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    func request(_ done: @escaping (Bool) -> Void) {
        store.requestFullAccessToEvents { granted, _ in DispatchQueue.main.async { done(granted) } }
    }

    func events(from: Date, to: Date) -> [[String: Any]] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return [] }
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
        return store.events(matching: predicate)
            .filter { !$0.isAllDay }
            .sorted { $0.startDate < $1.startDate }
            .map { e in
                let text = [e.url?.absoluteString, e.location, e.notes].compactMap { $0 }.joined(separator: "\n")
                return [
                    "id": "\(e.calendarItemIdentifier)@\(Int(e.startDate.timeIntervalSince1970))",
                    "title": e.title ?? "",
                    "start": isoFormatter.string(from: e.startDate),
                    "end": isoFormatter.string(from: e.endDate),
                    "calendar": e.calendar?.title ?? "",
                    "color": e.calendar?.cgColor.flatMap(hex) ?? NSNull(),
                    "location": e.location ?? "",
                    "links": CalendarSource.links(in: text),
                    "organizer": e.organizer?.name ?? "",
                    "attendees": (e.attendees ?? []).map { a -> [String: Any] in
                        [
                            "name": a.name ?? "",
                            "email": a.url.absoluteString.replacingOccurrences(of: "mailto:", with: ""),
                            "isMe": a.isCurrentUser,
                            "status": a.participantStatus.rawValue,
                        ]
                    },
                ]
            }
    }

    static func links(in text: String) -> [String] {
        let range = NSRange(text.startIndex..., in: text)
        var seen = Set<String>()
        return linkPattern.matches(in: text, range: range).compactMap { m in
            guard let r = Range(m.range, in: text) else { return nil }
            let link = String(text[r])
            return seen.insert(link).inserted ? link : nil
        }
    }

    private func hex(_ c: CGColor) -> String? {
        guard let comps = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components,
              comps.count >= 3 else { return nil }
        return String(format: "#%02X%02X%02X", Int(comps[0] * 255), Int(comps[1] * 255), Int(comps[2] * 255))
    }
}
