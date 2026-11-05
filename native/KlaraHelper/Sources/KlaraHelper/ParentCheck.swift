import Darwin
import Foundation
import Security

/// The helper holds microphone / system-audio / accessibility permissions, so it must only serve
/// the Klara Wisper app it ships inside: the parent process has to be that app's main executable,
/// running with a valid code signature for the app's bundle identifier.
enum ParentCheck {
    static let appIdentifier = "io.klara.wisper"

    static func launchedByKlaraWisper() -> Bool {
        let parent = getppid()
        // …/Klara Wisper.app/Contents/Resources/KlaraHelper.app → …/Klara Wisper.app
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard app.pathExtension == "app" else { return false }
        let expected = app.appendingPathComponent("Contents/MacOS").resolvingSymlinksInPath().path

        var buf = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(parent, &buf, UInt32(buf.count)) > 0 else { return false }
        let parentPath = URL(fileURLWithPath: String(cString: buf)).resolvingSymlinksInPath()
        guard parentPath.deletingLastPathComponent().path == expected else { return false }

        var code: SecCode?
        let attrs = [kSecGuestAttributePid: NSNumber(value: parent)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let code else { return false }
        var req: SecRequirement?
        guard SecRequirementCreateWithString("identifier \"\(appIdentifier)\"" as CFString, [], &req) == errSecSuccess, let req else {
            return false
        }
        return SecCodeCheckValidity(code, [], req) == errSecSuccess
    }
}
