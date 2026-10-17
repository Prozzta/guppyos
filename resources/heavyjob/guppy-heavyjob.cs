// HEAVY-CPU-OPTIONS-191: the Windows helper that puts a heavy job (an install, build, full suite or
// bench an agent runs) into a named Job Object with the user's limits. Built from this source with the
// in-box .NET Framework compiler at build time (tools/build-heavyjob.cjs); never committed as a binary.
//
//   guppy-heavyjob join <jobName> <background 0|1> <half 0|1>
//       Guppy writes it as `guppy-heavyjob join <job> <b> <h>; <the command>`, one line that every
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
//   guppy-heavyjob set <jobName> <background 0|1> <half 0|1>
//       Live apply: replaces the job's limits. A limit turned off also resets the members (removing a
//       limit leaves a process where the limit put it): priority NORMAL, affinity the system mask.
//   guppy-heavyjob list <jobName>
//       One JSON line per process in the job: pid, name, priorityClass, cpus, mask, createdMs.
//   guppy-heavyjob serve
//       Guppy's own channel (stdin/stdout, one JSON line per request): create, set, list and close
//       <job>. It holds the handle of every job Guppy made, so a job keeps its name (a live change and
//       the join line find it) until Guppy lets it go. It also keeps each agent's own job, for calls
//       that cannot take a join line (see AgentSweep).
//
// background = PriorityClass BELOW_NORMAL (CPU priority only). half = affinity of floor(n/2) logical
// processors (at least 1), n = the active logical processors of the machine.
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
    [StructLayout(LayoutKind.Sequential)]
    struct EXT_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool SetPriorityClass(IntPtr h, uint cls);
    [DllImport("kernel32.dll")] static extern bool GetProcessAffinityMask(IntPtr h, out UIntPtr proc, out UIntPtr sys);
    [DllImport("kernel32.dll")] static extern bool SetProcessAffinityMask(IntPtr h, UIntPtr mask);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern uint GetActiveProcessorCount(ushort group);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern int GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);

    const uint LIMIT_AFFINITY = 0x10, LIMIT_PRIORITY_CLASS = 0x20, LIMIT_BREAKAWAY_OK = 0x800, LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
    const uint BELOW_NORMAL = 0x4000, NORMAL = 0x20;
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
            if (a.Length == 1 && a[0] == "serve") return Serve();
        }
        catch (Exception e) { Console.Error.WriteLine("[guppy] heavy-job limits not applied: " + e.Message); return a.Length > 0 && a[0] == "join" ? 0 : 3; }
        Console.Error.WriteLine("usage: guppy-heavyjob join|set <job> <background 0|1> <half 0|1> | list <job> | serve");
        return 2;
    }

    // Only Guppy's own job names: Local\guppy-heavy-<id>.
    static string JobName(string id)
    {
        foreach (char c in id) if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) throw new ArgumentException("bad job id");
        return "Local\\guppy-heavy-" + id;
    }

    static uint HalfCount() { uint n = GetActiveProcessorCount(0xFFFF); if (n > 64) n = 64; return Math.Max(1u, n / 2); }
    static ulong HalfMask() { uint k = HalfCount(); return k >= 64 ? ulong.MaxValue : (1UL << (int)k) - 1; }

    static EXT_LIMIT Limits(bool background, bool half)
    {
        var x = new EXT_LIMIT();
        if (background) { x.Basic.LimitFlags |= LIMIT_PRIORITY_CLASS; x.Basic.PriorityClass = BELOW_NORMAL; }
        if (half) { x.Basic.LimitFlags |= LIMIT_AFFINITY; x.Basic.Affinity = (UIntPtr)HalfMask(); }
        return x;
    }

    static void Apply(IntPtr job, bool background, bool half, bool agent = false)
    {
        var x = Limits(background, half);
        // An agent's job holds every process of the agent for good: with no limit on, a child leaves
        // it as it did before the agent joined it (an explicit CREATE_BREAKAWAY_FROM_JOB, and the
        // silent breakaway of the job the agent was in, e.g. libuv's, so a detached server still
        // outlives the agent). While a limit is on neither is allowed: an explicit breakaway is
        // refused (ACCESS_DENIED) and every child stays in the limits.
        if (agent && !background && !half) x.Basic.LimitFlags |= LIMIT_BREAKAWAY_OK | LIMIT_SILENT_BREAKAWAY_OK;
        if (!SetInformationJobObject(job, 9, ref x, Marshal.SizeOf(typeof(EXT_LIMIT))))
            throw new Exception("SetInformationJobObject failed (" + Marshal.GetLastWin32Error() + ")");
    }

    // cmd: what follows `<half>;` on this process's own command line, as cmd passed it.
    static string CmdRest()
    {
        var m = System.Text.RegularExpressions.Regex.Match(Environment.CommandLine, @"\bjoin\s+[A-Za-z0-9_-]+\s+[01]\s+[01];");
        return m.Success ? Environment.CommandLine.Substring(m.Index + m.Length).TrimStart() : ""; // a trailing space can be the command's own
    }

    static int Join(string name, bool background, bool half, string cmdRest)
    {
        // The command always runs: a failed join is one line on stderr, never a lost command.
        try { JoinChain(name, background, half, cmdRest != null); }
        catch (Exception e) { Console.Error.WriteLine("[guppy] heavy-job limits not applied: " + e.Message); }
        if (string.IsNullOrEmpty(cmdRest)) return 0;
        var psi = new System.Diagnostics.ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", "/d /s /c \"" + cmdRest + "\"") { UseShellExecute = false };
        using (var p = System.Diagnostics.Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
    }

    static int JoinChain(string name, bool background, bool half, bool self)
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
            Apply(job, background, half);
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

    static int Set(string name, bool background, bool half)
    {
        IntPtr job = OpenJobObjectW(JOB_ALL, false, name);
        if (job == IntPtr.Zero) { Console.Error.WriteLine("no job " + name); return 1; }
        try { SetJob(job, background, half); } finally { CloseHandle(job); }
        return 0;
    }

    // Lifting a job limit leaves its members as the limit set them (Windows does not restore them).
    // A member whose own values were recorded before the limit (an agent's job) gets them back; any
    // other is put back to normal.
    static void SetJob(IntPtr job, bool background, bool half, bool agent = false, Dictionary<int, Own> own = null)
    {
        Apply(job, background, half, agent);
        foreach (int pid in Members(job))
        {
            IntPtr h = OpenProcess(0x0200 | 0x0400, false, pid); // SET_INFORMATION | QUERY_INFORMATION
            if (h == IntPtr.Zero) continue;
            Own o;
            if (own == null || !own.TryGetValue(pid, out o) || o.Created != Created(pid)) o = null;
            if (!background) { if (o != null) SetPriorityClass(h, o.Prio); else if (GetPriorityClass(h) == BELOW_NORMAL) SetPriorityClass(h, NORMAL); }
            if (!half)
            {
                UIntPtr pm, sm;
                if (o != null) SetProcessAffinityMask(h, o.Mask);
                else if (GetProcessAffinityMask(h, out pm, out sm) && pm != sm) SetProcessAffinityMask(h, sm);
            }
            CloseHandle(h);
        }
    }

    // A process's own priority class and affinity, taken while no limit of ours is on it.
    class Own { public long Created; public UIntPtr Mask; public uint Prio; }

    static void Record(Dictionary<int, Own> own, int pid)
    {
        IntPtr h = OpenProcess(0x0400, false, pid); // QUERY_INFORMATION
        if (h == IntPtr.Zero) return;
        UIntPtr pm, sm; uint pc = GetPriorityClass(h);
        if (pc != 0 && GetProcessAffinityMask(h, out pm, out sm)) own[pid] = new Own { Created = Created(pid), Mask = pm, Prio = pc };
        CloseHandle(h);
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

    // CODEX-AGY-ASKFIRST-HEAVYCPU-192: an agent's own job, for a heavy call that cannot take a join
    // line (an agent that asks its user first, or a Codex shell Guppy cannot read). Guppy sweeps the
    // agent's whole process tree into it at the call's PreToolUse, before the hook answers: the call's
    // shell does not exist yet, so it and everything below it are created inside the job (no window
    // between a snapshot and an assign). Limits are on while one such call of the agent lives.
    // A process sits in at most one job hierarchy, and an agent's tree spans several (node puts the
    // children it spawns in libuv's own job, whose children break away from it silently): one job
    // nested under each, all with the same limits. Membership is for good, so with no limit on the
    // jobs allow an explicit breakaway as before (Apply).
    // An agent's limits: on, each member's own values are recorded first, to give back when they
    // come off.
    static void AgentSet(AgentJob a, bool background, bool half)
    {
        bool was = a.Background || a.Half;
        a.Background = background; a.Half = half;
        if (!was && (a.Background || a.Half)) { a.Own.Clear(); foreach (IntPtr j in a.Jobs) foreach (int pid in Members(j)) Record(a.Own, pid); }
        foreach (IntPtr j in a.Jobs) SetJob(j, a.Background, a.Half, true, a.Own);
        if (!a.Background && !a.Half) a.Own.Clear();
    }

    class AgentJob { public string Id; public List<IntPtr> Jobs = new List<IntPtr>(); public bool Background, Half; public Dictionary<int, Own> Own = new Dictionary<int, Own>();
        // pid -> { creation FILETIME, startMs of the first sweep that found it in the agent's tree }.
        public Dictionary<int, long[]> Seen = new Dictionary<int, long[]>(); }

    // An agent's jobs are named, so a serve started after one that died opens them again and can
    // still lift their limits ('#' is not allowed in an id, so no per-call job has these names).
    static string AgentJobName(string id, int n) { return JobName(id).Replace("guppy-heavy-", "guppy-heavyagent-") + "#" + n; }

    static IntPtr NewAgentJob(AgentJob a)
    {
        for (int n = a.Jobs.Count; n < 256; n++)
        {
            IntPtr j = CreateJobObjectW(IntPtr.Zero, AgentJobName(a.Id, n));
            if (j == IntPtr.Zero) return j;
            if (Marshal.GetLastWin32Error() != 183) return j; // ERROR_ALREADY_EXISTS: one of ours we had not opened
            Apply(j, a.Background, a.Half, true);
            a.Jobs.Add(j);
        }
        return IntPtr.Zero;
    }

    // A job's name lasts only while a handle to it is open (its processes do not keep it), so the
    // agent's root process holds one too: a serve started after this one died still finds the job
    // for as long as the agent lives.
    static void Keep(IntPtr job, int pid)
    {
        IntPtr p = OpenProcess(0x0040 /* DUP_HANDLE */, false, pid);
        if (p == IntPtr.Zero) return;
        IntPtr d;
        DuplicateHandle(GetCurrentProcess(), job, p, out d, 0, false, 2 /* SAME_ACCESS */);
        CloseHandle(p);
    }

    // The agent's state in this serve, or its jobs opened again by name; null when it has none.
    static AgentJob FindAgent(Dictionary<string, AgentJob> agents, string id)
    {
        AgentJob a;
        if (agents.TryGetValue(id, out a)) return a;
        a = new AgentJob { Id = id };
        for (int n = 0; n < 256; n++)
        {
            IntPtr j = OpenJobObjectW(JOB_ALL, false, AgentJobName(id, n));
            if (j == IntPtr.Zero) break;
            a.Jobs.Add(j);
        }
        if (a.Jobs.Count == 0) return null;
        agents[id] = a;
        return a;
    }

    static string AgentSweep(AgentJob a, int root, long startMs)
    {
        long rootCreated = Created(root);
        if (rootCreated == 0) throw new Exception("no process " + root);
        foreach (int pid in new List<int>(a.Seen.Keys)) if (Created(pid) != a.Seen[pid][0]) a.Seen.Remove(pid);
        int added = 0, missed = 0, members = 0;
        for (int pass = 0; pass < 5; pass++)
        {
            int newly = 0; missed = 0; members = 0;
            foreach (int pid in Tree(root, rootCreated))
            {
                IntPtr h = OpenProcess(PROC_SET_QUOTA_TERMINATE_QUERY, false, pid);
                if (h == IntPtr.Zero) { missed++; continue; }
                bool inside = false;
                foreach (IntPtr j in a.Jobs) { bool r; if (IsProcessInJob(h, j, out r) && r) { inside = true; break; } }
                if (!inside && (a.Background || a.Half)) Record(a.Own, pid); // its own values, before the limits reach it
                if (!inside) foreach (IntPtr j in a.Jobs) if (AssignProcessToJobObject(j, h)) { inside = true; newly++; break; }
                if (!inside)
                {
                    // In a hierarchy none of the agent's jobs is in: a new job, nested there.
                    IntPtr j = NewAgentJob(a);
                    if (j != IntPtr.Zero)
                    {
                        Apply(j, a.Background, a.Half, true);
                        if (AssignProcessToJobObject(j, h)) { a.Jobs.Add(j); Keep(j, root); inside = true; newly++; } else CloseHandle(j);
                    }
                }
                CloseHandle(h);
                if (inside)
                {
                    members++;
                    long cr = Created(pid); long[] s;
                    if (cr != 0 && (!a.Seen.TryGetValue(pid, out s) || s[0] != cr)) a.Seen[pid] = new long[] { cr, startMs };
                }
                else missed++;
            }
            added += newly;
            if (newly == 0) break;
        }
        return "{\"ok\":true,\"jobs\":" + a.Jobs.Count + ",\"members\":" + members + ",\"added\":" + added + ",\"missed\":" + missed + ",\"total\":" + Total(a) + "}";
    }

    // root and its descendants, parents first, each created at or after its parent (a recycled pid
    // is never taken for a child).
    static List<int> Tree(int root, long rootCreated)
    {
        var kids = new Dictionary<int, List<int>>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
        var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
        if (Process32FirstW(snap, ref e)) do
        {
            int pp = (int)e.th32ParentProcessID, pid = (int)e.th32ProcessID;
            if (pid == pp) continue;
            List<int> l; if (!kids.TryGetValue(pp, out l)) kids[pp] = l = new List<int>(); l.Add(pid);
        } while (Process32NextW(snap, ref e));
        CloseHandle(snap);
        var order = new List<int> { root }; var born = new Dictionary<int, long> { { root, rootCreated } };
        for (int i = 0; i < order.Count; i++)
        {
            List<int> l; if (!kids.TryGetValue(order[i], out l)) continue;
            foreach (int c in l)
            {
                long cc = Created(c);
                if (cc == 0 || cc < born[order[i]] || born.ContainsKey(c)) continue;
                born[c] = cc; order.Add(c);
            }
        }
        return order;
    }

    // The call's shell: the earliest process of the agent's jobs created at or after the call started
    // whose command line holds the command (quotes, backslashes and runs of white space aside), and
    // how many processes of its tree are alive. It is already inside: this only tells when it ends.
    static string CallState(AgentJob a, long startMs, string command)
    {
        string want = Norm(command);
        var members = new HashSet<int>();
        foreach (IntPtr j in a.Jobs) foreach (int pid in Members(j)) members.Add(pid);
        int shell = 0; long shellMs = long.MaxValue;
        foreach (int pid in members)
        {
            long ms = CreatedMs(pid);
            if (ms == 0 || ms < startMs - 250 || ms >= shellMs || want.Length == 0) continue;
            string cl = CommandLineOf(pid);
            if (cl != null && Norm(cl).Contains(want)) { shell = pid; shellMs = ms; }
        }
        int alive = 0, fresh = 0;
        if (shell != 0) alive = Tree(shell, Created(shell)).FindAll(members.Contains).Count;
        // Members created since the call began: what may be its tree when its shell is not seen. Not
        // one its own sweep (or an earlier one) found: that was there before the call's shell could
        // start (an agent started just before its first call, a helper its CLI had just started).
        foreach (int pid in members)
        {
            long ms = CreatedMs(pid); long[] s;
            if (ms == 0 || ms < startMs - 250) continue;
            if (a.Seen.TryGetValue(pid, out s) && s[1] <= startMs && s[0] == Created(pid)) continue;
            fresh++;
        }
        return "{\"ok\":true,\"shell\":" + shell + ",\"alive\":" + alive + ",\"fresh\":" + fresh + ",\"total\":" + Total(a) + "}";
    }

    // Processes ever created in the agent's jobs (JobObjectBasicAccountingInformation.TotalProcesses).
    static long Total(AgentJob a)
    {
        long n = 0; IntPtr buf = Marshal.AllocHGlobal(48);
        try { foreach (IntPtr j in a.Jobs) if (QueryInformationJobObject(j, 1, buf, 48, IntPtr.Zero)) n += (uint)Marshal.ReadInt32(buf, 36); }
        finally { Marshal.FreeHGlobal(buf); }
        return n;
    }

    static string Norm(string s)
    {
        var b = new StringBuilder(); bool space = false;
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') continue;
            if (char.IsWhiteSpace(c)) { space = b.Length > 0; continue; }
            if (space) { b.Append(' '); space = false; }
            b.Append(c);
        }
        return b.ToString();
    }

    static long CreatedMs(int pid) { long c = Created(pid); return c == 0 ? 0 : (c - 116444736000000000L) / 10000; }

    // ProcessCommandLineInformation (60): a UNICODE_STRING followed by its text.
    static string CommandLineOf(int pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return null;
        int len; NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out len);
        if (len <= 0) { CloseHandle(h); return null; }
        IntPtr buf = Marshal.AllocHGlobal(len);
        try
        {
            if (NtQueryInformationProcess(h, 60, buf, len, out len) != 0) return null;
            int n = (ushort)Marshal.ReadInt16(buf, 0);
            return Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, IntPtr.Size), n / 2);
        }
        finally { Marshal.FreeHGlobal(buf); CloseHandle(h); }
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
    //   agent <id> <rootPid> <b> <h> <startMs>  set the agent's job to these limits, then put the
    //                         agent's whole process tree in it (AgentSweep) for the call begun at startMs
    //   call <id> <startMs> <match>   the call's shell in that agent's job, and how much of its tree lives
    //   set / close <id>      also take an agent's id
    static int Serve()
    {
        var jobs = new Dictionary<string, IntPtr>();
        var agents = new Dictionary<string, AgentJob>();
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
                    }
                    Apply(job, w[2] == "1", w[3] == "1");
                    reply = "{\"ok\":true}";
                }
                else if (w.Length == 6 && w[0] == "agent")
                {
                    AgentJob a;
                    a = FindAgent(agents, w[1]);
                    if (a == null) { JobName(w[1]); a = new AgentJob { Id = w[1] }; agents[w[1]] = a; }
                    // The limits first: they take silent breakaway off, so nothing leaves the jobs
                    // between the sweep and the reply.
                    AgentSet(a, w[3] == "1", w[4] == "1");
                    reply = AgentSweep(a, int.Parse(w[2]), long.Parse(w[5]));
                }
                else if (w.Length == 4 && w[0] == "call")
                {
                    AgentJob a = FindAgent(agents, w[1]);
                    if (a == null) throw new Exception("no agent job " + w[1]);
                    reply = CallState(a, long.Parse(w[2]), Encoding.UTF8.GetString(Convert.FromBase64String(w[3])));
                }
                else if (w.Length == 4 && w[0] == "set" && !w[1].Contains("#") && FindAgent(agents, w[1]) != null)
                {
                    AgentSet(agents[w[1]], w[2] == "1", w[3] == "1");
                    reply = "{\"ok\":true}";
                }
                else if (w.Length == 2 && w[0] == "close" && !w[1].Contains("#") && FindAgent(agents, w[1]) != null)
                {
                    foreach (IntPtr j in agents[w[1]].Jobs) CloseHandle(j);
                    agents.Remove(w[1]);
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
                else if (w.Length == 2 && w[0] == "close")
                {
                    if (jobs.TryGetValue(w[1], out job)) { CloseHandle(job); jobs.Remove(w[1]); }
                    reply = "{\"ok\":true}";
                }
                else if (w.Length == 1 && w[0] == "cpus") reply = "{\"ok\":true,\"logical\":" + GetActiveProcessorCount(0xFFFF) + ",\"half\":" + HalfCount() + "}";
                else throw new Exception("bad request");
            }
            catch (Exception e) { reply = "{\"ok\":false,\"error\":\"" + e.Message.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ") + "\"}"; }
            Console.Out.WriteLine(reply);
            Console.Out.Flush();
        }
        return 0;
    }
}
