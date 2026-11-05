using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using NAudio.MediaFoundation;
using NAudio.Wave;

namespace KlaraHelper;

/// Who is using a microphone right now, plus the window titles of any browser that is.
/// Source: Windows' own record of microphone use (the one behind the taskbar mic icon):
/// HKCU\…\CapabilityAccessManager\ConsentStore\microphone\{NonPackaged\<exe path>, <package family>}
/// with LastUsedTimeStop == 0 while the app holds the microphone.
public sealed class MeetingWatcher
{
    private const string Store = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    public static readonly string[] Browsers = ["chrome.exe", "msedge.exe", "brave.exe", "firefox.exe", "vivaldi.exe", "opera.exe", "arc.exe"];
    private static readonly string[] Ours = ["klarahelper.exe", "klara wisper.exe"];

    private Timer? timer;
    private string lastSignature = "";
    private DateTime lastTabsCheck = DateTime.MinValue;
    private Dictionary<string, List<Dictionary<string, string>>> tabs = new();

    public void Start() => timer ??= new Timer(_ => Tick(), null, 0, 1000);

    public void Stop()
    {
        timer?.Dispose();
        timer = null;
        lastSignature = "";
    }

    private static bool InUse(RegistryKey k) =>
        k.GetValue("LastUsedTimeStop") is long stop && stop == 0 && k.GetValue("LastUsedTimeStart") is long start && start != 0;

    public static List<Dictionary<string, object?>> Users()
    {
        var users = new List<Dictionary<string, object?>>();
        using var root = Registry.CurrentUser.OpenSubKey(Store);
        if (root == null) return users;
        foreach (var name in root.GetSubKeyNames())
        {
            if (name == "NonPackaged")
            {
                using var np = root.OpenSubKey(name);
                if (np == null) continue;
                foreach (var app in np.GetSubKeyNames())
                {
                    using var k = np.OpenSubKey(app);
                    if (k == null || !InUse(k)) continue;
                    var exe = app.Split('#').Last().ToLowerInvariant(); // "C:#Program Files#Zoom#bin#Zoom.exe"
                    if (Ours.Contains(exe)) continue;
                    users.Add(User(exe, Path.GetFileNameWithoutExtension(exe)));
                }
            }
            else
            {
                using var k = root.OpenSubKey(name); // Store app: package family name, e.g. MSTeams_8wekyb3d8bbwe
                if (k != null && InUse(k)) users.Add(User(name.ToLowerInvariant(), name.Split('_')[0]));
            }
        }
        return users;
    }

    private static Dictionary<string, object?> User(string id, string name) => new()
    {
        ["pid"] = 0, ["bundleID"] = id, ["name"] = name, ["input"] = true, ["output"] = false, ["inputDevices"] = new List<string>(),
    };

    /// Titles of the visible top-level windows of each browser (the title is the active tab's).
    public static Dictionary<string, List<Dictionary<string, string>>> Tabs(IEnumerable<string> browsers)
    {
        var want = browsers.ToHashSet();
        var names = new Dictionary<uint, string>();
        var result = new Dictionary<string, List<Dictionary<string, string>>>();
        Win32.EnumWindows((hwnd, _) =>
        {
            if (!Win32.IsWindowVisible(hwnd)) return true;
            int len = Win32.GetWindowTextLengthW(hwnd);
            if (len == 0) return true;
            Win32.GetWindowThreadProcessId(hwnd, out var pid);
            if (!names.TryGetValue(pid, out var exe))
            {
                exe = Path.GetFileName(Win32.ImagePath(pid) ?? "").ToLowerInvariant();
                names[pid] = exe;
            }
            if (!want.Contains(exe)) return true;
            var sb = new StringBuilder(len + 1);
            Win32.GetWindowTextW(hwnd, sb, sb.Capacity);
            if (!result.TryGetValue(exe, out var list)) result[exe] = list = [];
            list.Add(new() { ["url"] = "", ["title"] = sb.ToString() });
            return true;
        }, IntPtr.Zero);
        return result;
    }

