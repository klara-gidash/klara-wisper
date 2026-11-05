using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
using Microsoft.Win32;
using NAudio.CoreAudioApi;

namespace KlaraHelper;

/// `KlaraHelper.exe serve`: the Windows counterpart of native/KlaraHelper (Swift), same commands
/// and events, so src/main/helper.ts works unchanged.
public static class Program
{
    public static int Main(string[] args)
    {
        var command = args.FirstOrDefault() ?? "serve";
#if !DEBUG
        // Release builds only do what the app needs: `serve`, and only for the Klara Wisper app itself.
        if (command != "serve")
        {
            Console.Error.WriteLine("KlaraHelper: only `serve` is available");
            return 2;
        }
        if (!ParentCheck.LaunchedByKlaraWisper())
        {
            Console.Error.WriteLine("KlaraHelper: must be started by Klara Wisper");
            return 77;
        }
#endif
        if (command == "list-devices")
        {
            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new Devices().Snapshot()));
            return 0;
        }
        new Server().Run();
        return 0;
    }
}

public sealed class Server
{
    private readonly Devices devices = new();
    private readonly MeetingWatcher watcher = new();
    private readonly Hotkey hotkey = new();
    private AudioInput? mic;
    private MMDevice? micDevice;
    private AudioInput? loop;
    private string? loopOutputId;
    private readonly object audioGate = new();
    private readonly BlockingCollection<Action> clipboard = new();
    private readonly SemaphoreSlim encodeOne = new(1, 1);

    public void Run()
    {
        // Clipboard and paste work happen one after the other on their own thread.
        new Thread(() => { foreach (var job in clipboard.GetConsumingEnumerable()) job(); }) { IsBackground = true, Name = "clipboard" }.Start();
        devices.Changed = () => Ipc.Event("devices", devices.Snapshot());
        devices.DefaultOutputChanged = () =>
        {
            Ipc.Event("devices", devices.Snapshot());
            lock (audioGate)
            {
                if (loop == null || devices.DefaultOutput()?.ID == loopOutputId) return;
            }
            try { Ipc.Event("systemRestarted", StartLoopback()); } // follow the user to new headphones
            catch (Exception e) { Ipc.Event("error", new() { ["message"] = $"system audio: {e.Message}" }); }
        };
        Ipc.ReadCommands(Handle);
        Ipc.Event("hello", new()
        {
            ["version"] = "0.1.0",
            ["pid"] = Environment.ProcessId,
            ["os"] = Environment.OSVersion.VersionString,
            ["permissions"] = Permissions(),
        });
        Thread.Sleep(Timeout.Infinite);
    }

    private static string MicPermission()
    {
        // Settings > Privacy & security > Microphone: the global switch, then "let desktop apps access".
        const string store = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
        string? Value(RegistryKey hive, string path) => hive.OpenSubKey(path)?.GetValue("Value") as string;
        if (Value(Registry.LocalMachine, store) == "Deny" || Value(Registry.CurrentUser, store) == "Deny") return "denied";
        if (Value(Registry.CurrentUser, store + @"\NonPackaged") == "Deny") return "denied";
        return "granted";
    }

    private static Dictionary<string, object?> Permissions() => new()
    {
        ["microphone"] = MicPermission(),
        ["accessibility"] = "granted",   // paste and the key hook need no permission on Windows
        ["inputMonitoring"] = "granted",
        ["calendar"] = "unsupported",
    };

    private static string S(JsonObject c, string k, string def = "") => c[k]?.GetValue<string>() ?? def;
    private static bool B(JsonObject c, string k, bool def) => c[k]?.GetValue<bool>() ?? def;

