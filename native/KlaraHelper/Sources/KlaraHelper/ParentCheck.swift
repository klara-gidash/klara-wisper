import Darwin
import Foundation
import Security

/// The helper holds microphone / system-audio / accessibility permissions, so it must only serve
/// the Klara Wisper app it ships inside: the parent process has to be that app's main executable,
/// running with a valid code signature for the app's bundle identifier.
///
/// Without a Developer ID the app is signed ad hoc (or with a local identity), so the requirement can
/// only name the identifier: it can't be pinned to a certificate or team. The bundle-path check is what
/// ties the parent to the app this helper ships inside.
enum ParentCheck {
    static let appIdentifier = "io.klara.wisper"

    static func launchedByKlaraWisper() -> Bool {
        launchedByKlaraWisper(pid: getppid())
    }

    /// True when `pid` is the main executable of the Klara Wisper app that contains this helper,
    /// with a valid code signature for the app's identifier.
    static func launchedByKlaraWisper(pid: pid_t) -> Bool {
        guard pid > 1 else { return false }
        // …/Klara Wisper.app/Contents/Resources/KlaraHelper.app → …/Klara Wisper.app
        let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard app.pathExtension == "app", let expected = realPath(app.appendingPathComponent("Contents/MacOS").path) else { return false }
        guard let parentPath = executablePath(of: pid) else { return false }
        guard (parentPath as NSString).deletingLastPathComponent == expected else { return false }

        var code: SecCode?
        let attrs = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let code else { return false }
        var req: SecRequirement?
        guard SecRequirementCreateWithString("identifier \"\(appIdentifier)\"" as CFString, [], &req) == errSecSuccess, let req else {
            return false
        }
        // The running code must be validly signed (not modified since signing) and satisfy the requirement.
        return SecCodeCheckValidity(code, [], req) == errSecSuccess
    }

    /// The copy of the helper that Disclaim.swift re-launches (with KLARA_DISCLAIMED set). Any process can
    /// set that variable, so it proves nothing on its own: the parent must be this same helper executable,
    /// and that helper's own parent must be Klara Wisper.
    static func relaunchedByVerifiedHelper() -> Bool {
        let parent = getppid()
        guard parent > 1,
              let mine = Bundle.main.executablePath.flatMap(realPath),
              let parentPath = executablePath(of: parent),
              parentPath == mine,
              let grandparent = parentPID(of: parent)
        else { return false }
        return launchedByKlaraWisper(pid: grandparent)
    }

    /// The parent of `pid`, from the kernel's BSD process info.
    static func parentPID(of pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        let ppid = pid_t(truncatingIfNeeded: info.pbi_ppid)
        return ppid > 1 ? ppid : nil
    }

    /// The real path (symlinks resolved) of the executable a process runs.
    static func executablePath(of pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))  // PROC_PIDPATHINFO_MAXSIZE
        guard proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 else { return nil }
        return realPath(String(cString: buf))
    }

    static func realPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
