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

    private readonly WasapiCapture capture;
    private readonly BufferedWaveProvider buffered;
    private readonly ISampleProvider chain;
    private readonly float[] readBuf = new float[16000];
    private readonly List<short> pending = new(ChunkSamples * 4);
    private readonly object gate = new();
    private readonly Timer? silenceTimer;
    private long lastData = Environment.TickCount64;

    public AudioInput(MMDevice device, bool loopback)
    {
        capture = loopback ? new WasapiLoopbackCapture(device) : new WasapiCapture(device, true, 50);
        buffered = new BufferedWaveProvider(capture.WaveFormat)
        {
            DiscardOnBufferOverflow = true,
            ReadFully = false,
            BufferDuration = TimeSpan.FromSeconds(5),
        };
        ISampleProvider mono = new MonoMix(buffered.ToSampleProvider());
        chain = mono.WaveFormat.SampleRate == 16000 ? mono : new WdlResamplingSampleProvider(mono, 16000);
        capture.DataAvailable += (_, e) => Feed(e.Buffer, e.BytesRecorded);
        if (loopback)
        {
            // WASAPI loopback delivers nothing at all while nothing plays. The engine keeps time by
            // samples received, so fill those gaps with silence (the Mac tap does the same).
            silenceTimer = new Timer(_ =>
            {
                if (Environment.TickCount64 - Interlocked.Read(ref lastData) < 100) return;
                var fmt = capture.WaveFormat;
                int bytes = fmt.AverageBytesPerSecond / 20;
                Feed(new byte[bytes - bytes % fmt.BlockAlign], bytes - bytes % fmt.BlockAlign, silence: true);
            });
        }
        capture.RecordingStopped += (_, e) =>
        {
            if (e.Exception != null) Ipc.Event("error", new() { ["message"] = $"audio: {e.Exception.Message}" });
        };
    }

    public void Start()
    {
        capture.StartRecording();
        silenceTimer?.Change(50, 50);
    }

    public void Stop()
    {
        silenceTimer?.Change(Timeout.Infinite, Timeout.Infinite);
        try { capture.StopRecording(); } catch { /* already stopped */ }
    }

    public void Dispose()
    {
        Stop();
        silenceTimer?.Dispose();
        capture.Dispose();
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
        ["virtual"] = Transport(d.FriendlyName) == "virtual",
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
