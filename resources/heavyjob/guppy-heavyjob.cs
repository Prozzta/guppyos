// HEAVY-CPU-OPTIONS-191: the Windows helper that puts a heavy job (an install, build, full suite or
// bench an agent runs) into a named Job Object with the user's limits. Built from this source with the
// in-box .NET Framework compiler at build time (tools/build-heavyjob.cjs); never committed as a binary.
//
//   guppy-heavyjob join <jobName> <background 0|1> <cap 0|1>
//       Guppy writes it as `guppy-heavyjob join <job> <b> <c>; <the command>`, one line that every
//       shell reads: bash, sh and PowerShell run the two statements in turn; cmd has no `;`
//       separator and hands this helper the rest of the line, which it then runs itself under
//       `cmd /d /s /c` (exit code passed through).
//       Assigns the shell running this line to the job: the run of consecutive shell ancestors
//       (bash/sh/powershell/pwsh/cmd, a Git Bash fork stub included) up to the agent CLI. Every process
//       the rest of the command starts is then created inside the job, and the OS holds it there:
//       no BREAKAWAY flag, so even libuv's silent-breakaway children stop at this job. No
//       KILL_ON_JOB_CLOSE: the job lives as long as any process in it (a backgrounded job outlives
//       the tool call). Always exits 0 so the command after it keeps its own exit code; a failure is
//       one line on stderr.
//   guppy-heavyjob set <jobName> <background 0|1> <cap 0|1>
//       Live apply: replaces the job's limits. A limit turned off also resets the members (removing a
//       limit leaves a process where the limit put it): priority NORMAL, CPU rate disabled; affinity
//       is never changed by this helper.
//   guppy-heavyjob list <jobName>
//       One JSON line per process in the job: pid, name, priorityClass, cpus, mask, createdMs.
//   guppy-heavyjob query <jobName>
//       HALFCORES-OVERSUBSCRIBE: read-only, the job's OWN limits as one JSON line:
//       {"background":bool,"cap":bool,"rate":5000|0}. The cap is JobObjectCpuRateControlInformation
//       (class 15), hard-capped at 50% of the whole machine; it never changes affinity.
//   guppy-heavyjob serve
//       Guppy's own channel (stdin/stdout, one JSON line per request): create, set, list, query and close
//       <job>. It holds the handle of every job Guppy made, so a job keeps its name (a live change and
//       the join line find it) until Guppy lets it go.
//       HEAVY-LOCK-RELEASE-LAG-197: every job it creates is tied to one completion port; a process of
//       a job exiting (normally or not) or the job going empty is written at once as an unsolicited
//       line {"event":"exit","job":<id>,"msg":<n>,"pid":<pid>}, between replies, never inside one.
//       Windows does not guarantee these messages, so Guppy's own checks stay as the fallback.
//
// background = PriorityClass BELOW_NORMAL (CPU priority only). cap = 50.00% CPU rate of the whole
// machine, via ENABLE|HARD_CAP, with all logical processors still visible.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

