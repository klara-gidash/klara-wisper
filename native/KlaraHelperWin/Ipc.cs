using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace KlaraHelper;

public sealed class HelperException(string message) : Exception(message);

/// Newline-delimited JSON over stdin/stdout, exactly like the macOS helper: replies carry "reply"
/// (the command id) and "ok"; events carry "event". One writer thread, so the keyboard hook and
/// the audio threads never block on stdout.
public static class Ipc
{
    private static readonly BlockingCollection<string> Outbox = new(new ConcurrentQueue<string>(), 4096);
    private static readonly Stream Stdout = Console.OpenStandardOutput();

    static Ipc()
    {
        var t = new Thread(() =>
        {
            foreach (var line in Outbox.GetConsumingEnumerable())
            {
                var bytes = Encoding.UTF8.GetBytes(line + "\n");
                try { Stdout.Write(bytes); Stdout.Flush(); } catch (IOException) { Environment.Exit(0); }
            }
        }) { IsBackground = true, Name = "ipc-out" };
        t.Start();
    }

    private static void Send(Dictionary<string, object?> obj) =>
        Outbox.TryAdd(JsonSerializer.Serialize(obj), 1000);

    public static void Event(string name, Dictionary<string, object?>? payload = null)
    {
        var o = payload ?? new Dictionary<string, object?>();
        o["event"] = name;
        Send(o);
    }

    public static void Reply(JsonNode? id, Dictionary<string, object?>? result = null)
    {
        var o = result ?? new Dictionary<string, object?>();
        o["reply"] = id?.DeepClone();
        o["ok"] = true;
        Send(o);
    }

    public static void Fail(JsonNode? id, Exception error) =>
        Send(new Dictionary<string, object?> { ["reply"] = id?.DeepClone(), ["ok"] = false, ["error"] = error.Message });

    public static void Log(string msg)
    {
        try { Console.Error.WriteLine(msg); } catch { /* the app is gone */ }
    }

    /// Reads commands on a background thread; when stdin closes the app is gone, so the helper exits.
    public static void ReadCommands(Action<JsonObject> handler)
    {
        var t = new Thread(() =>
        {
            using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string? line;
            while ((line = stdin.ReadLine()) != null)
            {
                JsonObject? cmd = null;
                try { cmd = JsonNode.Parse(line) as JsonObject; } catch (JsonException) { }
                if (cmd != null) handler(cmd);
            }
            Environment.Exit(0);
        }) { IsBackground = true, Name = "ipc-in" };
        t.Start();
    }
}
