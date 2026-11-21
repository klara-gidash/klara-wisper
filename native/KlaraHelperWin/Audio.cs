using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace KlaraHelper;

/// Mixes any number of channels down to one.
internal sealed class MonoMix(ISampleProvider source) : ISampleProvider
{
    private float[] buf = [];
    public WaveFormat WaveFormat { get; } = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);

    public int Read(float[] buffer, int offset, int count)
    {
        int ch = source.WaveFormat.Channels;
        if (ch == 1) return source.Read(buffer, offset, count);
        if (buf.Length < count * ch) buf = new float[count * ch];
        int frames = source.Read(buf, 0, count * ch) / ch;
        for (int f = 0; f < frames; f++)
        {
            float s = 0;
            for (int c = 0; c < ch; c++) s += buf[f * ch + c];
            buffer[offset + f] = s / ch;
        }
        return frames;
    }
}

/// One WASAPI capture (a microphone, or the loopback of an output device), converted to 16 kHz mono
/// Int16 and delivered in 50 ms chunks (800 samples) with their level in dBFS, like AudioInput.swift.
public sealed class AudioInput : IDisposable
{
    public const int ChunkSamples = 800;
    public Action<short[], float>? OnChunk;

    private static readonly int[] RestartDelaysMs = [500, 1000, 2000, 4000, 8000];

    private readonly string deviceId;
    private readonly string deviceName;
    private readonly bool loopback;
    private WasapiCapture capture;
    private BufferedWaveProvider buffered;
    private ISampleProvider chain;
    private readonly float[] readBuf = new float[16000];
    private readonly List<short> pending = new(ChunkSamples * 4);
    private readonly object gate = new();
    private readonly Timer? silenceTimer;
    private long lastData = Environment.TickCount64;
    private volatile bool stopped = true;
    private int restartAttempt;

    public AudioInput(MMDevice device, bool loopback)
    {
        this.loopback = loopback;
        deviceId = device.ID;
        deviceName = device.FriendlyName;
        (capture, buffered, chain) = Open(device);
        if (loopback)
        {
            // WASAPI loopback delivers nothing at all while nothing plays. The engine keeps time by
            // samples received, so fill those gaps with silence (the Mac tap does the same).
            silenceTimer = new Timer(_ =>
            {
                if (Environment.TickCount64 - Interlocked.Read(ref lastData) < 100) return;
                WaveFormat fmt;
                lock (gate) fmt = capture.WaveFormat;
                int bytes = fmt.AverageBytesPerSecond / 20;
                Feed(new byte[bytes - bytes % fmt.BlockAlign], bytes - bytes % fmt.BlockAlign, silence: true);
            });
        }
    }

    /// A capture on the device with its conversion chain (16 kHz mono) and event handlers.
    private (WasapiCapture, BufferedWaveProvider, ISampleProvider) Open(MMDevice device)
    {
        WasapiCapture c = loopback ? new WasapiLoopbackCapture(device) : new WasapiCapture(device, true, 50);
        var b = new BufferedWaveProvider(c.WaveFormat)
        {
            DiscardOnBufferOverflow = true,
            ReadFully = false,
            BufferDuration = TimeSpan.FromSeconds(5),
        };
        ISampleProvider mono = new MonoMix(b.ToSampleProvider());
        ISampleProvider ch = mono.WaveFormat.SampleRate == 16000 ? mono : new WdlResamplingSampleProvider(mono, 16000);
        c.DataAvailable += (_, e) => Feed(e.Buffer, e.BytesRecorded);
        c.RecordingStopped += (sender, e) => OnStopped(sender, e.Exception);
        return (c, b, ch);
    }

    /// The capture stopped without being asked to (device invalidated, audio service restarted,
    /// exclusive-mode grab): log it and open it again after a short pause, a few times.
    private void OnStopped(object? sender, Exception? error)
    {
        if (stopped || !ReferenceEquals(sender, capture)) return; // our own Stop(), or an old capture
        string what = loopback ? "system audio" : "microphone";
        Ipc.Log($"{what} capture on \"{deviceName}\" stopped unexpectedly: {error?.Message ?? "no error"}");
        if (error != null) Ipc.Event("error", new() { ["message"] = $"audio: {error.Message}" });
        ScheduleRestart();
    }

    private void ScheduleRestart()
    {
        int attempt = Interlocked.Increment(ref restartAttempt);
        if (attempt > RestartDelaysMs.Length)
        {
            Ipc.Event("error", new() { ["message"] = $"audio: {(loopback ? "system audio" : "microphone")} capture could not be restarted" });
            return;
        }
        Task.Delay(RestartDelaysMs[attempt - 1]).ContinueWith(_ => Restart(attempt));
    }

    private void Restart(int attempt)
    {
        if (stopped) return;
        try
        {
            // The old device object may be dead after an invalidation: look the endpoint up again.
            var device = new MMDeviceEnumerator().GetDevice(deviceId);
            var (c, b, ch) = Open(device);
            WasapiCapture old;
            lock (gate)
            {
                if (stopped) { c.Dispose(); return; }
                old = capture;
                capture = c;
                buffered = b;
                chain = ch;
                pending.Clear();
            }
            try { old.Dispose(); } catch { /* already gone */ }
            c.StartRecording();
            Interlocked.Exchange(ref restartAttempt, 0);
            Ipc.Log($"{(loopback ? "system audio" : "microphone")} capture on \"{deviceName}\" restarted (attempt {attempt})");
        }
        catch (Exception e)
        {
            Ipc.Log($"{(loopback ? "system audio" : "microphone")} capture restart failed (attempt {attempt}): {e.Message}");
            ScheduleRestart();
        }
    }

