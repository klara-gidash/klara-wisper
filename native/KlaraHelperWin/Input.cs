using System.Runtime.InteropServices;
using System.Text;

namespace KlaraHelper;

/// Push-to-talk key through a low-level keyboard hook (listen only: every key is passed on).
/// Same events as Hotkey.swift: hotkey down/up, "chord" when another key is pressed while held,
/// Escape while armed. Windows has no fn key events, so "fn" means Right Ctrl here.
public sealed class Hotkey
{
    private static readonly Dictionary<string, uint> Keys = new()
    {
        ["fn"] = 0xA3,           // VK_RCONTROL
        ["rightControl"] = 0xA3,
        ["rightOption"] = 0xA5,  // VK_RMENU (Right Alt)
        ["rightCommand"] = 0x5C, // VK_RWIN
    };

    public string Key { get; private set; } = "rightControl";
    public volatile bool ArmEscape;
    private volatile uint vk = 0xA3;
    private bool isDown;
    private Win32.LowLevelKeyboardProc? proc; // kept alive: the hook holds only a native pointer
    private IntPtr hook;
    private readonly ManualResetEventSlim installed = new();

    public bool Running => hook != IntPtr.Zero;

    public void SetKey(string key)
    {
        if (Keys.TryGetValue(key, out var v)) { Key = key == "fn" ? "rightControl" : key; vk = v; }
    }

    /// Installs the hook on its own thread, which runs the message loop the hook needs.
    public bool Start()
    {
        if (Running) return true;
        var t = new Thread(() =>
        {
            proc = Callback;
            hook = Win32.SetWindowsHookExW(Win32.WH_KEYBOARD_LL, proc, Win32.GetModuleHandleW(null), 0);
            installed.Set();
            if (hook == IntPtr.Zero) return;
            while (Win32.GetMessageW(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                Win32.TranslateMessage(ref msg);
                Win32.DispatchMessageW(ref msg);
            }
        }) { IsBackground = true, Name = "hotkey" };
        t.Start();
        installed.Wait(3000);
        return Running;
    }

    private IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var k = Marshal.PtrToStructure<Win32.KBDLLHOOKSTRUCT>(lParam);
            int msg = (int)wParam;
            bool down = msg == Win32.WM_KEYDOWN || msg == Win32.WM_SYSKEYDOWN;
            bool up = msg == Win32.WM_KEYUP || msg == Win32.WM_SYSKEYUP;
            if ((k.flags & Win32.LLKHF_INJECTED) == 0) // ignore our own Ctrl+V
            {
                if (k.vkCode == vk)
                {
                    if (down && !isDown) { isDown = true; Ipc.Event("hotkey", new() { ["state"] = "down" }); }
                    else if (up && isDown) { isDown = false; Ipc.Event("hotkey", new() { ["state"] = "up" }); }
                }
                else if (down)
                {
                    if (k.vkCode == 0x1B && ArmEscape) Ipc.Event("key", new() { ["key"] = "escape" });
                    else if (isDown) Ipc.Event("hotkey", new() { ["state"] = "chord" });
                }
            }
        }
        return Win32.CallNextHookEx(hook, nCode, wParam, lParam);
    }
}

/// Types dictated text into the focused field: clipboard + Ctrl+V, then puts back what was on the
/// clipboard (every memory-based format) unless the user copied something meanwhile.
public static class Paster
{
    private static readonly uint ExcludeFromHistory = Win32.RegisterClipboardFormatW("ExcludeClipboardContentFromMonitorProcessing");
    private static readonly uint NoCloudClipboard = Win32.RegisterClipboardFormatW("CanUploadToCloudClipboard");
    private static readonly uint NoHistory = Win32.RegisterClipboardFormatW("CanIncludeInClipboardHistory");
    // Formats whose handle is not a memory block (bitmaps, metafiles, palettes, owner-drawn): not copied.
    private static readonly HashSet<uint> GdiFormats = [2, 3, 9, 14, 0x80, 0x82, 0x83, 0x8E];
    private static IntPtr owner;

