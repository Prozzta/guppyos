/*
 * FS-CONTAINMENT-TOCTOU: ask an OPEN file descriptor where it actually lives.
 *
 * The file IPC confines every path to the workspace (src/main/fs.ts safeResolve), but deciding on a
 * path and then opening it are two separate lookups, and a link swapped in between is what the open
 * really gets. The only answer that cannot be raced is a property of the handle itself, so after
 * every confined open fs.ts asks the handle for its final path and checks that against the
 * workspace root. Linux reads /proc/self/fd in JS and never loads this module.
 *
 *   win32:  GetFinalPathNameByHandleW on the fd's OS handle (uv_get_osfhandle: the fd belongs to
 *           the host's C runtime, not to ours, so _get_osfhandle here would look in the wrong table).
 *   darwin: fcntl(F_GETPATH).
 *
 * finalPath(fd: number) -> string. Any failure throws; the caller refuses the access.
 * Windows also exports the process holds of PTY-KILL-PID-IDENTITY (procOpen/procAlive/procClose, below).
 * Plain N-API (ABI-stable), so one build loads in Electron and in the Node that runs the tests.
 */
#define NAPI_VERSION 8
#include <node_api.h>
#include <stdint.h>

#ifdef _WIN32
/* uv.h first: it pulls in winsock2.h, which must precede windows.h. */
#include <uv.h>
#include <windows.h>
#elif defined(__APPLE__)
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <sys/param.h>
#endif

static napi_value fail(napi_env env, const char *msg) {
  napi_throw_error(env, NULL, msg);
  return NULL;
}

static napi_value final_path(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    return fail(env, "finalPath(fd): fd required");
  }
  int32_t fd;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    return fail(env, "finalPath(fd): fd must be a non-negative integer");
  }
  napi_value out;
#ifdef _WIN32
  HANDLE h = uv_get_osfhandle((uv_file)fd);
  if (h == INVALID_HANDLE_VALUE || h == NULL) return fail(env, "finalPath: fd has no OS handle");
  WCHAR stackbuf[MAX_PATH + 1];
  WCHAR *buf = stackbuf;
  DWORD cap = MAX_PATH + 1;
  DWORD n = GetFinalPathNameByHandleW(h, buf, cap, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (n >= cap) {
    cap = n + 1;
    buf = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, cap * sizeof(WCHAR));
    if (!buf) return fail(env, "finalPath: out of memory");
    n = GetFinalPathNameByHandleW(h, buf, cap, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  }
  napi_status st = napi_generic_failure;
  if (n > 0 && n < cap) st = napi_create_string_utf16(env, (const char16_t *)buf, n, &out);
  if (buf != stackbuf) HeapFree(GetProcessHeap(), 0, buf);
  if (n == 0 || n >= cap) return fail(env, "finalPath: GetFinalPathNameByHandleW failed");
  if (st != napi_ok) return fail(env, "finalPath: string conversion failed");
  return out;
#elif defined(__APPLE__)
  char buf[MAXPATHLEN];
  if (fcntl(fd, F_GETPATH, buf) == -1) return fail(env, "finalPath: fcntl(F_GETPATH) failed");
  if (napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out) != napi_ok) {
    return fail(env, "finalPath: string conversion failed");
  }
  return out;
#else
  (void)fd;
  (void)out;
  return fail(env, "finalPath: not built for this platform (Linux uses /proc/self/fd)");
#endif
}

#ifdef _WIN32
/*
 * PTY-KILL-PID-IDENTITY: hold a terminal's root process by HANDLE.
 *
 * Windows gives a dead process's pid to the next process created, within milliseconds, but never
 * while a handle to the dead process is still open. So src/main/procIdentity.ts opens the root
 * here in the same synchronous turn that spawned it and keeps the handle until every kill of that
 * terminal is over: for that whole time the pid names the root or nobody. The kills themselves
 * stay `taskkill /T /F /PID` (they need the tree walk); what this adds is that the pid they name
 * cannot belong to a stranger, and that "is the root alive" is asked of the handle, not of the pid.
 *
 *   procOpen(pid)   -> hold   throws unless pid is a live CHILD OF THIS PROCESS (see below)
 *   procAlive(hold) -> bool   false once the root has exited (the hold still reserves its pid)
 *   procClose(hold)           idempotent; garbage collection closes a hold nobody released
 *
 * The parent check: between CreateProcess and procOpen the root could already have died and its
 * pid gone to a stranger. A stranger that is not our own child is refused here. What is left is a
 * child Chromium itself launched under that pid in those microseconds.
 */
