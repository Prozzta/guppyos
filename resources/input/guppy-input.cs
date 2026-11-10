// Windows-only companion for dictation. stdin/stdout is one JSON object per line:
// {"op":"hook","chord":"Ctrl+Alt+Space"}, {"op":"unhook"}, {"op":"type","text":"..."}, {"op":"quit"}.
// Hook transitions are unsolicited {"ev":"down"} / {"ev":"up"}; all commands reply {"ok":true}.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class GuppyInput
{
    const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105, WM_QUIT = 0x12;
    const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    const int VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SHIFT = 0x10, VK_LWIN = 0x5b, VK_RWIN = 0x5c;
    [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public KEYBDINPUT ki; }
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint id, uint msg, UIntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x, y; }

    static readonly object OutputLock = new object();
    static HookProc callback = Hook;
    static IntPtr hook = IntPtr.Zero;
    static volatile bool enabled, ctrl, alt, shift, win, active;
    static volatile int key = 0x20;
    static bool needCtrl = true, needAlt = true, needShift, needWin;
    static uint mainThread;

    static void Reply(string json) { lock (OutputLock) { Console.WriteLine(json); Console.Out.Flush(); } }
    static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n"); }
    static void Error(string e) { Reply("{\"ok\":false,\"error\":\"" + Esc(e) + "\"}"); }
    static string StringValue(string json, string name) {
        int p = json.IndexOf("\"" + name + "\"", StringComparison.Ordinal); if (p < 0) return null;
        p = json.IndexOf(':', p); if (p < 0) return null; p++; while (p < json.Length && char.IsWhiteSpace(json[p])) p++;
        if (p >= json.Length || json[p++] != '\"') return null; var r = new System.Text.StringBuilder();
        while (p < json.Length) { char c = json[p++]; if (c == '\"') return r.ToString(); if (c != '\\') { r.Append(c); continue; }
            if (p >= json.Length) return null; c = json[p++]; if (c == 'n') r.Append('\n'); else if (c == 'r') r.Append('\r'); else if (c == 't') r.Append('\t');
            else if (c == 'u' && p + 4 <= json.Length) { try { r.Append((char)Convert.ToInt32(json.Substring(p, 4), 16)); p += 4; } catch { return null; } }
            else r.Append(c); }
        return null;
    }
    static bool ParseChord(string chord) {
        if (String.IsNullOrEmpty(chord)) chord = "Ctrl+Alt+Space"; string[] parts = chord.Split('+');
        bool c = false, a = false, s = false, w = false; int target = 0;
        foreach (string raw in parts) { string x = raw.Trim(); int f; if (x.Equals("Ctrl", StringComparison.OrdinalIgnoreCase) || x.Equals("Control", StringComparison.OrdinalIgnoreCase)) c = true;
            else if (x.Equals("Alt", StringComparison.OrdinalIgnoreCase)) a = true; else if (x.Equals("Shift", StringComparison.OrdinalIgnoreCase)) s = true;
            else if (x.Equals("Win", StringComparison.OrdinalIgnoreCase) || x.Equals("Windows", StringComparison.OrdinalIgnoreCase)) w = true;
            else if (x.Equals("Space", StringComparison.OrdinalIgnoreCase)) target = 0x20;
            else if (x.Length == 1 && char.IsLetterOrDigit(x[0])) target = char.ToUpperInvariant(x[0]);
            else if (x.Length >= 2 && x[0] == 'F' && int.TryParse(x.Substring(1), out f) && f >= 1 && f <= 24) target = 0x70 + f - 1;
            else return false; }
        if (target == 0) return false; needCtrl = c; needAlt = a; needShift = s; needWin = w; key = target; return true;
    }
    static bool ModifiersMatch() { return (!needCtrl || ctrl) && (!needAlt || alt) && (!needShift || shift) && (!needWin || win); }
    static IntPtr Hook(int code, IntPtr wp, IntPtr lp) {
        if (code >= 0) { int msg = wp.ToInt32(); var data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lp, typeof(KBDLLHOOKSTRUCT)); int vk = (int)data.vkCode;
            bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN, up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if (vk == VK_CONTROL) ctrl = down ? true : up ? false : ctrl; if (vk == VK_MENU) alt = down ? true : up ? false : alt;
            if (vk == VK_SHIFT) shift = down ? true : up ? false : shift; if (vk == VK_LWIN || vk == VK_RWIN) win = down ? true : up ? false : win;
            if (enabled && vk == key && down && ModifiersMatch() && !active) { active = true; Reply("{\"ev\":\"down\"}"); }
            if (enabled && active && ((vk == key && up) || !ModifiersMatch())) { active = false; Reply("{\"ev\":\"up\"}"); }
        } return CallNextHookEx(hook, code, wp, lp);
    }
    static bool SendUnicode(string text) {
        if (String.IsNullOrEmpty(text)) return true; INPUT[] rows = new INPUT[text.Length * 2];
        for (int i = 0; i < text.Length; i++) { rows[i * 2] = new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wScan = text[i], dwFlags = KEYEVENTF_UNICODE } }; rows[i * 2 + 1] = new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wScan = text[i], dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } }; }
        return SendInput((uint)rows.Length, rows, Marshal.SizeOf(typeof(INPUT))) == rows.Length;
    }
    static bool PasteFallback(string text) {
        try { IDataObject old = Clipboard.GetDataObject(); Clipboard.SetText(text, TextDataFormat.UnicodeText); Thread.Sleep(30);
            INPUT[] rows = new INPUT[] { new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wVk = 0x11 } }, new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wVk = 0x56 } }, new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wVk = 0x56, dwFlags = KEYEVENTF_KEYUP } }, new INPUT { type = INPUT_KEYBOARD, ki = new KEYBDINPUT { wVk = 0x11, dwFlags = KEYEVENTF_KEYUP } } };
            bool ok = SendInput((uint)rows.Length, rows, Marshal.SizeOf(typeof(INPUT))) == rows.Length; Thread.Sleep(30); if (old != null) Clipboard.SetDataObject(old, true); else Clipboard.Clear(); return ok;
        } catch { return false; }
    }
    static void Reader() {
        for (string line; (line = Console.ReadLine()) != null;) { string op = StringValue(line, "op"); if (op == "hook") { string chord = StringValue(line, "chord") ?? "Ctrl+Alt+Space"; if (!ParseChord(chord)) Error("bad chord"); else { enabled = true; Reply("{\"ok\":true,\"op\":\"hook\"}"); } }
            else if (op == "unhook") { enabled = false; if (active) { active = false; Reply("{\"ev\":\"up\"}"); } Reply("{\"ok\":true,\"op\":\"unhook\"}"); }
            else if (op == "type") { string text = StringValue(line, "text"); if (text == null) Error("missing text"); else { bool unicode = SendUnicode(text); bool fallback = !unicode && PasteFallback(text); Reply("{\"ok\":" + (unicode || fallback ? "true" : "false") + ",\"fallback\":" + (fallback ? "true" : "false") + "}"); } }
            else if (op == "ping") Reply("{\"ok\":true,\"op\":\"ping\"}"); else if (op == "quit") { Reply("{\"ok\":true,\"op\":\"quit\"}"); Environment.Exit(0); return; } else Error("unknown op"); }
        Environment.Exit(0);
    }
    [STAThread] static void Main() {
        mainThread = GetCurrentThreadId(); hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, GetModuleHandle(null), 0); if (hook == IntPtr.Zero) { Error("SetWindowsHookEx failed"); return; }
        Thread reader = new Thread(Reader); reader.IsBackground = true; reader.SetApartmentState(ApartmentState.STA); reader.Start(); MSG msg; while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        enabled = false; if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
    }
}