    private void Tick()
    {
        try
        {
            var users = Users();
            var browsers = users.Select(u => (string)u["bundleID"]!).Where(id => Browsers.Contains(id)).ToList();
            if (browsers.Count == 0) tabs = new();
            else if ((DateTime.UtcNow - lastTabsCheck).TotalSeconds >= 3)
            {
                lastTabsCheck = DateTime.UtcNow;
                tabs = Tabs(browsers);
            }
            var payload = new Dictionary<string, object?> { ["users"] = users, ["tabs"] = tabs };
            var signature = JsonSerializer.Serialize(payload);
            if (signature == lastSignature) return;
            lastSignature = signature;
            Ipc.Event("micUsers", payload);
        }
        catch (Exception e)
        {
            Ipc.Log($"watcher: {e.Message}");
        }
    }
}

/// Reads the meeting's raw 16 kHz Int16 recordings (one per stream) as one interleaved stream.
internal sealed class Interleaved : IWaveProvider, IDisposable
{
    private readonly FileStream[] files;
    private readonly byte[][] bufs;
    public WaveFormat WaveFormat { get; }
    public long Frames { get; }

    public Interleaved(IReadOnlyList<string> paths)
    {
        files = paths.Select(p => new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.Read)).ToArray();
        bufs = files.Select(_ => Array.Empty<byte>()).ToArray();
        WaveFormat = new WaveFormat(16000, 16, files.Length);
        Frames = files.Max(f => f.Length / 2);
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        int ch = files.Length;
        int frames = count / (2 * ch);
        bool any = false;
        for (int c = 0; c < ch; c++)
        {
            if (bufs[c].Length < frames * 2) bufs[c] = new byte[frames * 2];
            int got = files[c].Read(bufs[c], 0, frames * 2);
            if (got > 0) any = true;
            Array.Clear(bufs[c], got, frames * 2 - got); // a shorter stream ends in silence
        }
        if (!any) return 0;
        for (int f = 0; f < frames; f++)
            for (int c = 0; c < ch; c++)
            {
                buffer[offset + (f * ch + c) * 2] = bufs[c][f * 2];
                buffer[offset + (f * ch + c) * 2 + 1] = bufs[c][f * 2 + 1];
            }
        return frames * ch * 2;
    }

    public void Dispose()
    {
        foreach (var f in files) f.Dispose();
    }
}

public static class Encoder
{
    /// One AAC file (channel 1 = my mic, channel 2 = the other side), like Encoder.swift.
    /// Windows' AAC encoder only takes 44.1/48 kHz, so the audio is resampled to 48 kHz first.
    public static double Encode(IReadOnlyList<string> inputs, string output)
    {
        if (inputs.Count == 0) throw new HelperException("no inputs");
        MediaFoundationApi.Startup();
        using var source = new Interleaved(inputs);
        using var resampled = new MediaFoundationResampler(source, new WaveFormat(48000, 16, source.WaveFormat.Channels)) { ResamplerQuality = 60 };
        if (File.Exists(output)) File.Delete(output);
        MediaFoundationEncoder.EncodeToAac(resampled, output, 96000); // lowest rate the encoder offers
        return source.Frames / 16000.0;
    }
}

/// Release builds only serve the Klara Wisper app they ship inside: the parent process must be
/// "Klara Wisper.exe" in the install folder (this helper lives in <install>\resources\helper\).
public static class ParentCheck
{
    public static bool LaunchedByKlaraWisper()
    {
        var expected = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "Klara Wisper.exe"));
        var parent = Win32.ParentPid((uint)Environment.ProcessId);
        var path = parent == 0 ? null : Win32.ImagePath(parent);
        return path != null && string.Equals(Path.GetFullPath(path), expected, StringComparison.OrdinalIgnoreCase);
    }
}