static class HeavyJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_LIMIT
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct CPU_RATE { public uint ControlFlags, CpuRate; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref CPU_RATE info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool SetPriorityClass(IntPtr h, uint cls);
    [DllImport("kernel32.dll")] static extern bool GetProcessAffinityMask(IntPtr h, out UIntPtr proc, out UIntPtr sys);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern int GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [StructLayout(LayoutKind.Sequential)] struct PORT_INFO { public IntPtr CompletionKey, CompletionPort; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref PORT_INFO info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr overlapped, uint ms);

    const uint LIMIT_PRIORITY_CLASS = 0x20;
    const uint BELOW_NORMAL = 0x4000, NORMAL = 0x20;
    const uint CPU_RATE_ENABLE = 0x1, CPU_RATE_HARD_CAP = 0x4, CPU_RATE_50_PERCENT = 5000;
    const uint JOB_ALL = 0x1F001F;
    const uint PROC_SET_QUOTA_TERMINATE_QUERY = 0x0100 | 0x0001 | 0x0400 | 0x0200; // SET_QUOTA|TERMINATE|QUERY_INFORMATION|SET_INFORMATION
    static readonly HashSet<string> Shells = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "bash.exe", "sh.exe", "dash.exe", "zsh.exe", "powershell.exe", "pwsh.exe", "cmd.exe" };

    static int Main(string[] a)
    {
        try
        {
            if (a.Length >= 4 && a[0] == "join") return Join(JobName(a[1]), a[2] == "1", a[3].TrimEnd(';') == "1", a.Length > 4 || a[3].EndsWith(";") ? CmdRest() : null);
            if (a.Length == 4 && a[0] == "set") return Set(JobName(a[1]), a[2] == "1", a[3] == "1");
            if (a.Length == 2 && a[0] == "list") return List(JobName(a[1]));
            if (a.Length == 2 && a[0] == "query") return Query(JobName(a[1]));
            if (a.Length == 1 && a[0] == "serve") return Serve();
        }
        catch (Exception e) { Console.Error.WriteLine("[guppy] heavy-job limits not applied: " + e.Message); return a.Length > 0 && a[0] == "join" ? 0 : 3; }
        Console.Error.WriteLine("usage: guppy-heavyjob join|set <job> <background 0|1> <cap 0|1> | list <job> | query <job> | serve");
        return 2;
    }

    // Only Guppy's own job names: Local\guppy-heavy-<id>.
    static string JobName(string id)
    {
        foreach (char c in id) if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) throw new ArgumentException("bad job id");
        return "Local\\guppy-heavy-" + id;
    }

    static EXT_LIMIT Limits(bool background)
    {
        var x = new EXT_LIMIT();
        if (background) { x.Basic.LimitFlags |= LIMIT_PRIORITY_CLASS; x.Basic.PriorityClass = BELOW_NORMAL; }
        return x;
    }

    static void Apply(IntPtr job, bool background, bool cap)
    {
        var x = Limits(background);
        if (!SetInformationJobObject(job, 9, ref x, Marshal.SizeOf(typeof(EXT_LIMIT))))
            throw new Exception("SetInformationJobObject failed (" + Marshal.GetLastWin32Error() + ")");
        var rate = new CPU_RATE { ControlFlags = cap ? CPU_RATE_ENABLE | CPU_RATE_HARD_CAP : 0, CpuRate = cap ? CPU_RATE_50_PERCENT : 0 };
        if (!SetInformationJobObject(job, 15, ref rate, Marshal.SizeOf(typeof(CPU_RATE))))
            throw new Exception("SetInformationJobObject CPU rate failed (" + Marshal.GetLastWin32Error() + ")");
    }

    // cmd: what follows `<cap>;` on this process's own command line, as cmd passed it.
    static string CmdRest()
    {
        var m = System.Text.RegularExpressions.Regex.Match(Environment.CommandLine, @"\bjoin\s+[A-Za-z0-9_-]+\s+[01]\s+[01];");
        return m.Success ? Environment.CommandLine.Substring(m.Index + m.Length).TrimStart() : ""; // a trailing space can be the command's own
    }

    static int Join(string name, bool background, bool cap, string cmdRest)
    {
        // The command always runs: a failed join is one line on stderr, never a lost command.
        try { JoinChain(name, background, cap, cmdRest != null); }
        catch (Exception e) { Console.Error.WriteLine("[guppy] heavy-job limits not applied: " + e.Message); }
        if (string.IsNullOrEmpty(cmdRest)) return 0;
        // CODEX-CMD-COMPUTED-SHELL-192: cmd already parsed the rest once (carets taken, %VAR%
        // expanded). The second cmd must take it as it is: every % is %GUPPY_HEAVYJOB_PCT% (one %),
        // every ^ & | < > outside quotes is escaped, and delayed expansion is off.
        var psi = new System.Diagnostics.ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", "/d /v:off /s /c \"" + EscapeRest(cmdRest) + "\"") { UseShellExecute = false };
        psi.EnvironmentVariables["GUPPY_HEAVYJOB_PCT"] = "%";
        using (var p = System.Diagnostics.Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
    }

    // The rest as cmd's second parse gives it back unchanged. Parentheses stay: they are only
    // special at the start of a block, which the rest already was.
    static string EscapeRest(string rest)
    {
        var sb = new System.Text.StringBuilder();
        bool quoted = false;
        foreach (char c in rest)
        {
            if (c == '%') { sb.Append("%GUPPY_HEAVYJOB_PCT%"); continue; }
            if (c == '"') quoted = !quoted;
            else if (!quoted && "^&|<>".IndexOf(c) >= 0) sb.Append('^');
            sb.Append(c);
        }
        return sb.ToString();
    }

    static int JoinChain(string name, bool background, bool cap, bool self)
    {
        List<int> hosts;
        List<int> chain = ShellChain(out hosts);
        if (self) chain.Insert(0, GetCurrentProcessId()); // what this helper runs for cmd starts inside the job
        if (chain.Count == 0) { Console.Error.WriteLine("[guppy] heavy-job limits not applied: no shell to join"); return 0; }
        // Guppy created it (with the limits as they are NOW: a live change may have followed). Only a
        // job this line had to create itself gets the limits from its own arguments.
        IntPtr job = OpenJobObjectW(JOB_ALL, false, name);
        if (job == IntPtr.Zero)
        {
            job = CreateJobObjectW(IntPtr.Zero, name);
            if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed (" + Marshal.GetLastWin32Error() + ")");
            Apply(job, background, cap);
        }
        // Top of the chain first: the shell that will start the command's processes joins before the
        // fork stub below it exits.
        for (int i = chain.Count - 1; i >= 0; i--)
        {
            IntPtr h = OpenProcess(PROC_SET_QUOTA_TERMINATE_QUERY, false, chain[i]);
            if (h == IntPtr.Zero) { if (i == chain.Count - 1) throw new Exception("OpenProcess " + chain[i] + " failed (" + Marshal.GetLastWin32Error() + ")"); continue; }
            bool ok = AssignProcessToJobObject(job, h);
            int err = Marshal.GetLastWin32Error();
            CloseHandle(h);
            if (!ok && i == chain.Count - 1) throw new Exception("AssignProcessToJobObject failed (" + err + ")");
        }
        // A shell's console host (conhost.exe, its child) started with the shell, before this line:
        // it joins too, so nothing in the call's tree is left outside the job. Best effort.
        foreach (int pid in hosts)
        {
            IntPtr h = OpenProcess(PROC_SET_QUOTA_TERMINATE_QUERY, false, pid);
            if (h == IntPtr.Zero) continue;
            AssignProcessToJobObject(job, h);
            CloseHandle(h);
        }
        CloseHandle(job);
        return 0;
    }

    // The consecutive shell ancestors of this process, nearest first, each created before its child
    // (a recycled pid is never taken for a parent); `hosts`: their conhost.exe children.
    static List<int> ShellChain(out List<int> hosts)
    {
        var parent = new Dictionary<int, int>(); var image = new Dictionary<int, string>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
        var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
        if (Process32FirstW(snap, ref e)) do { parent[(int)e.th32ProcessID] = (int)e.th32ParentProcessID; image[(int)e.th32ProcessID] = e.szExeFile; } while (Process32NextW(snap, ref e));
        CloseHandle(snap);
        var chain = new List<int>();
        int child = GetCurrentProcessId(); long childCreated = Created(child);
        int p;
        while (parent.TryGetValue(child, out p) && image.ContainsKey(p) && Shells.Contains(image[p]))
        {
            long c = Created(p);
            if (c == 0 || c > childCreated) break;
            chain.Add(p); child = p; childCreated = c;
        }
        hosts = new List<int>();
        foreach (var kv in parent)
        {
            if (!chain.Contains(kv.Value) || !string.Equals(image[kv.Key], "conhost.exe", StringComparison.OrdinalIgnoreCase)) continue;
            long hc = Created(kv.Key);
            if (hc != 0 && hc >= Created(kv.Value)) hosts.Add(kv.Key);
        }
        return chain;
    }

    static long Created(int pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return 0;
        long c, x, k, u; bool ok = GetProcessTimes(h, out c, out x, out k, out u); CloseHandle(h);
        return ok ? c : 0;
    }

    static int Set(string name, bool background, bool cap)
    {
        IntPtr job = OpenJobObjectW(JOB_ALL, false, name);
        if (job == IntPtr.Zero) { Console.Error.WriteLine("no job " + name); return 1; }
        try { SetJob(job, background, cap); } finally { CloseHandle(job); }
        return 0;
    }

    static void SetJob(IntPtr job, bool background, bool cap)
    {
        Apply(job, background, cap);
        foreach (int pid in Members(job))
        {
            IntPtr h = OpenProcess(0x0200 | 0x0400, false, pid); // SET_INFORMATION | QUERY_INFORMATION
            if (h == IntPtr.Zero) continue;
            if (!background && GetPriorityClass(h) == BELOW_NORMAL) SetPriorityClass(h, NORMAL);
            CloseHandle(h);
        }
    }

    static List<int> Members(IntPtr job)
    {
        int cap = 4096, size = 8 + cap * IntPtr.Size; IntPtr buf = Marshal.AllocHGlobal(size);
        var r = new List<int>();
        try
        {
            if (!QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) return r; // JobObjectBasicProcessIdList
            int n = Marshal.ReadInt32(buf, 4);
            for (int i = 0; i < n; i++) r.Add((int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size));
        }
        finally { Marshal.FreeHGlobal(buf); }
        return r;
    }

    static int Query(string name)
    {
        IntPtr job = OpenJobObjectW(JOB_ALL, false, name);
        if (job == IntPtr.Zero) { Console.Error.WriteLine("no job " + name); return 1; }
        try { Console.Out.Write(QueryJob(job) + "\n"); } finally { CloseHandle(job); }
        return 0;
    }

    // The job's own priority and CPU-rate limits. A hard cap never sets an affinity limit.
    static string QueryJob(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(BASIC_LIMIT)); IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 2, buf, size, IntPtr.Zero))
                throw new Exception("QueryInformationJobObject failed (" + Marshal.GetLastWin32Error() + ")");
            var b = (BASIC_LIMIT)Marshal.PtrToStructure(buf, typeof(BASIC_LIMIT));
            bool background = (b.LimitFlags & LIMIT_PRIORITY_CLASS) != 0 && b.PriorityClass == BELOW_NORMAL;
            int rsize = Marshal.SizeOf(typeof(CPU_RATE)); IntPtr rbuf = Marshal.AllocHGlobal(rsize);
            try {
                if (!QueryInformationJobObject(job, 15, rbuf, rsize, IntPtr.Zero)) throw new Exception("QueryInformationJobObject CPU rate failed (" + Marshal.GetLastWin32Error() + ")");
                var rate = (CPU_RATE)Marshal.PtrToStructure(rbuf, typeof(CPU_RATE));
                bool cap = (rate.ControlFlags & (CPU_RATE_ENABLE | CPU_RATE_HARD_CAP)) == (CPU_RATE_ENABLE | CPU_RATE_HARD_CAP) && rate.CpuRate == CPU_RATE_50_PERCENT;
                return "{\"background\":" + (background ? "true" : "false") + ",\"cap\":" + (cap ? "true" : "false") + ",\"rate\":" + (cap ? CPU_RATE_50_PERCENT : 0) + ",\"affinity\":null}";
            } finally { Marshal.FreeHGlobal(rbuf); }
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    static int List(string name)
    {
        IntPtr job = OpenJobObjectW(JOB_ALL, false, name);
        if (job == IntPtr.Zero) { Console.Error.WriteLine("no job " + name); return 1; }
        try { Console.Out.Write(ListJob(job, "\n")); } finally { CloseHandle(job); }
        return 0;
    }

    static string ListJob(IntPtr job, string sep)
    {
        var rows = new List<string>();
        var names = new Dictionary<int, string>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
        var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
        if (Process32FirstW(snap, ref e)) do { names[(int)e.th32ProcessID] = e.szExeFile; } while (Process32NextW(snap, ref e));
        CloseHandle(snap);
        foreach (int pid in Members(job))
        {
            IntPtr h = OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) continue;
            UIntPtr pm, sm; GetProcessAffinityMask(h, out pm, out sm); uint pc = GetPriorityClass(h);
            long cr, ex, kt, ut; long createdMs = GetProcessTimes(h, out cr, out ex, out kt, out ut) ? (cr - 116444736000000000L) / 10000 : 0;
            CloseHandle(h);
            ulong m = (ulong)pm; int bits = 0; for (ulong t = m; t != 0; t >>= 1) bits += (int)(t & 1);
            string nm; names.TryGetValue(pid, out nm);
            rows.Add("{\"pid\":" + pid + ",\"name\":\"" + (nm ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"priorityClass\":" + pc + ",\"cpus\":" + bits + ",\"mask\":\"0x" + m.ToString("X") + "\",\"createdMs\":" + createdMs + "}");
        }
        return rows.Count == 0 ? "" : string.Join(sep, rows) + (sep == "\n" ? "\n" : "");
    }

    // Guppy's side: a long-lived process that HOLDS each job's handle. A named job loses its name
    // when its last handle closes even while processes are still in it, so without a holder a
    // running job could no longer be found for a live change of the options. One request per line
    // on stdin, one JSON reply per line on stdout; exits when stdin closes (Guppy quit), which
    // leaves every limit in force on the processes still running.
    //   create <id> <b> <h>   create the job with these limits (before the command runs)
    //   set <id> <b> <h>      change them on a running job (live apply; a limit turned off resets)
    //   list <id>             the processes in the job
    //   close <id>            drop the job's handle (Guppy is done with it)
    // HEAVY-LOCK-RELEASE-LAG-197: the job messages that mean a process of the job is gone.
    const uint MSG_ACTIVE_PROCESS_ZERO = 4, MSG_EXIT_PROCESS = 7, MSG_ABNORMAL_EXIT_PROCESS = 8;
    const int JobObjectAssociateCompletionPortInformation = 7;
    static readonly object Out = new object();
    static readonly Dictionary<long, string> PortKeys = new Dictionary<long, string>();

    static void Write(string line) { lock (Out) { Console.Out.WriteLine(line); Console.Out.Flush(); } }

    // Ties a new job to the port under a fresh key. A failure only loses the early notice.
    static long Watch(IntPtr port, IntPtr job, string id, ref long next)
    {
        if (port == IntPtr.Zero) return 0;
        long key = ++next;
        lock (PortKeys) PortKeys[key] = id;
        var info = new PORT_INFO { CompletionKey = (IntPtr)key, CompletionPort = port };
        if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, ref info, Marshal.SizeOf(typeof(PORT_INFO))))
        { lock (PortKeys) PortKeys.Remove(key); return 0; }
        return key;
    }

    static void PortLoop(IntPtr port)
    {
        uint msg; UIntPtr key; IntPtr pid;
        while (GetQueuedCompletionStatus(port, out msg, out key, out pid, 0xFFFFFFFF))
        {
            if (msg != MSG_EXIT_PROCESS && msg != MSG_ABNORMAL_EXIT_PROCESS && msg != MSG_ACTIVE_PROCESS_ZERO) continue;
            string id;
            lock (PortKeys) if (!PortKeys.TryGetValue((long)key.ToUInt64(), out id)) continue;
            Write("{\"event\":\"exit\",\"job\":\"" + id + "\",\"msg\":" + msg + ",\"pid\":" + pid.ToInt64() + "}");
        }
    }

    static int Serve()
    {
        var jobs = new Dictionary<string, IntPtr>();
        var keys = new Dictionary<string, long>();
        long next = 0;
        IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
        if (port != IntPtr.Zero) new System.Threading.Thread(() => PortLoop(port)) { IsBackground = true }.Start();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string[] w = line.Trim().Split(' ');
            string reply;
            try
            {
                IntPtr job;
                if (w.Length == 4 && w[0] == "create")
                {
                    string name = JobName(w[1]);
                    if (!jobs.TryGetValue(w[1], out job))
                    {
                        job = CreateJobObjectW(IntPtr.Zero, name);
                        if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed (" + Marshal.GetLastWin32Error() + ")");
                        jobs[w[1]] = job;
                        keys[w[1]] = Watch(port, job, w[1], ref next);
                    }
                    Apply(job, w[2] == "1", w[3] == "1");
                    reply = "{\"ok\":true}";
                }
                else if (w.Length == 4 && w[0] == "set")
                {
                    if (!jobs.TryGetValue(w[1], out job)) throw new Exception("no job " + w[1]);
                    SetJob(job, w[2] == "1", w[3] == "1");
                    reply = "{\"ok\":true}";
                }
                else if (w.Length == 2 && w[0] == "list")
                {
                    if (!jobs.TryGetValue(w[1], out job)) throw new Exception("no job " + w[1]);
                    reply = "{\"ok\":true,\"rows\":[" + ListJob(job, ",") + "]}";
                }
                else if (w.Length == 2 && w[0] == "query")
                {
                    if (!jobs.TryGetValue(w[1], out job)) throw new Exception("no job " + w[1]);
                    string q = QueryJob(job);
                    reply = "{\"ok\":true," + q.Substring(1);
                }
                else if (w.Length == 2 && w[0] == "close")
                {
                    if (jobs.TryGetValue(w[1], out job)) { CloseHandle(job); jobs.Remove(w[1]); long k; if (keys.TryGetValue(w[1], out k)) { lock (PortKeys) PortKeys.Remove(k); keys.Remove(w[1]); } }
                    reply = "{\"ok\":true}";
                }
                else throw new Exception("bad request");
            }
            catch (Exception e) { reply = "{\"ok\":false,\"error\":\"" + e.Message.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}"; }
            Write(reply);
        }
        return 0;
    }
}