#include <stdlib.h>

typedef struct { HANDLE h; } proc_hold;

typedef struct {
  PVOID Reserved1;
  PVOID PebBaseAddress;
  PVOID Reserved2[2];
  ULONG_PTR UniqueProcessId;
  ULONG_PTR InheritedFromUniqueProcessId;
} guppy_process_basic_information;

typedef LONG (WINAPI *nt_query_information_process)(HANDLE, int, PVOID, ULONG, PULONG);

static void hold_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  proc_hold *p = (proc_hold *)data;
  if (p->h) CloseHandle(p->h);
  free(p);
}

static proc_hold *hold_arg(napi_env env, napi_callback_info info, const char *what) {
  size_t argc = 1;
  napi_value argv[1];
  void *data = NULL;
  napi_valuetype t;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_typeof(env, argv[0], &t) != napi_ok || t != napi_external ||
      napi_get_value_external(env, argv[0], &data) != napi_ok || !data) {
    napi_throw_error(env, NULL, what);
    return NULL;
  }
  return (proc_hold *)data;
}

static napi_value proc_open(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int64_t pid;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_get_value_int64(env, argv[0], &pid) != napi_ok || pid <= 0 || pid > 0xFFFFFFFFLL) {
    return fail(env, "procOpen(pid): pid must be a positive integer");
  }
  HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
  if (!h) return fail(env, "procOpen: no such process");
  const char *why = NULL;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  nt_query_information_process query =
      ntdll ? (nt_query_information_process)GetProcAddress(ntdll, "NtQueryInformationProcess") : NULL;
  guppy_process_basic_information pbi;
  ULONG got = 0;
  if (WaitForSingleObject(h, 0) != WAIT_TIMEOUT) why = "procOpen: the process has already exited";
  else if (!query) why = "procOpen: NtQueryInformationProcess is not available";
  else if (query(h, 0 /* ProcessBasicInformation */, &pbi, sizeof(pbi), &got) < 0) why = "procOpen: the parent could not be read";
  else if (pbi.InheritedFromUniqueProcessId != (ULONG_PTR)GetCurrentProcessId()) why = "procOpen: not a child of this process";
  proc_hold *p = why ? NULL : (proc_hold *)malloc(sizeof(proc_hold));
  if (!why && !p) why = "procOpen: out of memory";
  if (why) {
    CloseHandle(h);
    return fail(env, why);
  }
  p->h = h;
  napi_value out;
  if (napi_create_external(env, p, hold_finalize, NULL, &out) != napi_ok) {
    CloseHandle(h);
    free(p);
    return fail(env, "procOpen: the hold could not be created");
  }
  return out;
}

static napi_value proc_alive(napi_env env, napi_callback_info info) {
  proc_hold *p = hold_arg(env, info, "procAlive(hold): a hold from procOpen required");
  if (!p) return NULL;
  if (!p->h) return fail(env, "procAlive: the hold was closed");
  DWORD w = WaitForSingleObject(p->h, 0);
  if (w != WAIT_TIMEOUT && w != WAIT_OBJECT_0) return fail(env, "procAlive: WaitForSingleObject failed");
  napi_value out;
  if (napi_get_boolean(env, w == WAIT_TIMEOUT, &out) != napi_ok) return NULL;
  return out;
}

static napi_value proc_close(napi_env env, napi_callback_info info) {
  proc_hold *p = hold_arg(env, info, "procClose(hold): a hold from procOpen required");
  if (!p) return NULL;
  if (p->h) {
    CloseHandle(p->h);
    p->h = NULL;
  }
  return NULL;
}

static int export_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn) == napi_ok &&
         napi_set_named_property(env, exports, name, fn) == napi_ok;
}
#endif

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "finalPath", NAPI_AUTO_LENGTH, final_path, NULL, &fn) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "finalPath", fn) != napi_ok) return NULL;
#ifdef _WIN32
  if (!export_fn(env, exports, "procOpen", proc_open) || !export_fn(env, exports, "procAlive", proc_alive) ||
      !export_fn(env, exports, "procClose", proc_close)) {
    return NULL;
  }
#endif
  return exports;
}
