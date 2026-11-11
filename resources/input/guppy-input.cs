// Windows-only dictation companion. JSON-lines stdin/stdout: hook/unhook/type/echo/selftest/cliptest/focustest/focuspoint/ping/quit.
//
// Threads:
// - main: owns the message queue and the WH_KEYBOARD_LL hook (installed/removed only via queued WM_WORK commands);
// - reader: parses stdin commands (STA, for the clipboard fallback);
// - writer: the ONLY thread that touches stdout. The hook callback and the reader just enqueue rows, so a full or slow
//   stdout pipe can never hold the hook callback past LowLevelHooksTimeout (Windows would silently remove the hook).
//
// Delivery caveat (UIPI): SendInput into a window of a higher integrity level (an elevated app) is dropped by Windows
// yet still reported as inserted, so {"ok":true} means "handed to Windows", not "arrived".
//
// Focus (F1): every real chord-down carries the foreground window ("hwnd"); 'type' must name that window and is refused
// with "focus changed" if another window is in front (checked before the modifier wait, after it, and before a paste).
// Every reply names its op, so the parent can match replies that the two threads (hook vs reader) answer out of order.
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class GuppyInput
{
    const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105, WM_QUIT = 0x12, WM_WORK = 0x8001;
    const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    const int VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SHIFT = 0x10, VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3, VK_LMENU = 0xA4, VK_RMENU = 0xA5, VK_LWIN = 0x5B, VK_RWIN = 0x5C;
    /** Typing waits this long for the user to let go of Ctrl/Alt/Shift/Win, or held modifiers turn letters into shortcuts. */
    const int MODIFIER_WAIT_MS = 2000;
    /** The target app reads a paste asynchronously; the old clipboard comes back only after this. */
    const int PASTE_SETTLE_MS = 600;
    [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x, y; }
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint id, uint msg, UIntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    // BLOB-GAZE: where the user is typing, so the Blob can look there while dictating.
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    static readonly BlockingCollection<string> Output = new BlockingCollection<string>();
    static readonly ConcurrentQueue<int> HookCommands = new ConcurrentQueue<int>();   // 1 = hook (reply), 2 = unhook (reply)
    static readonly HookProc Callback = Hook;
    static IntPtr hook = IntPtr.Zero; static uint mainThread;
    static volatile bool enabled, ctrl, alt, shift, win, active, swallowing; static volatile int key = 0x20;
    static bool needCtrl = true, needAlt = true, needShift, needWin;

    /** Never blocks on the pipe: the writer thread does the I/O. Safe from the hook callback. */
    static void Reply(string json) { try { Output.Add(json); } catch (InvalidOperationException) { /* shutting down */ } }
    static void Writer() { try { foreach (string row in Output.GetConsumingEnumerable()) { Console.WriteLine(row); Console.Out.Flush(); } } catch { /* pipe gone: the parent restarts us */ } }
    static string Esc(string s) { var r = new StringBuilder(); foreach (char c in s) { if (c == '\\') r.Append("\\\\"); else if (c == '\"') r.Append("\\\""); else if (c == '\r') r.Append("\\r"); else if (c == '\n') r.Append("\\n"); else if (c == '\b') r.Append("\\b"); else if (c == '\f') r.Append("\\f"); else if (c < 0x20) r.Append("\\u00").Append(((int)c).ToString("X2")); else r.Append(c); } return r.ToString(); }
    static void Error(string op, string e) { Reply("{\"ok\":false,\"op\":\"" + Esc(op ?? "") + "\",\"error\":\"" + Esc(e) + "\"}"); }
    static long Foreground() { return GetForegroundWindow().ToInt64(); }
    /** BLOB-GAZE: the focus point at chord-down, in PHYSICAL screen pixels (per-monitor aware for this call only; the parent
     *  converts to DIPs). The caret when the app has a Win32 caret, else the focused control's centre, else the window's.
     *  Returns the JSON fields to append (",\"fx\":..,\"fy\":..,\"fk\":\"caret|field|window\"") or "" when unknown. Cheap, safe in the hook callback. */
    static string FocusPoint(IntPtr fg) {
        if (fg == IntPtr.Zero) return "";
        IntPtr prev = IntPtr.Zero; bool scoped = false;
        try { prev = SetThreadDpiAwarenessContext(new IntPtr(-4)); scoped = prev != IntPtr.Zero; } catch (EntryPointNotFoundException) { /* before Windows 10 1607 */ }
        try {
            var gi = new GUITHREADINFO(); gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            if (GetGUIThreadInfo(GetWindowThreadProcessId(fg, IntPtr.Zero), ref gi)) {
                if (gi.hwndCaret != IntPtr.Zero) { var p = new POINT { x = (gi.rcCaret.left + gi.rcCaret.right) / 2, y = (gi.rcCaret.top + gi.rcCaret.bottom) / 2 }; if (ClientToScreen(gi.hwndCaret, ref p)) return Pt(p.x, p.y, "caret"); }
                RECT f; if (gi.hwndFocus != IntPtr.Zero && GetWindowRect(gi.hwndFocus, out f)) return Pt((f.left + f.right) / 2, (f.top + f.bottom) / 2, "field");
            }
            RECT w; if (GetWindowRect(fg, out w)) return Pt((w.left + w.right) / 2, (w.top + w.bottom) / 2, "window");
            return "";
        } catch { return ""; }
        finally { if (scoped) { try { SetThreadDpiAwarenessContext(prev); } catch { } } }
    }
    static string Pt(int x, int y, string kind) { return ",\"fx\":" + x + ",\"fy\":" + y + ",\"fk\":\"" + kind + "\""; }
    static long ParseHwnd(string s) { long v; return s != null && long.TryParse(s, out v) && v > 0 ? v : 0; }
    /** F1: text may go only to the window that was in front at chord-down. null = allowed. */
    static string FocusRefusal(long want, long now) { if (want == 0) return "no target window"; if (now != want) return "focus changed"; return null; }
    static string StringValue(string json, string name) {
        int p = json.IndexOf("\"" + name + "\"", StringComparison.Ordinal); if (p < 0 || (p = json.IndexOf(':', p)) < 0) return null; p++; while (p < json.Length && char.IsWhiteSpace(json[p])) p++;
        if (p >= json.Length || json[p++] != '\"') return null; var r = new StringBuilder();
        while (p < json.Length) { char c = json[p++]; if (c == '\"') return r.ToString(); if (c != '\\') { r.Append(c); continue; } if (p >= json.Length) return null; c = json[p++];
            if (c == 'n') r.Append('\n'); else if (c == 'r') r.Append('\r'); else if (c == 't') r.Append('\t'); else if (c == 'b') r.Append('\b'); else if (c == 'f') r.Append('\f');
            else if (c == 'u' && p + 4 <= json.Length) { try { r.Append((char)Convert.ToInt32(json.Substring(p, 4), 16)); p += 4; } catch { return null; } } else r.Append(c); }
        return null;
    }
    static bool ParseChord(string chord) {
        if (String.IsNullOrEmpty(chord)) chord = "Ctrl+Alt+Space"; bool c = false, a = false, s = false, w = false; int target = 0;
        foreach (string raw in chord.Split('+')) { string x = raw.Trim(); int f; if (x.Equals("Ctrl", StringComparison.OrdinalIgnoreCase) || x.Equals("Control", StringComparison.OrdinalIgnoreCase)) c = true;
            else if (x.Equals("Alt", StringComparison.OrdinalIgnoreCase)) a = true; else if (x.Equals("Shift", StringComparison.OrdinalIgnoreCase)) s = true;
            else if (x.Equals("Win", StringComparison.OrdinalIgnoreCase) || x.Equals("Windows", StringComparison.OrdinalIgnoreCase)) w = true; else if (x.Equals("Space", StringComparison.OrdinalIgnoreCase)) target = 0x20;
            else if (x.Length == 1 && char.IsLetterOrDigit(x[0])) target = char.ToUpperInvariant(x[0]); else if (x.Length >= 2 && x[0] == 'F' && int.TryParse(x.Substring(1), out f) && f >= 1 && f <= 24) target = 0x70 + f - 1; else return false; }
        if (target == 0) return false; needCtrl = c; needAlt = a; needShift = s; needWin = w; key = target; return true;
    }
    static bool ModifiersMatch() { return (!needCtrl || ctrl) && (!needAlt || alt) && (!needShift || shift) && (!needWin || win); }
    static bool IsCtrl(int vk) { return vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL; } static bool IsAlt(int vk) { return vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU; } static bool IsShift(int vk) { return vk == VK_SHIFT || vk == VK_LSHIFT || vk == VK_RSHIFT; }
    // If the target key-up is never seen (e.g. Win+L while holding the chord), 'swallowing' stays set and the next plain press
    // of the target key is swallowed once (its up clears it). Accepted: the LL hook carries no repeat flag to tell them apart.
    static bool Transition(int vk, bool down, bool up) {
        if (IsCtrl(vk)) ctrl = down ? true : up ? false : ctrl; if (IsAlt(vk)) alt = down ? true : up ? false : alt; if (IsShift(vk)) shift = down ? true : up ? false : shift; if (vk == VK_LWIN || vk == VK_RWIN) win = down ? true : up ? false : win;
        bool swallow = false;
        if (enabled && vk == key && down && ModifiersMatch() && !active) { active = true; swallowing = true; swallow = true; IntPtr fg = GetForegroundWindow(); Reply("{\"ev\":\"down\",\"hwnd\":\"" + fg.ToInt64() + "\"" + FocusPoint(fg) + "}"); }
        else if (enabled && vk == key && down && swallowing) swallow = true;
        if (enabled && active && ((vk == key && up) || !ModifiersMatch())) { active = false; Reply("{\"ev\":\"up\"}"); }
        if (vk == key && up && swallowing) { swallow = true; swallowing = false; }
        return swallow;
    }
    static IntPtr Hook(int code, IntPtr wp, IntPtr lp) { if (code >= 0) { int msg = wp.ToInt32(); int vk = (int)((KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lp, typeof(KBDLLHOOKSTRUCT))).vkCode; bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN, up = msg == WM_KEYUP || msg == WM_SYSKEYUP; if (Transition(vk, down, up)) return (IntPtr)1; } return CallNextHookEx(hook, code, wp, lp); }
    /** Main thread: every queued command is applied and answered, in order (a hook quickly followed by unhook gets both replies). */
    static void ApplyHooks() {
        int cmd;
        while (HookCommands.TryDequeue(out cmd)) {
            if (cmd == 1) { if (hook == IntPtr.Zero) hook = SetWindowsHookEx(WH_KEYBOARD_LL, Callback, GetModuleHandle(null), 0); if (hook == IntPtr.Zero) { enabled = false; Error("hook", "SetWindowsHookEx failed (" + Marshal.GetLastWin32Error() + ")"); } else Reply("{\"ok\":true,\"op\":\"hook\"}"); }
            else if (cmd == 2) { if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; } Reply("{\"ok\":true,\"op\":\"unhook\"}"); }
        }
    }
    static void RequestHook(int cmd) { HookCommands.Enqueue(cmd); PostThreadMessage(mainThread, WM_WORK, UIntPtr.Zero, IntPtr.Zero); }
    static bool ModifiersHeld() { foreach (int vk in new int[] { VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN }) if ((GetAsyncKeyState(vk) & 0x8000) != 0) return true; return false; }
    static bool WaitModifiersReleased() { int waited = 0; while (ModifiersHeld()) { if (waited >= MODIFIER_WAIT_MS) return false; Thread.Sleep(25); waited += 25; } return true; }
    static uint SendUnicode(string text) { if (String.IsNullOrEmpty(text)) return 0; INPUT[] rows = new INPUT[text.Length * 2]; for (int i = 0; i < text.Length; i++) { rows[i * 2] = new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wScan = text[i], dwFlags = KEYEVENTF_UNICODE } }; rows[i * 2 + 1] = new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wScan = text[i], dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } }; } return SendInput((uint)rows.Length, rows, Marshal.SizeOf(typeof(INPUT))); }

    // ---- clipboard fallback (S5) -------------------------------------------------------------------------------------
    /** Marks a clipboard entry as transient: not in Win+V history, not cloud-synced, ignored by clipboard monitors. */
    static void MarkTransient(DataObject d) {
        d.SetData("ExcludeClipboardContentFromMonitorProcessing", false, new MemoryStream(BitConverter.GetBytes(1)));
        d.SetData("CanIncludeInClipboardHistory", false, new MemoryStream(BitConverter.GetBytes(0)));
        d.SetData("CanUploadToCloudClipboard", false, new MemoryStream(BitConverter.GetBytes(0)));
    }
    static DataObject TransientText(string text) { var d = new DataObject(); d.SetData(DataFormats.UnicodeText, false, text); MarkTransient(d); return d; }
    /** A real copy of every format the source holds NOW. GetDataObject() is a live proxy: once our text replaces the
     *  clipboard, delayed-render formats of the source app would be gone, so they are read out before that. */
    static DataObject CopyFormats(IDataObject src) {
        if (src == null) return null; var copy = new DataObject(); int n = 0;
        foreach (string f in src.GetFormats(false)) { try { object v = src.GetData(f, false); if (v != null) { copy.SetData(f, false, v); n++; } } catch { /* a format that cannot be rendered is skipped */ } }
        return n > 0 ? copy : null;
    }
    /** Returns whether the paste was sent. 'restored' is false when the old clipboard could not be put back (the paste still
     *  happened, so the reply stays ok). 'why' is set when focus moved and nothing was pasted. A huge clipboard (Excel, an
     *  image) makes the snapshot slow: it runs BEFORE anything is changed, so the parent's type timeout killing us there
     *  leaves the clipboard untouched and types nothing. */
    static bool PasteFallback(string text, long want, out bool restored, out string why) {
        restored = true; why = null; DataObject saved; uint ours;
        try {
            saved = CopyFormats(Clipboard.GetDataObject());
            Clipboard.SetDataObject(TransientText(text), true);
            ours = GetClipboardSequenceNumber();
        } catch { return false; }
        bool ok = false;
        try {
            why = FocusRefusal(want, Foreground());
            if (why == null) {
                INPUT[] rows = new INPUT[] { new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wVk = 0x11 } }, new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wVk = 0x56 } }, new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wVk = 0x56, dwFlags = KEYEVENTF_KEYUP } }, new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wVk = 0x11, dwFlags = KEYEVENTF_KEYUP } } };
                ok = SendInput((uint)rows.Length, rows, Marshal.SizeOf(typeof(INPUT))) == rows.Length;
                Thread.Sleep(PASTE_SETTLE_MS);
            }
        } catch { ok = false; }
        // Restore only if the clipboard still holds our entry: a newer copy by the user or an app wins.
        try { if (GetClipboardSequenceNumber() == ours) { if (saved != null) { MarkTransient(saved); Clipboard.SetDataObject(saved, true); } else Clipboard.Clear(); } }
        catch { restored = false; }
        return ok;
    }
    /** Exercises the snapshot and the transient marking on private DataObjects: never touches the real clipboard. */
    static void ClipTest() {
        var src = new DataObject(); src.SetData(DataFormats.UnicodeText, false, "orig ü"); src.SetData("Guppy.Test", false, new MemoryStream(new byte[] { 7, 8, 9 }));
        DataObject copy = CopyFormats(src); string text = copy == null ? null : copy.GetData(DataFormats.UnicodeText, false) as string;
        var ms = copy == null ? null : copy.GetData("Guppy.Test", false) as MemoryStream; string custom = ms == null ? "" : BitConverter.ToString(ms.ToArray());
        DataObject t = TransientText("dictated"); var hist = t.GetData("CanIncludeInClipboardHistory", false) as MemoryStream; var cloud = t.GetData("CanUploadToCloudClipboard", false) as MemoryStream;
        bool excluded = t.GetDataPresent("ExcludeClipboardContentFromMonitorProcessing", false) && hist != null && BitConverter.ToInt32(hist.ToArray(), 0) == 0 && cloud != null && BitConverter.ToInt32(cloud.ToArray(), 0) == 0;
        Reply("{\"ok\":true,\"op\":\"cliptest\",\"text\":\"" + Esc(text ?? "") + "\",\"custom\":\"" + Esc(custom) + "\",\"transient\":" + (excluded ? "true" : "false") + ",\"transientText\":\"" + Esc((t.GetData(DataFormats.UnicodeText, false) as string) ?? "") + "\"}");
    }

    /** F1 without typing anything: FocusRefusal on given values ("now" defaults to the real foreground window). */
    static void FocusTest(string line) {
        string nowRaw = StringValue(line, "now"); long want = ParseHwnd(StringValue(line, "want")); long now = nowRaw == null ? Foreground() : ParseHwnd(nowRaw);
        Reply("{\"ok\":true,\"op\":\"focustest\",\"refusal\":\"" + Esc(FocusRefusal(want, now) ?? "") + "\"}");
    }
    static void Selftest() { if (hook != IntPtr.Zero) { Error("selftest", "selftest unavailable while hooked"); return; } bool oe = enabled, oc = ctrl, oa = alt, os = shift, ow = win, ox = active, oz = swallowing; int ok = key; bool nc = needCtrl, na = needAlt, ns = needShift, nw = needWin; ParseChord("Ctrl+Alt+Space"); enabled = true; ctrl = alt = shift = win = active = swallowing = false; bool[] rows = new bool[] { Transition(VK_LCONTROL, true, false), Transition(VK_LMENU, true, false), Transition(0x20, true, false), Transition(0x20, false, true), Transition(VK_LMENU, false, true), Transition(0x20, true, false), Transition(0x20, false, true) }; enabled = oe; ctrl = oc; alt = oa; shift = os; win = ow; active = ox; swallowing = oz; key = ok; needCtrl = nc; needAlt = na; needShift = ns; needWin = nw; Reply("{\"ok\":true,\"op\":\"selftest\",\"swallow\":[" + String.Join(",", Array.ConvertAll(rows, x => x ? "true" : "false")) + "]}"); }
    static void Reader() {
        for (string line; (line = Console.ReadLine()) != null;) {
            string op = StringValue(line, "op");
            if (op == "hook") { string chord = StringValue(line, "chord") ?? "Ctrl+Alt+Space"; if (!ParseChord(chord)) Error("hook", "bad chord"); else { enabled = true; RequestHook(1); } }
            else if (op == "unhook") { enabled = false; if (active) { active = false; Reply("{\"ev\":\"up\"}"); } swallowing = false; RequestHook(2); }
            else if (op == "type") {
                string text = StringValue(line, "text"); long want = ParseHwnd(StringValue(line, "hwnd")); string refuse;
                if (text == null) Error("type", "missing text");
                else if (text.Length == 0) Error("type", "empty text");
                else if ((refuse = FocusRefusal(want, Foreground())) != null) Error("type", refuse);
                else if (!WaitModifiersReleased()) Error("type", "modifier keys still held");
                else if ((refuse = FocusRefusal(want, Foreground())) != null) Error("type", refuse);   // switched while letting go
                else {
                    uint n = SendUnicode(text); uint total = (uint)(text.Length * 2); bool restored = true; string why = null;
                    bool fallback = n == 0 && PasteFallback(text, want, out restored, out why);
                    if (n == 0 && !fallback && why != null) Error("type", why);
                    else Reply("{\"ok\":" + ((n == total || fallback) ? "true" : "false") + ",\"op\":\"type\",\"fallback\":" + (fallback ? "true" : "false") + ",\"restored\":" + (restored ? "true" : "false") + "}");
                }
            }
            else if (op == "echo") { string text = StringValue(line, "text"); if (text == null) Error("echo", "missing text"); else Reply("{\"ok\":true,\"op\":\"echo\",\"text\":\"" + Esc(text) + "\"}"); }
            else if (op == "selftest") Selftest(); else if (op == "cliptest") ClipTest(); else if (op == "focustest") FocusTest(line); else if (op == "focuspoint") { IntPtr fg = GetForegroundWindow(); Reply("{\"ok\":true,\"op\":\"focuspoint\",\"hwnd\":\"" + fg.ToInt64() + "\"" + FocusPoint(fg) + "}"); } else if (op == "ping") Reply("{\"ok\":true,\"op\":\"ping\"}");
            else if (op == "quit") { enabled = false; swallowing = false; Reply("{\"ok\":true,\"op\":\"quit\"}"); PostThreadMessage(mainThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero); return; }
            else Error(op ?? "", "unknown op");
        }
        PostThreadMessage(mainThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
    }
    [STAThread] static void Main() {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        mainThread = GetCurrentThreadId(); MSG initial; PeekMessage(out initial, IntPtr.Zero, 0, 0, 0);   // the queue exists before any command arrives
        Thread writer = new Thread(Writer); writer.IsBackground = true; writer.Start();
        Thread reader = new Thread(Reader); reader.IsBackground = true; reader.SetApartmentState(ApartmentState.STA); reader.Start();
        MSG msg; while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) if (msg.message == WM_WORK) ApplyHooks();
        enabled = false; swallowing = false; if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
        Output.CompleteAdding(); writer.Join(2000);   // the quit reply is flushed before exit
    }
}