    private static IntPtr Owner()
    {
        if (owner == IntPtr.Zero)
            owner = Win32.CreateWindowExW(0, "STATIC", "KlaraHelperClipboard", 0, 0, 0, 0, 0, Win32.HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        return owner;
    }

    private static bool Open()
    {
        for (int i = 0; i < 20; i++)
        {
            if (Win32.OpenClipboard(Owner())) return true;
            Thread.Sleep(25); // another app has it open
        }
        return false;
    }

    private static IntPtr Global(byte[] data)
    {
        var h = Win32.GlobalAlloc(Win32.GMEM_MOVEABLE, (UIntPtr)Math.Max(1, data.Length));
        var p = Win32.GlobalLock(h);
        if (data.Length > 0) Marshal.Copy(data, 0, p, data.Length);
        Win32.GlobalUnlock(h);
        return h;
    }

    private static List<(uint, byte[])> Save(out bool sensitive)
    {
        sensitive = false;
        var saved = new List<(uint, byte[])>();
        uint f = 0;
        while ((f = Win32.EnumClipboardFormats(f)) != 0)
        {
            if (f == ExcludeFromHistory) sensitive = true; // password managers mark secrets like this
            if (GdiFormats.Contains(f)) continue;
            var h = Win32.GetClipboardData(f);
            if (h == IntPtr.Zero) continue;
            var size = (int)(ulong)Win32.GlobalSize(h);
            var p = Win32.GlobalLock(h);
            if (p == IntPtr.Zero) continue;
            if (size <= 0) { Win32.GlobalUnlock(h); continue; }
            var data = new byte[size];
            Marshal.Copy(p, data, 0, size);
            Win32.GlobalUnlock(h);
            saved.Add((f, data));
        }
        return saved;
    }

    public static void Copy(string text, bool transient)
    {
        if (!Open()) throw new HelperException("clipboard busy");
        try
        {
            Win32.EmptyClipboard();
            Win32.SetClipboardData(Win32.CF_UNICODETEXT, Global(Encoding.Unicode.GetBytes(text + "\0")));
            if (transient)
            {
                // Keep dictations out of Win+V history and the cloud clipboard.
                Win32.SetClipboardData(ExcludeFromHistory, Global([0]));
                Win32.SetClipboardData(NoHistory, Global([0, 0, 0, 0]));
                Win32.SetClipboardData(NoCloudClipboard, Global([0, 0, 0, 0]));
            }
        }
        finally { Win32.CloseClipboard(); }
    }

    /// Runs on the helper's clipboard thread; `sent` is called as soon as Ctrl+V went out (the reply),
    /// the old clipboard comes back 1.2 s later.
    public static void Paste(string text, bool restore, Action<bool> sent)
    {
        List<(uint, byte[])> saved = [];
        bool sensitive = false;
        if (restore && Open())
        {
            try { saved = Save(out sensitive); } finally { Win32.CloseClipboard(); }
        }
        Copy(text, transient: true);
        uint ours = Win32.GetClipboardSequenceNumber();
        var inputs = new[] { Win32.Key(0x11, false), Win32.Key(0x56, false), Win32.Key(0x56, true), Win32.Key(0x11, true) };
        bool ok = Win32.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Win32.INPUT>()) == inputs.Length;
        sent(ok);
        if (restore && ok)
        {
            Thread.Sleep(1200);
            if (Win32.GetClipboardSequenceNumber() == ours && Open()) // the user didn't copy something meanwhile
            {
                try
                {
                    Win32.EmptyClipboard();
                    if (!sensitive) foreach (var (f, data) in saved) Win32.SetClipboardData(f, Global(data));
                }
                finally { Win32.CloseClipboard(); }
            }
        }
    }

    public static Dictionary<string, object?> Frontmost()
    {
        var w = Win32.GetForegroundWindow();
        Win32.GetWindowThreadProcessId(w, out var pid);
        var path = Win32.ImagePath(pid);
        var exe = path == null ? "" : Path.GetFileName(path);
        return new() { ["bundleID"] = exe.ToLowerInvariant(), ["name"] = Path.GetFileNameWithoutExtension(exe) };
    }
}
