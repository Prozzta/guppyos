// LOAD-FLAKES-178: each test file runs in a job of its own, so the watchdog's kill takes the
// file's whole tree in one step, whenever each process was born (a snapshot-then-kill missed a
// child born between the two: an orphan ping held the file's temp folder, EBUSY).
//
//   file-job join <pid>               The file's preload, before any test code runs: a new job
//                                     (kill-on-close, no breakaway of any kind), its handle given
//                                     to the file process, then the file put in it. Everything
//                                     the file starts is created inside; when the file is gone
//                                     the handle closes and the rest goes with it.
//   file-job kill <pid> <createdMs>   The watchdog: the job of that file, only while <pid> is
//                                     still the process born at <createdMs> and in it; then
//                                     TerminateJobObject, and wait until it holds no process.
// Exit codes: 0 done, 3 no job for the pid, 4 the pid is another process now, 1 an error.
using System;
using System.Runtime.InteropServices;

static class FileJob
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
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_ACCOUNTING { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT_LIMIT info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out BASIC_ACCOUNTING info, int len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);

    const uint JOB_ALL = 0x1F001F;
    const uint KILL_ON_JOB_CLOSE = 0x2000;
    // No BREAKAWAY_OK and no SILENT_BREAKAWAY_OK: a job nested inside (libuv's, which allows silent
    // breakaway) cannot take a process out past this one.
    const uint FLAGS = KILL_ON_JOB_CLOSE;

    static string Name(int pid) { return "Local\\guppy-testfile-" + pid; }

    static int Main(string[] a)
    {
        try
        {
            if (a.Length == 2 && a[0] == "join") return Join(int.Parse(a[1]));
            if (a.Length == 3 && a[0] == "kill") return Kill(int.Parse(a[1]), long.Parse(a[2]));
        }
        catch (Exception e) { Console.Error.WriteLine("[file-job] " + e.Message); return 1; }
        Console.Error.WriteLine("usage: file-job join <pid> | kill <pid> <createdMs>");
        return 2;
    }

    static int Join(int pid)
    {
        // SET_QUOTA | TERMINATE | DUP_HANDLE | QUERY_LIMITED_INFORMATION
        IntPtr p = OpenProcess(0x0100 | 0x0001 | 0x0040 | 0x1000, false, pid);
        if (p == IntPtr.Zero) throw new Exception("OpenProcess failed (" + Marshal.GetLastWin32Error() + ")");
        IntPtr job = CreateJobObjectW(IntPtr.Zero, Name(pid));
        if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed (" + Marshal.GetLastWin32Error() + ")");
        if (Marshal.GetLastWin32Error() == 183) throw new Exception("a job for " + pid + " is there already");
        var x = new EXT_LIMIT();
        x.Basic.LimitFlags = FLAGS;
        if (!SetInformationJobObject(job, 9, ref x, Marshal.SizeOf(typeof(EXT_LIMIT)))) throw new Exception("SetInformationJobObject failed (" + Marshal.GetLastWin32Error() + ")");
        // The file holds the job first: if this tool's handle were the last one when it exits, the
        // kill-on-close would take the file with it.
        IntPtr dst;
        if (!DuplicateHandle(GetCurrentProcess(), job, p, out dst, 0, false, 2 /* SAME_ACCESS */)) throw new Exception("DuplicateHandle failed (" + Marshal.GetLastWin32Error() + ")");
        if (!AssignProcessToJobObject(job, p)) throw new Exception("AssignProcessToJobObject failed (" + Marshal.GetLastWin32Error() + ")");
        return 0;
    }

    static int Kill(int pid, long createdMs)
    {
        IntPtr job = OpenJobObjectW(JOB_ALL, false, Name(pid));
        if (job == IntPtr.Zero) return 3;
        IntPtr p = OpenProcess(0x1000, false, pid);
        if (p == IntPtr.Zero) return 4;
        long c, e, k, u; bool inJob;
        if (!GetProcessTimes(p, out c, out e, out k, out u)) return 4;
        long ms = (c - 116444736000000000L) / 10000;
        if (Math.Abs(ms - createdMs) > 1 || !IsProcessInJob(p, job, out inJob) || !inJob) return 4;
        CloseHandle(p);
        if (!TerminateJobObject(job, 1)) throw new Exception("TerminateJobObject failed (" + Marshal.GetLastWin32Error() + ")");
        for (int i = 0; i < 200; i++)
        {
            BASIC_ACCOUNTING acc;
            if (!QueryInformationJobObject(job, 1, out acc, Marshal.SizeOf(typeof(BASIC_ACCOUNTING)), IntPtr.Zero) || acc.ActiveProcesses == 0) break;
            System.Threading.Thread.Sleep(25);
        }
        return 0;
    }
}