    private void Handle(JsonObject cmd)
    {
        var id = cmd["id"];
        try
        {
            switch (S(cmd, "cmd"))
            {
                case "ping": Ipc.Reply(id); break;
                case "devices": Ipc.Reply(id, devices.Snapshot()); break;
                case "scan":
                    if (mic != null) throw new HelperException("cannot scan while recording");
                    var ms = cmd["durationMs"]?.GetValue<int>() ?? 2500;
                    Task.Run(() => { try { Ipc.Reply(id, new() { ["results"] = Scan(ms) }); } catch (Exception e) { Ipc.Fail(id, e); } });
                    break;
                case "startMic":
                    if (MicPermission() == "denied") throw new HelperException("microphone permission denied");
                    Ipc.Reply(id, StartMic(cmd["uid"]?.GetValue<string>()));
                    break;
                case "stopMic":
                    lock (audioGate) { mic?.Dispose(); mic = null; micDevice = null; }
                    Ipc.Reply(id);
                    break;
                case "startSystem": Ipc.Reply(id, StartLoopback()); break; // bundlePrefixes: Windows captures the whole output
                case "stopSystem":
                    lock (audioGate) { loop?.Dispose(); loop = null; loopOutputId = null; }
                    Ipc.Reply(id);
                    break;
                case "watchMeetings":
                    if (B(cmd, "enabled", true)) watcher.Start(); else watcher.Stop();
                    Ipc.Reply(id);
                    break;
                case "setHotkey":
                    hotkey.SetKey(S(cmd, "key", hotkey.Key));
                    Ipc.Reply(id, new() { ["running"] = hotkey.Start(), ["key"] = hotkey.Key });
                    break;
                case "armEscape": hotkey.ArmEscape = B(cmd, "value", false); Ipc.Reply(id); break;
                case "paste":
                    var text = S(cmd, "text");
                    var restore = B(cmd, "restore", true);
                    clipboard.Add(() =>
                    {
                        try { Paster.Paste(text, restore, ok => Ipc.Reply(id, new() { ["pasted"] = ok })); }
                        catch (Exception e) { Ipc.Fail(id, e); }
                    });
                    break;
                case "frontmostApp": Ipc.Reply(id, Paster.Frontmost()); break;
                case "permissions": Ipc.Reply(id, Permissions()); break;
                case "requestPermission":
                    var kind = S(cmd, "kind");
                    if (kind == "microphone" && MicPermission() == "denied") OpenSettings();
                    Ipc.Reply(id, new() { ["result"] = kind == "microphone" ? MicPermission() : kind == "calendar" ? "unsupported" : "granted" });
                    break;
                case "calendarEvents": Ipc.Reply(id, new() { ["events"] = new List<object>(), ["status"] = "unsupported" }); break;
                case "tabs":
                    var exe = S(cmd, "bundleID", "chrome.exe");
                    Ipc.Reply(id, new() { ["tabs"] = MeetingWatcher.Tabs([exe]).GetValueOrDefault(exe) ?? [] });
                    break;
                case "encode":
                    var inputs = (cmd["inputs"] as JsonArray)?.Select(n => n!.GetValue<string>()).ToList() ?? [];
                    var output = S(cmd, "output");
                    Task.Run(async () =>
                    {
                        await encodeOne.WaitAsync();
                        try { Ipc.Reply(id, new() { ["seconds"] = Encoder.Encode(inputs, output) }); }
                        catch (Exception e) { Ipc.Fail(id, e); }
                        finally { encodeOne.Release(); }
                    });
                    break;
                case "openSettings": OpenSettings(); Ipc.Reply(id); break;
                default: throw new HelperException($"unknown command {S(cmd, "cmd")}");
            }
        }
        catch (Exception e)
        {
            Ipc.Fail(id, e);
        }
    }

    private static void OpenSettings() =>
        Process.Start(new ProcessStartInfo("ms-settings:privacy-microphone") { UseShellExecute = true });

    private static void EmitAudio(string stream, short[] samples, float db)
    {
        var bytes = new byte[samples.Length * 2];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        Ipc.Event("audio", new() { ["stream"] = stream, ["pcm"] = Convert.ToBase64String(bytes), ["db"] = Math.Round(db * 10) / 10 });
    }

    private Dictionary<string, object?> StartMic(string? uid)
    {
        var device = (uid != null ? devices.ById(uid) : null) ?? devices.DefaultInput() ?? throw new HelperException("no microphone");
        var input = new AudioInput(device, loopback: false);
        input.OnChunk = (s, db) => EmitAudio("mic", s, db);
        lock (audioGate)
        {
            mic?.Dispose();
            input.Start();
            mic = input;
            micDevice = device;
        }
        return new() { ["device"] = Devices.Dict(device, devices.DefaultInput()?.ID) };
    }

    private Dictionary<string, object?> StartLoopback()
    {
        var output = devices.DefaultOutput() ?? throw new HelperException("no output device");
        var input = new AudioInput(output, loopback: true);
        input.OnChunk = (s, db) => EmitAudio("system", s, db);
        lock (audioGate)
        {
            loop?.Dispose();
            input.Start();
            loop = input;
            loopOutputId = output.ID;
        }
        return new() { ["scope"] = "output", ["processes"] = 0, ["device"] = output.FriendlyName };
    }

    /// "Which microphone am I talking into?": opens every candidate at once and ranks them by level
    /// and speech-like signal (same scoring as Scanner.swift).
    private List<Dictionary<string, object?>> Scan(int durationMs)
    {
        var def = devices.DefaultInput()?.ID;
        var candidates = devices.Inputs().Where(d =>
        {
            var t = Devices.Transport(d.FriendlyName);
            return t != "virtual" && (t != "bluetooth" || d.ID == def); // opening a BT mic drops it to call quality
        }).ToList();
        var levels = candidates.ToDictionary(d => d.ID, _ => new List<float>());
        var opened = new List<AudioInput>();
        foreach (var d in candidates)
        {
            try
            {
                var input = new AudioInput(d, loopback: false);
                var list = levels[d.ID];
                input.OnChunk = (_, db) => { lock (list) list.Add(db); };
                input.Start();
                opened.Add(input);
            }
            catch { /* device busy or gone */ }
        }
        Thread.Sleep(durationMs);
        opened.ForEach(i => i.Dispose());
        return candidates.Select(d =>
        {
            var dbs = levels[d.ID].OrderBy(x => x).ToList();
            var row = new Dictionary<string, object?> { ["uid"] = d.ID, ["name"] = d.FriendlyName, ["transport"] = Devices.Transport(d.FriendlyName) };
            if (dbs.Count < 4) { row["score"] = -999.0; row["speech"] = 0.0; row["peakDb"] = -120.0; row["floorDb"] = -120.0; return row; }
            var floor = dbs[dbs.Count / 10];
            var peak = dbs[Math.Min(dbs.Count - 1, (int)(dbs.Count * 0.9))];
            var speech = dbs.Count(x => x > Math.Max(floor + 12, -55)) / (double)dbs.Count;
            row["score"] = peak + 40 * speech; row["speech"] = speech; row["peakDb"] = (double)peak; row["floorDb"] = (double)floor;
            return row;
        }).OrderByDescending(r => (double)r["score"]!).ToList();
    }
}
