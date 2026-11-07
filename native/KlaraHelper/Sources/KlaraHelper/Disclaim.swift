import Darwin
import Foundation

@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

private var childPID: pid_t = 0

/// macOS attributes privacy permissions (microphone, system audio, accessibility…) to the
/// "responsible" app, which for a child process is whoever launched it (Electron, Terminal).
/// Re-launching ourselves with responsibility disclaimed makes Klara Wisper Helper its own
/// responsible process, so the permission prompts name it and the grants stick to it.
enum Disclaim {
    static func reexecIfNeeded() {
        let env = ProcessInfo.processInfo.environment
        // KLARA_DISCLAIMED only marks the re-launched copy so it doesn't re-launch again; it grants nothing.
        // Release builds verify that copy's parent (this helper) and grandparent (Klara Wisper) in main.swift.
        guard env["KLARA_DISCLAIMED"] == nil, env["KLARA_NO_DISCLAIM"] == nil else { return }
        guard let path = Bundle.main.executablePath else { return }

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        guard responsibility_spawnattrs_setdisclaim(&attr, 1) == 0 else { return }

        // Never pass loader/interposing variables on to the process that holds the permissions.
        var childEnv = env.filter { !$0.key.hasPrefix("DYLD_") && !$0.key.hasPrefix("MallocStackLogging") }
        childEnv["KLARA_DISCLAIMED"] = "1"
        let argv: [UnsafeMutablePointer<CChar>?] = [strdup(path)] + CommandLine.arguments.dropFirst().map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = childEnv.map { strdup("\($0.key)=\($0.value)") } + [nil]
        var pid: pid_t = 0
        guard posix_spawn(&pid, path, nil, &attr, argv, envp) == 0 else { return }  // fall back to in-process
        childPID = pid
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig) { s in kill(childPID, s) }
        }
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        let exited = (status & 0x7F) == 0
        exit(exited ? (status >> 8) & 0xFF : 1)
    }
}