    public void Start()
    {
        stopped = false;
        capture.StartRecording();
        silenceTimer?.Change(50, 50);
    }

    public void Stop()
    {
        stopped = true;
        silenceTimer?.Change(Timeout.Infinite, Timeout.Infinite);
        WasapiCapture c;
        lock (gate) c = capture;
        try { c.StopRecording(); } catch { /* already stopped */ }
    }

    public void Dispose()
    {
        Stop();
        silenceTimer?.Dispose();
        WasapiCapture c;
        lock (gate) c = capture;
        c.Dispose(); // outside the lock: the capture thread may be waiting on it in Feed()
    }

    private void Feed(byte[] data, int count, bool silence = false)
    {
        if (!silence) Interlocked.Exchange(ref lastData, Environment.TickCount64);
        lock (gate)
        {
            if (count > 0) buffered.AddSamples(data, 0, count);
            int n;
            while ((n = chain.Read(readBuf, 0, readBuf.Length)) > 0)
            {
                for (int i = 0; i < n; i++) pending.Add((short)Math.Clamp(readBuf[i] * 32767f, -32768f, 32767f));
            }
            while (pending.Count >= ChunkSamples)
            {
                var chunk = pending.GetRange(0, ChunkSamples).ToArray();
                pending.RemoveRange(0, ChunkSamples);
                OnChunk?.Invoke(chunk, Dbfs(chunk));
            }
        }
    }

    public static float Dbfs(short[] s)
    {
        if (s.Length == 0) return -120;
        double sum = 0;
        foreach (var v in s) sum += (double)v * v;
        double rms = Math.Sqrt(sum / s.Length) / 32768.0;
        return rms <= 1e-6 ? -120f : (float)(20 * Math.Log10(rms));
    }
}

/// Input devices and change notifications (headset plugged in, default device switched).
public sealed class Devices : IMMNotificationClient
{
    private static readonly string[] VirtualNames =
        ["cable", "voicemeeter", "krisp", "zoom", "teams", "virtual", "stereo mix", "loopback", "nvidia broadcast", "klara wisper"];

    /// End-to-end tests (KLARA_E2E=1) play into a virtual cable ("CABLE Output", "… Virtual …"):
    /// then virtual inputs count as real microphones for picking and scanning.
    public static readonly bool E2E = Environment.GetEnvironmentVariable("KLARA_E2E") == "1";

    /// Never the user's own voice (a virtual or aggregate input), except in end-to-end tests.
    public static bool IsVirtual(string name) => !E2E && Transport(name) == "virtual";

    public readonly MMDeviceEnumerator Enumerator = new();
    public Action? Changed;
    public Action? DefaultOutputChanged;

    public Devices() => Enumerator.RegisterEndpointNotificationCallback(this);

    public static string Transport(string name)
    {
        var n = name.ToLowerInvariant();
        if (n.Contains("bluetooth") || n.Contains("hands-free") || n.Contains("airpods") || n.Contains("headset (")) return "bluetooth";
        if (n.Contains("usb")) return "usb";
        if (VirtualNames.Any(n.Contains)) return "virtual";
        return "builtin";
    }

    public IEnumerable<MMDevice> Inputs() => Enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active);

    public MMDevice? DefaultInput() =>
        Enumerator.HasDefaultAudioEndpoint(DataFlow.Capture, Role.Communications)
            ? Enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications)
            : null;

    public MMDevice? DefaultOutput() =>
        Enumerator.HasDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
            ? Enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
            : null;

    public MMDevice? ById(string uid) => Inputs().FirstOrDefault(d => d.ID == uid);

    public static Dictionary<string, object?> Dict(MMDevice d, string? defaultId) => new()
    {
        ["uid"] = d.ID,
        ["name"] = d.FriendlyName,
        ["transport"] = Transport(d.FriendlyName),
        ["virtual"] = IsVirtual(d.FriendlyName),
        ["isDefault"] = d.ID == defaultId,
    };

    public Dictionary<string, object?> Snapshot()
    {
        var def = DefaultInput()?.ID;
        var output = DefaultOutput();
        return new()
        {
            ["inputs"] = Inputs().Select(d => Dict(d, def)).ToList(),
            ["defaultInput"] = def,
            ["defaultOutput"] = output == null ? null : new Dictionary<string, object?> { ["uid"] = output.ID, ["name"] = output.FriendlyName },
        };
    }

    // IMMNotificationClient (called on a COM thread: just signal)
    public void OnDeviceStateChanged(string deviceId, DeviceState newState) => Changed?.Invoke();
    public void OnDeviceAdded(string pwstrDeviceId) => Changed?.Invoke();
    public void OnDeviceRemoved(string deviceId) => Changed?.Invoke();
    public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
    {
        if (flow == DataFlow.Render && role == Role.Multimedia) DefaultOutputChanged?.Invoke();
        else Changed?.Invoke();
    }
    public void OnPropertyValueChanged(string pwstrDeviceId, PropertyKey key) { }
}
