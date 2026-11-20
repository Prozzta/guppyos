/*
 * FS-CONTAINMENT-TOCTOU: ask an OPEN file descriptor where it actually lives.
 *
 * The file IPC confines every path to the workspace (src/main/fs.ts safeResolve), but deciding on a
 * path and then opening it are two separate lookups, and a link swapped in between is what the open
 * really gets. The only answer that cannot be raced is a property of the handle itself, so after
 * every confined open fs.ts asks the handle for its final path and checks that against the
 * workspace root. Linux reads /proc/self/fd in JS and does not call finalPath.
 *
 *   win32:  GetFinalPathNameByHandleW on the fd's OS handle (uv_get_osfhandle: the fd belongs to
 *           the host's C runtime, not to ours, so _get_osfhandle here would look in the wrong table).
 *   darwin: fcntl(F_GETPATH).
 *
 * finalPath(fd: number) -> string. Any failure throws; the caller refuses the access.
 * Windows also exports the process holds of PTY-KILL-PID-IDENTITY (procOpen/procAlive/procClose) and
 * PTY-HOLD-NODEPTY-HANDOFF (procAdopt), below, and the renames of REGISTRY-RENAME-EPERM-107
 * (posixRename) and ASYNC-RENAME-POSIX-107 (posixRenameAsync).
 * Every platform exports removeTree / removeTreeAsync / removeTreeApi (FS-REMOVE-READDIR-GAP-108,
 * below): the link-safe tree delete, on Windows, Linux and macOS.
 * Plain N-API (ABI-stable), so one build loads in Electron and in the Node that runs the tests.
 */
#define NAPI_VERSION 8
#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE /* openat, fdopendir, O_NOFOLLOW, O_CLOEXEC (removeTree) */
#endif
#include <node_api.h>
#include <stdint.h>

#ifdef _WIN32
/* uv.h first: it pulls in winsock2.h, which must precede windows.h. */
#include <uv.h>
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
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
 *
 * PTY-HOLD-NODEPTY-HANDOFF closes that too:
 *   procAdopt(rootHandle, pid) -> hold
 * rootHandle is what the patched node-pty returns from its connect (tools/patch-node-pty-root-handle.cjs):
 * a duplicate of the handle CreateProcess itself returned, made before anything could close it. So
 * there is no moment at which the pid was free, and nothing to check a parent for: the handle IS the
 * root, alive or dead. procAdopt duplicates it once more for the hold and leaves node-pty's copy to
 * node-pty (its external closes it). It throws unless the value carries node-pty's handoff type tag
 * and the handle's process id is pid; an exited root is adopted (its pid stays reserved).
 *
 * Both kinds of external are type-tagged, so a hold cannot be mistaken for a handoff or the reverse:
 * one is a pointer to a proc_hold, the other a raw HANDLE.
 */
#include <stdlib.h>

typedef struct { HANDLE h; } proc_hold;

/* The same two numbers as guppyRootHandoffTag in the patched node-pty conpty.cc. */
static const napi_type_tag ROOT_HANDOFF_TAG = { 0x4755505059524f4fULL, 0x5448414e444f4646ULL };
static const napi_type_tag PROC_HOLD_TAG = { 0x47555050595f4653ULL, 0x50524f435f484f4cULL };

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
  bool ours = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_typeof(env, argv[0], &t) != napi_ok || t != napi_external ||
      napi_check_object_type_tag(env, argv[0], &PROC_HOLD_TAG, &ours) != napi_ok || !ours ||
      napi_get_value_external(env, argv[0], &data) != napi_ok || !data) {
    napi_throw_error(env, NULL, what);
    return NULL;
  }
  return (proc_hold *)data;
}

/* Wrap an open handle as a hold. Takes the handle: on failure it is closed and an error is pending. */
static napi_value hold_new(napi_env env, HANDLE h, const char *what) {
  proc_hold *p = (proc_hold *)malloc(sizeof(proc_hold));
  if (!p) {
    CloseHandle(h);
    return fail(env, what);
  }
  p->h = h;
  napi_value out;
  if (napi_create_external(env, p, hold_finalize, NULL, &out) != napi_ok) {
    CloseHandle(h);
    free(p);
    return fail(env, what);
  }
  /* From here the external owns the handle: its finalizer closes it. */
  if (napi_type_tag_object(env, out, &PROC_HOLD_TAG) != napi_ok) return fail(env, what);
  return out;
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
  if (why) {
    CloseHandle(h);
    return fail(env, why);
  }
  return hold_new(env, h, "procOpen: the hold could not be created");
}

static napi_value proc_adopt(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_valuetype t;
  bool handoff = false;
  void *data = NULL;
  int64_t pid;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2 ||
      napi_typeof(env, argv[0], &t) != napi_ok || t != napi_external ||
      napi_check_object_type_tag(env, argv[0], &ROOT_HANDOFF_TAG, &handoff) != napi_ok || !handoff ||
      napi_get_value_external(env, argv[0], &data) != napi_ok || !data) {
    return fail(env, "procAdopt(rootHandle, pid): rootHandle must be the handle node-pty handed over");
  }
  if (napi_get_value_int64(env, argv[1], &pid) != napi_ok || pid <= 0 || pid > 0xFFFFFFFFLL) {
    return fail(env, "procAdopt(rootHandle, pid): pid must be a positive integer");
  }
  /* The handoff's own handle answers for which process it is; the pid is only compared. */
  if (GetProcessId((HANDLE)data) != (DWORD)pid) return fail(env, "procAdopt: the handle is not the process with that pid");
  HANDLE h = NULL;
  if (!DuplicateHandle(GetCurrentProcess(), (HANDLE)data, GetCurrentProcess(), &h,
                       SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, 0) || !h) {
    return fail(env, "procAdopt: the handle could not be duplicated");
  }
  return hold_new(env, h, "procAdopt: the hold could not be created");
}

static napi_value proc_alive(napi_env env, napi_callback_info info) {
  proc_hold *p = hold_arg(env, info, "procAlive(hold): a hold from procOpen or procAdopt required");
  if (!p) return NULL;
  if (!p->h) return fail(env, "procAlive: the hold was closed");
  DWORD w = WaitForSingleObject(p->h, 0);
  if (w != WAIT_TIMEOUT && w != WAIT_OBJECT_0) return fail(env, "procAlive: WaitForSingleObject failed");
  napi_value out;
  if (napi_get_boolean(env, w == WAIT_TIMEOUT, &out) != napi_ok) return NULL;
  return out;
}

static napi_value proc_close(napi_env env, napi_callback_info info) {
  proc_hold *p = hold_arg(env, info, "procClose(hold): a hold from procOpen or procAdopt required");
  if (!p) return NULL;
  if (p->h) {
    CloseHandle(p->h);
    p->h = NULL;
  }
  return NULL;
}

/*
 * REGISTRY-RENAME-EPERM-107: posixRename(src, dst) replaces dst even while another handle has it
 * open. A plain MoveFileEx over a file that a reader holds fails with ERROR_ACCESS_DENIED (EPERM):
 * Node's async fs.readFile keeps registry.json open across several main-thread turns, so a sync
 * writer on that thread could never publish. FileRenameInfoEx with POSIX_SEMANTICS (Windows 10
 * 1607+) unlinks the old file's name at once and the reader keeps reading the old, whole bytes;
 * libuv opens with FILE_SHARE_DELETE, so the open reader does not block it. Any failure throws an
 * Error whose `errno` is the Win32 error code, and the caller falls back to its old rename.
 */
typedef struct {
  DWORD Flags;
  HANDLE RootDirectory;
  DWORD FileNameLength;
  WCHAR FileName[1];
} guppy_rename_info_ex;
#define GUPPY_FILE_RENAME_INFO_EX 22 /* FileRenameInfoEx */
#define GUPPY_RENAME_REPLACE_IF_EXISTS 0x1
#define GUPPY_RENAME_POSIX_SEMANTICS 0x2

static WCHAR *utf16_arg(napi_env env, napi_value v) {
  size_t n = 0;
  if (napi_get_value_string_utf16(env, v, NULL, 0, &n) != napi_ok || n == 0) return NULL;
  WCHAR *s = (WCHAR *)calloc(n + 1, sizeof(WCHAR));
  if (!s) return NULL;
  if (napi_get_value_string_utf16(env, v, (char16_t *)s, n + 1, &n) != napi_ok) { free(s); return NULL; }
  return s;
}

static napi_value throw_win32(napi_env env, const char *msg, DWORD code) {
  napi_value text, err, num;
  if (napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &text) == napi_ok &&
      napi_create_error(env, NULL, text, &err) == napi_ok &&
      napi_create_uint32(env, code, &num) == napi_ok &&
      napi_set_named_property(env, err, "errno", num) == napi_ok) {
    napi_throw(env, err);
  } else {
    napi_throw_error(env, NULL, msg);
  }
  return NULL;
}

/* The two paths of a rename call, as the source path and a filled FileRenameInfoEx block (both to be
 * freed by the caller). Returns NULL, or the message of the error to throw. */
static const char *rename_args(napi_env env, napi_callback_info info, WCHAR **src_out, guppy_rename_info_ex **ri_out, size_t *size_out) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    return "posixRename(src, dst): both paths required";
  }
  WCHAR *src = utf16_arg(env, argv[0]);
  WCHAR *dst = utf16_arg(env, argv[1]);
  if (!src || !dst) { free(src); free(dst); return "posixRename(src, dst): paths must be non-empty strings"; }
  size_t dlen = wcslen(dst);
  size_t size = sizeof(guppy_rename_info_ex) + dlen * sizeof(WCHAR);
  guppy_rename_info_ex *ri = (guppy_rename_info_ex *)calloc(1, size);
  if (!ri) { free(src); free(dst); return "posixRename: out of memory"; }
  ri->Flags = GUPPY_RENAME_REPLACE_IF_EXISTS | GUPPY_RENAME_POSIX_SEMANTICS;
  ri->RootDirectory = NULL;
  ri->FileNameLength = (DWORD)(dlen * sizeof(WCHAR));
  memcpy(ri->FileName, dst, dlen * sizeof(WCHAR));
  free(dst);
  *src_out = src;
  *ri_out = ri;
  *size_out = size;
  return NULL;
}

/* The rename itself. No N-API call, so it may run on any thread. On failure `code` is the Win32
 * error and `opened` says whether the source was opened at all. */
static BOOL rename_by_handle(const WCHAR *src, guppy_rename_info_ex *ri, size_t size, DWORD *code, int *opened) {
  HANDLE h = CreateFileW(src, DELETE | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  *code = 0;
  *opened = h != INVALID_HANDLE_VALUE;
  if (h == INVALID_HANDLE_VALUE) {
    *code = GetLastError();
    return FALSE;
  }
  BOOL ok = SetFileInformationByHandle(h, (FILE_INFO_BY_HANDLE_CLASS)GUPPY_FILE_RENAME_INFO_EX, ri, (DWORD)size);
  if (!ok) *code = GetLastError();
  CloseHandle(h);
  return ok;
}

static const char *rename_msg(int opened) {
  return opened ? "posixRename: SetFileInformationByHandle(FileRenameInfoEx) failed" : "posixRename: the source could not be opened";
}

static napi_value posix_rename(napi_env env, napi_callback_info info) {
  WCHAR *src = NULL;
  guppy_rename_info_ex *ri = NULL;
  size_t size = 0;
  const char *bad = rename_args(env, info, &src, &ri, &size);
  if (bad) return fail(env, bad);
  DWORD code = 0;
  int opened = 0;
  BOOL ok = rename_by_handle(src, ri, size, &code, &opened);
  free(ri); free(src);
  if (!ok) return throw_win32(env, rename_msg(opened), code);
  return NULL;
}

/*
 * ASYNC-RENAME-POSIX-107: posixRenameAsync(src, dst) -> Promise<void>. The same rename, run on a
 * libuv pool thread (N-API async work), for the async writers: the main thread only queues the work
 * and settles the promise, it never waits for the file system. Bad arguments throw at the call; a
 * failed rename rejects with the same Error (`errno` = the Win32 code) the sync call throws.
 */
typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  WCHAR *src;
  guppy_rename_info_ex *ri;
  size_t size;
  DWORD code;
  int opened;
  BOOL ok;
} rename_job;

static void rename_job_free(napi_env env, rename_job *job) {
  if (job->work) napi_delete_async_work(env, job->work);
  free(job->ri); free(job->src); free(job);
}

/* On a pool thread: no N-API here. */
static void rename_execute(napi_env env, void *data) {
  (void)env;
  rename_job *job = (rename_job *)data;
  job->ok = rename_by_handle(job->src, job->ri, job->size, &job->code, &job->opened);
}

/* A value that needs no allocation, for settling when the proper one cannot be made. */
static int plain_value(napi_env env, napi_value *v) {
  return napi_get_undefined(env, v) == napi_ok || napi_get_null(env, v) == napi_ok ||
         napi_get_boolean(env, false, v) == napi_ok;
}

/* Back on the main thread: settle the promise. It is always settled: an awaiting write must end.
   If the Error cannot be created (out of memory), the rejection carries a plain value instead. */
static void rename_complete(napi_env env, napi_status status, void *data) {
  rename_job *job = (rename_job *)data;
  napi_value v;
  if (status == napi_ok && job->ok) {
    if (plain_value(env, &v)) napi_resolve_deferred(env, job->deferred, v);
  } else {
    const char *msg = status == napi_ok ? rename_msg(job->opened) : "posixRenameAsync: the rename was cancelled";
    DWORD code = status == napi_ok ? job->code : ERROR_OPERATION_ABORTED;
    napi_value text, num;
    if (napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &text) == napi_ok &&
        napi_create_error(env, NULL, text, &v) == napi_ok) {
      if (napi_create_uint32(env, code, &num) == napi_ok) napi_set_named_property(env, v, "errno", num);
      napi_reject_deferred(env, job->deferred, v);
    } else if (plain_value(env, &v)) {
      napi_reject_deferred(env, job->deferred, v);
    }
  }
  rename_job_free(env, job);
}

static napi_value posix_rename_async(napi_env env, napi_callback_info info) {
  WCHAR *src = NULL;
  guppy_rename_info_ex *ri = NULL;
  size_t size = 0;
  const char *bad = rename_args(env, info, &src, &ri, &size);
  if (bad) return fail(env, bad);
  rename_job *job = (rename_job *)calloc(1, sizeof(rename_job));
  if (!job) { free(ri); free(src); return fail(env, "posixRename: out of memory"); }
  job->src = src;
  job->ri = ri;
  job->size = size;
  napi_value name, promise;
  if (napi_create_string_utf8(env, "guppy.posixRenameAsync", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, NULL, name, rename_execute, rename_complete, job, &job->work) != napi_ok) {
    rename_job_free(env, job);
    return fail(env, "posixRenameAsync: the work could not be created");
  }
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) {
    rename_job_free(env, job);
    return fail(env, "posixRenameAsync: the promise could not be created");
  }
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    rename_job_free(env, job);
    return fail(env, "posixRenameAsync: the work could not be queued");
  }
  return promise;
}
#endif

/*
 * FS-REMOVE-READDIR-GAP-108: removeTree(path, keepRoot) deletes a folder tree without ever
 * resolving a name twice.
 *
 * A walk made of lstat, readdir, unlink and rmdir calls on PATHS resolves the path again on every
 * call. A process that can write the tree can put a link where a folder was between two of those
 * calls (on Windows a junction is even a plain empty folder for a moment while it is being made),
 * and the next call then lists or deletes the link's TARGET. No re-check in JS closes that: there
 * is always one more lookup after the check.
 *
 * Here every folder is opened ONCE, without following a link, and everything after that is asked
 * of the open HANDLE (Windows) or file descriptor (Linux, macOS), never of a path:
 *   - what it holds: the listing is read from the handle;
 *   - its children: opened or removed by their bare name INSIDE the folder the handle is, wherever
 *     that folder's path now points (NtCreateFile with RootDirectory; openat / unlinkat);
 *   - Windows: a child's type is read from its own handle and it is deleted through that handle.
 *   - POSIX: a child that is not a folder is removed with unlinkat, which never follows; a folder
 *     is opened with O_NOFOLLOW | O_DIRECTORY, which fails on a link, emptied through that
 *     descriptor and removed with unlinkat(AT_REMOVEDIR), which fails on a link and on a folder
 *     that is not empty.
 * So a link that appears at any moment is either removed as a link, or it was put on a name whose
 * folder we already hold, and the handle still is the old folder. On Windows a folder that is
 * turned into a junction in place while we hold it must be empty for that, lists as empty from our
 * handle and is removed through the handle: the junction goes, its target is not touched.
 *
 * Not covered, on purpose: the folders ABOVE the root. The root's own path is resolved by the
 * system as usual, so a caller must hand in a root whose parents it trusts. On POSIX the emptied
 * root is removed by rmdir(path), BY PATH and not through the handle we emptied it with (POSIX has
 * no call that removes a folder by its handle). rmdir removes a link's target never (it does not
 * follow) and a folder only when it is empty, so if the root's name was pointed somewhere else in
 * between, what goes is at most an empty folder or nothing.
 *
 * removeTree(path, keepRoot?) -> links             synchronous; links = how many links it removed
 * removeTreeAsync(path, keepRoot?) -> Promise      same walk on a worker thread
 * removeTreeApi                                    GUPPY_REMOVE_TREE_API; callers refuse any other value
 * keepRoot empties the folder and leaves it.
 * The root must be a real folder: a link or a file is refused (message starts with "refused:",
 * code EREFUSED). Other errors carry `errno` (the Win32 code or errno), `code` (ENOENT, EPERM,
 * EACCES, EBUSY, ENOTEMPTY or EIO), `links` (removed before the error) and the failing entry's
 * name in the message. The walk stops at the first error.
 */
#define GUPPY_REMOVE_TREE_API 1
#define RT_MAX_DEPTH 2048   /* nested folders; deeper than any real tree, and bounds the C stack */
#define RT_MAX_PASSES 64    /* listings of one folder before "it keeps refilling" */
#define RT_RMDIR_TRIES 5    /* remove, and on "not empty" pause and re-walk; the same in every caller */
#define RT_REFUSED_LINK 0xE0000001u
#define RT_REFUSED_NOT_DIR 0xE0000002u

#ifdef _WIN32
#define RT_BUF_BYTES 65536
#define RT_OPEN_REPARSE_POINT 0x00200000u
#define RT_OPEN_FOR_BACKUP_INTENT 0x00004000u
#define RT_SYNCHRONOUS_IO_NONALERT 0x00000020u
#define RT_FILE_OPEN 1u
#define RT_OBJ_CASE_INSENSITIVE 0x40u
#define RT_DISPOSITION_INFO_EX 21 /* FileDispositionInfoEx */
#define RT_DISPOSITION_DELETE 0x1u
#define RT_DISPOSITION_POSIX_SEMANTICS 0x2u
#define RT_DISPOSITION_IGNORE_READONLY 0x10u
/* A symlink or a junction: a reparse point that stands for another name. */
#define RT_IS_LINK(attrs, tag) (((attrs) & FILE_ATTRIBUTE_REPARSE_POINT) && ((tag) & 0x20000000u))

typedef WCHAR rt_char;
typedef struct { USHORT Length; USHORT MaximumLength; PWSTR Buffer; } rt_unicode_string;
typedef struct {
  ULONG Length;
  HANDLE RootDirectory;
  rt_unicode_string *ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor;
  PVOID SecurityQualityOfService;
} rt_object_attributes;
typedef struct { union { LONG Status; PVOID Pointer; } u; ULONG_PTR Information; } rt_io_status_block;
typedef LONG (NTAPI *rt_nt_create_file)(PHANDLE, ACCESS_MASK, rt_object_attributes *, rt_io_status_block *,
                                        PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef ULONG (NTAPI *rt_nt_status_to_dos)(LONG);

typedef struct {
  rt_nt_create_file create;
  rt_nt_status_to_dos to_dos;
  uint32_t code;     /* 0 = no error yet */
  const char *step;  /* what failed */
  char name[800];    /* the entry it failed on, UTF-8 ("" = the root) */
  uint32_t links;    /* links removed so far */
} rt_ctx;

static int rt_fail(rt_ctx *c, DWORD code, const char *step, const WCHAR *name, size_t chars) {
  if (c->code) return 0; /* the first error is the one reported */
  c->code = code ? code : ERROR_GEN_FAILURE;
  c->step = step;
  c->name[0] = 0;
  if (name && chars) {
    int n = WideCharToMultiByte(CP_UTF8, 0, name, (int)(chars > 255 ? 255 : chars), c->name, (int)sizeof(c->name) - 1, NULL, NULL);
    c->name[n > 0 ? n : 0] = 0;
  }
  return 0;
}

/* What the HANDLE is. Never asks a path. */
static int rt_kind(HANDLE h, DWORD *attrs, DWORD *tag) {
  FILE_ATTRIBUTE_TAG_INFO ti;
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &ti, sizeof(ti))) return 0;
  *attrs = ti.FileAttributes;
  *tag = ti.ReparseTag;
  return 1;
}

/* Remove the object the handle is. Returns 0 on success, else the Win32 code. */
static DWORD rt_delete(HANDLE h, DWORD attrs) {
  DWORD flags = RT_DISPOSITION_DELETE | RT_DISPOSITION_POSIX_SEMANTICS | RT_DISPOSITION_IGNORE_READONLY;
  if (SetFileInformationByHandle(h, (FILE_INFO_BY_HANDLE_CLASS)RT_DISPOSITION_INFO_EX, &flags, sizeof(flags))) return 0;
  DWORD e = GetLastError();
  /* Only a file system that does not know the Ex class gets the old one (FAT, some network drives). */
  if (e != ERROR_INVALID_PARAMETER && e != ERROR_INVALID_FUNCTION && e != ERROR_NOT_SUPPORTED) return e;
  if (attrs & FILE_ATTRIBUTE_READONLY) {
    FILE_BASIC_INFO bi;
    memset(&bi, 0, sizeof(bi)); /* zero times: leave them */
    bi.FileAttributes = attrs & ~(DWORD)FILE_ATTRIBUTE_READONLY;
    if (!bi.FileAttributes) bi.FileAttributes = FILE_ATTRIBUTE_NORMAL;
    if (!SetFileInformationByHandle(h, FileBasicInfo, &bi, sizeof(bi))) return GetLastError();
  }
  FILE_DISPOSITION_INFO di;
  di.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(h, FileDispositionInfo, &di, sizeof(di))) return GetLastError();
  return 0;
}

/* Open `name` INSIDE the folder `parent` is, without following a link. *code is 0 on success. */
static HANDLE rt_open_child(rt_ctx *c, HANDLE parent, const WCHAR *name, USHORT bytes, int list, DWORD *code) {
  rt_unicode_string us;
  rt_object_attributes oa;
  rt_io_status_block io;
  HANDLE h = NULL;
  us.Length = bytes;
  us.MaximumLength = bytes;
  us.Buffer = (PWSTR)name;
  memset(&oa, 0, sizeof(oa));
  oa.Length = sizeof(oa);
  oa.RootDirectory = parent;
  oa.ObjectName = &us;
  oa.Attributes = RT_OBJ_CASE_INSENSITIVE;
  ACCESS_MASK want = DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | (list ? FILE_LIST_DIRECTORY : 0);
  LONG st = 0;
  for (int i = 0; i < 2; i++) {
    memset(&io, 0, sizeof(io));
    st = c->create(&h, want, &oa, &io, NULL, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, RT_FILE_OPEN,
                   RT_OPEN_REPARSE_POINT | RT_OPEN_FOR_BACKUP_INTENT | RT_SYNCHRONOUS_IO_NONALERT, NULL, 0);
    if (st >= 0) { *code = 0; return h; }
    /* Write-attributes is only needed by the old delete class on a read-only file: try once without. */
    if (i == 0 && c->to_dos(st) == ERROR_ACCESS_DENIED) { want &= ~(ACCESS_MASK)FILE_WRITE_ATTRIBUTES; continue; }
    break;
  }
  *code = c->to_dos(st);
  if (!*code) *code = ERROR_GEN_FAILURE;
  return INVALID_HANDLE_VALUE;
}

static int rt_empty(rt_ctx *c, HANDLE dir, int depth);

/* Delete the folder `h` is, after emptying it. On "not empty" (a creator raced us): pause, re-walk, retry. */
static int rt_remove_dir(rt_ctx *c, HANDLE h, DWORD attrs, int depth, const WCHAR *name, size_t chars) {
  for (int i = 0; i < RT_RMDIR_TRIES; i++) {
    if (i) Sleep(10 * (DWORD)i);
    if (!rt_empty(c, h, depth)) return 0;
    DWORD e = rt_delete(h, attrs);
    if (!e) return 1;
    if (e != ERROR_DIR_NOT_EMPTY) return rt_fail(c, e, "delete folder", name, chars);
  }
  return rt_fail(c, ERROR_DIR_NOT_EMPTY, "delete folder (it kept refilling)", name, chars);
}

/* One listed entry of the folder `parent` is. */
static int rt_entry(rt_ctx *c, HANDLE parent, const WCHAR *name, USHORT bytes, DWORD listed_attrs, int depth) {
  size_t chars = bytes / sizeof(WCHAR);
  /* The listing is only a hint for which access to ask for. The handle decides. */
  int list = (listed_attrs & FILE_ATTRIBUTE_DIRECTORY) && !(listed_attrs & FILE_ATTRIBUTE_REPARSE_POINT);
  for (int attempt = 0; attempt < 3; attempt++) {
    DWORD code = 0, attrs = 0, tag = 0;
    HANDLE h = rt_open_child(c, parent, name, bytes, list, &code);
    if (h == INVALID_HANDLE_VALUE) {
      if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return 1; /* someone else removed it */
      return rt_fail(c, code, "open entry", name, chars);
    }
    if (!rt_kind(h, &attrs, &tag)) {
      DWORD e = GetLastError();
      CloseHandle(h);
      return rt_fail(c, e, "read entry type", name, chars);
    }
    int folder = (attrs & FILE_ATTRIBUTE_DIRECTORY) && !RT_IS_LINK(attrs, tag);
    if (folder && !list) { /* a real folder where the listing showed something else: reopen able to list it */
      CloseHandle(h);
      list = 1;
      continue;
    }
    int ok;
    if (folder) {
      ok = rt_remove_dir(c, h, attrs, depth + 1, name, chars);
    } else { /* a file or a link: removed as itself, never looked into */
      DWORD e = rt_delete(h, attrs);
      ok = e ? rt_fail(c, e, "delete entry", name, chars) : 1;
      if (ok && RT_IS_LINK(attrs, tag)) c->links++;
    }
    CloseHandle(h);
    return ok;
  }
  return rt_fail(c, ERROR_RETRY, "open entry (its type kept changing)", name, chars);
}

/* Remove everything inside the folder `dir` is. The listing comes from the handle. */
static int rt_empty(rt_ctx *c, HANDLE dir, int depth) {
  if (depth > RT_MAX_DEPTH) return rt_fail(c, ERROR_FILENAME_EXCED_RANGE, "walk (tree too deep)", NULL, 0);
  BYTE *buf = (BYTE *)malloc(RT_BUF_BYTES);
  if (!buf) return rt_fail(c, ERROR_NOT_ENOUGH_MEMORY, "walk", NULL, 0);
  int ok = 1;
  for (int pass = 0; ok; pass++) {
    if (pass >= RT_MAX_PASSES) { ok = rt_fail(c, ERROR_DIR_NOT_EMPTY, "empty folder (it kept refilling)", NULL, 0); break; }
    int seen = 0;
    FILE_INFO_BY_HANDLE_CLASS cls = FileIdBothDirectoryRestartInfo; /* each pass lists from the start */
    while (ok) {
      if (!GetFileInformationByHandleEx(dir, cls, buf, RT_BUF_BYTES)) {
        DWORD e = GetLastError();
        if (e != ERROR_NO_MORE_FILES) ok = rt_fail(c, e, "list folder", NULL, 0);
        break;
      }
      cls = FileIdBothDirectoryInfo;
      FILE_ID_BOTH_DIR_INFO *fi = (FILE_ID_BOTH_DIR_INFO *)buf;
      for (;;) {
        DWORD n = fi->FileNameLength / sizeof(WCHAR);
        int dots = (n == 1 && fi->FileName[0] == L'.') || (n == 2 && fi->FileName[0] == L'.' && fi->FileName[1] == L'.');
        if (!dots) {
          seen++;
          if (fi->FileNameLength > 0xFFFE) { ok = rt_fail(c, ERROR_FILENAME_EXCED_RANGE, "open entry", fi->FileName, n); break; }
          if (!rt_entry(c, dir, fi->FileName, (USHORT)fi->FileNameLength, fi->FileAttributes, depth)) { ok = 0; break; }
        }
        if (!fi->NextEntryOffset) break;
        fi = (FILE_ID_BOTH_DIR_INFO *)((BYTE *)fi + fi->NextEntryOffset);
      }
    }
    if (!seen) break; /* a full pass that listed nothing: the folder is empty */
  }
  free(buf);
  return ok;
}

/* The whole job, no N-API in it (it also runs on a worker thread). Returns 1 on success; else c holds the error. */
static int rt_remove(rt_ctx *c, const WCHAR *path, int keep_root) {
  memset(c, 0, sizeof(*c));
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  c->create = ntdll ? (rt_nt_create_file)GetProcAddress(ntdll, "NtCreateFile") : NULL;
  c->to_dos = ntdll ? (rt_nt_status_to_dos)GetProcAddress(ntdll, "RtlNtStatusToDosError") : NULL;
  if (!c->create || !c->to_dos) return rt_fail(c, ERROR_PROC_NOT_FOUND, "find NtCreateFile", NULL, 0);
  HANDLE h = CreateFileW(path, DELETE | SYNCHRONIZE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | FILE_LIST_DIRECTORY,
                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                         FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (h == INVALID_HANDLE_VALUE) return rt_fail(c, GetLastError(), "open root", NULL, 0);
  DWORD attrs = 0, tag = 0;
  int ok;
  if (!rt_kind(h, &attrs, &tag)) ok = rt_fail(c, GetLastError(), "read root type", NULL, 0);
  else if (RT_IS_LINK(attrs, tag)) ok = rt_fail(c, RT_REFUSED_LINK, "refused: root is a reparse point", NULL, 0);
  else if (!(attrs & FILE_ATTRIBUTE_DIRECTORY)) ok = rt_fail(c, RT_REFUSED_NOT_DIR, "refused: root is not a directory", NULL, 0);
  else if (keep_root) ok = rt_empty(c, h, 0);
  else ok = rt_remove_dir(c, h, attrs, 0, NULL, 0);
  CloseHandle(h);
  return ok;
}

static const char *rt_code(uint32_t code) {
  if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) return "ENOENT";
  if (code == ERROR_ACCESS_DENIED) return "EPERM";
  if (code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION) return "EBUSY";
  if (code == ERROR_DIR_NOT_EMPTY) return "ENOTEMPTY";
  return "EIO";
}
#define RT_ERRNO_LABEL "win32"

static rt_char *rt_path_arg(napi_env env, napi_value v) { return utf16_arg(env, v); }
#else
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef char rt_char;
typedef struct {
  uint32_t code;     /* 0 = no error yet; else an errno or RT_REFUSED_* */
  const char *step;  /* what failed */
  char name[800];    /* the entry it failed on ("" = the root) */
  uint32_t links;    /* links removed so far */
} rt_ctx;

#define RT_OPEN_DIR (O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
/* What open(O_NOFOLLOW | O_DIRECTORY) and unlinkat give when the name is not (or no longer) a real folder. */
#define RT_NOT_A_FOLDER(e) ((e) == ELOOP || (e) == ENOTDIR || (e) == EMLINK)

static int rt_fail(rt_ctx *c, int code, const char *step, const char *name) {
  if (c->code) return 0; /* the first error is the one reported */
  c->code = code ? (uint32_t)code : (uint32_t)EIO;
  c->step = step;
  snprintf(c->name, sizeof(c->name), "%s", name ? name : "");
  return 0;
}

static int rt_empty(rt_ctx *c, int dfd, int depth);

/*
 * Remove the folder `name` inside the folder `dfd` is. Returns 1 done, 0 failed, 2 "it is not a
 * folder now" (the caller looks again). On "not empty" (a creator raced us): pause, re-walk, retry.
 */
static int rt_remove_dir(rt_ctx *c, int dfd, const char *name, int depth) {
  for (int i = 0; i < RT_RMDIR_TRIES; i++) {
    if (i) usleep(10000u * (unsigned)i);
    int fd = openat(dfd, name, RT_OPEN_DIR); /* fails on a link: O_NOFOLLOW */
    if (fd < 0) {
      if (errno == ENOENT) return 1; /* someone else removed it */
      if (RT_NOT_A_FOLDER(errno)) return 2;
      return rt_fail(c, errno, "open folder", name);
    }
    int ok = rt_empty(c, fd, depth + 1);
    close(fd);
    if (!ok) return 0;
    /* By name inside dfd: removes an empty folder only. A link there now fails with ENOTDIR. */
    if (unlinkat(dfd, name, AT_REMOVEDIR) == 0 || errno == ENOENT) return 1;
    if (errno == ENOTDIR) return 2;
    if (errno != ENOTEMPTY && errno != EEXIST) return rt_fail(c, errno, "delete folder", name);
  }
  return rt_fail(c, ENOTEMPTY, "delete folder (it kept refilling)", name);
}

/* One listed entry of the folder `dfd` is. Every call here takes (dfd, bare name) and never follows. */
static int rt_entry(rt_ctx *c, int dfd, const char *name, int depth) {
  for (int attempt = 0; attempt < 3; attempt++) {
    struct stat st;
    if (fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) return 1; /* someone else removed it */
      return rt_fail(c, errno, "read entry type", name);
    }
    if (S_ISDIR(st.st_mode)) {
      int r = rt_remove_dir(c, dfd, name, depth);
      if (r != 2) return r;
      continue; /* it stopped being a folder: look again */
    }
    /* A file, a link or anything else: unlinkat removes the name itself and never what a link points at. */
    if (unlinkat(dfd, name, 0) == 0) {
      if (S_ISLNK(st.st_mode)) c->links++;
      return 1;
    }
    if (errno == ENOENT) return 1;
    if (errno == EISDIR || errno == EPERM) { /* it may be a folder now (Linux says EISDIR, macOS EPERM): look again */
      int e = errno;
      struct stat again;
      if (fstatat(dfd, name, &again, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(again.st_mode)) continue;
      return rt_fail(c, e, "delete entry", name);
    }
    return rt_fail(c, errno, "delete entry", name);
  }
  return rt_fail(c, EAGAIN, "delete entry (its type kept changing)", name);
}

/* Remove everything inside the folder `dfd` is. The listing comes from the descriptor. */
static int rt_empty(rt_ctx *c, int dfd, int depth) {
  if (depth > RT_MAX_DEPTH) return rt_fail(c, ENAMETOOLONG, "walk (tree too deep)", NULL);
  int ok = 1;
  for (int pass = 0; ok; pass++) {
    if (pass >= RT_MAX_PASSES) { ok = rt_fail(c, ENOTEMPTY, "empty folder (it kept refilling)", NULL); break; }
    /* "." inside dfd is the folder dfd is, whatever its path is now. A fresh descriptor lists from the start. */
    int lfd = openat(dfd, ".", RT_OPEN_DIR);
    if (lfd < 0) { ok = rt_fail(c, errno, "list folder", NULL); break; }
    DIR *dir = fdopendir(lfd);
    if (!dir) { int e = errno; close(lfd); ok = rt_fail(c, e, "list folder", NULL); break; }
    int seen = 0;
    for (;;) {
      errno = 0;
      struct dirent *de = readdir(dir);
      if (!de) { if (errno) ok = rt_fail(c, errno, "list folder", NULL); break; }
      if (de->d_name[0] == '.' && (de->d_name[1] == 0 || (de->d_name[1] == '.' && de->d_name[2] == 0))) continue;
      seen++;
      if (!rt_entry(c, dfd, de->d_name, depth)) { ok = 0; break; }
    }
    closedir(dir); /* closes lfd */
    if (!seen) break; /* a full pass that listed nothing: the folder is empty */
  }
  return ok;
}

/* The whole job, no N-API in it (it also runs on a worker thread). Returns 1 on success; else c holds the error. */
static int rt_remove(rt_ctx *c, const char *path, int keep_root) {
  memset(c, 0, sizeof(*c));
  for (int i = 0; i < RT_RMDIR_TRIES; i++) {
    if (i) usleep(10000u * (unsigned)i);
    int fd = open(path, RT_OPEN_DIR);
    if (fd < 0) {
      int e = errno;
      if (RT_NOT_A_FOLDER(e)) {
        struct stat st; /* only to word the refusal; nothing is done on its answer */
        if (lstat(path, &st) == 0 && S_ISLNK(st.st_mode)) return rt_fail(c, (int)RT_REFUSED_LINK, "refused: root is a reparse point", NULL);
        return rt_fail(c, (int)RT_REFUSED_NOT_DIR, "refused: root is not a directory", NULL);
      }
      if (e == ENOENT && i > 0) return 1; /* gone between two tries */
      return rt_fail(c, e, "open root", NULL);
    }
    int ok = rt_empty(c, fd, 0);
    close(fd);
    if (!ok) return 0;
    if (keep_root) return 1;
    /* rmdir never follows a link and removes a folder only when it is empty. */
    if (rmdir(path) == 0 || errno == ENOENT) return 1;
    if (errno == ENOTDIR) return rt_fail(c, (int)RT_REFUSED_LINK, "refused: root became a reparse point", NULL);
    if (errno != ENOTEMPTY && errno != EEXIST) return rt_fail(c, errno, "delete root", NULL);
  }
  return rt_fail(c, ENOTEMPTY, "delete root (it kept refilling)", NULL);
}

static const char *rt_code(uint32_t code) {
  if (code == ENOENT) return "ENOENT";
  if (code == EPERM) return "EPERM";
  if (code == EACCES) return "EACCES";
  if (code == EBUSY) return "EBUSY";
  if (code == ENOTEMPTY || code == EEXIST) return "ENOTEMPTY";
  return "EIO";
}
#define RT_ERRNO_LABEL "errno"

/* The argument as UTF-8, malloc'd; NULL when it is not a non-empty string. */
static rt_char *rt_path_arg(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok || len == 0) return NULL;
  char *out = (char *)malloc(len + 1);
  if (!out) return NULL;
  if (napi_get_value_string_utf8(env, v, out, len + 1, &len) != napi_ok) { free(out); return NULL; }
  return out;
}
#endif

/* ---- N-API glue, the same on every platform ---- */

static napi_value rt_error(napi_env env, const rt_ctx *c) {
  char msg[1200];
  const char *code;
  if (c->code == RT_REFUSED_LINK || c->code == RT_REFUSED_NOT_DIR) {
    code = "EREFUSED";
    snprintf(msg, sizeof(msg), "%s", c->step);
  } else {
    code = rt_code(c->code);
    snprintf(msg, sizeof(msg), "removeTree: %s failed (" RT_ERRNO_LABEL " %lu)%s%s", c->step ? c->step : "walk",
             (unsigned long)c->code, c->name[0] ? " at " : "", c->name);
  }
  napi_value text, err, num, str;
  if (napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &text) != napi_ok || napi_create_error(env, NULL, text, &err) != napi_ok) return NULL;
  if (napi_create_uint32(env, c->code, &num) == napi_ok) napi_set_named_property(env, err, "errno", num);
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &str) == napi_ok) napi_set_named_property(env, err, "code", str);
  if (napi_create_uint32(env, c->links, &num) == napi_ok) napi_set_named_property(env, err, "links", num);
  return err;
}

/* (path, keepRoot?) -> the path in the platform's form (caller frees), or NULL with an error pending. */
static rt_char *rt_args(napi_env env, napi_callback_info info, const char *usage, int *keep_root) {
  size_t argc = 2;
  napi_value argv[2];
  napi_valuetype t;
  bool keep = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_typeof(env, argv[0], &t) != napi_ok || t != napi_string) { fail(env, usage); return NULL; }
  if (argc >= 2 && napi_typeof(env, argv[1], &t) == napi_ok && t == napi_boolean) napi_get_value_bool(env, argv[1], &keep);
  rt_char *path = rt_path_arg(env, argv[0]);
  if (!path) { fail(env, usage); return NULL; }
  *keep_root = keep ? 1 : 0;
  return path;
}

static napi_value remove_tree(napi_env env, napi_callback_info info) {
  int keep_root = 0;
  rt_char *path = rt_args(env, info, "removeTree(path, keepRoot?): path must be a non-empty string", &keep_root);
  if (!path) return NULL;
  rt_ctx c;
  int ok = rt_remove(&c, path, keep_root);
  free(path);
  napi_value v = NULL;
  if (!ok) {
    v = rt_error(env, &c);
    if (v) napi_throw(env, v); else napi_throw_error(env, NULL, "removeTree failed");
    return NULL;
  }
  if (napi_create_uint32(env, c.links, &v) != napi_ok) return NULL;
  return v;
}

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  rt_char *path;
  int keep_root;
  int ok;
  rt_ctx c;
} rt_job;

static void rt_job_run(napi_env env, void *data) {
  (void)env;
  rt_job *j = (rt_job *)data;
  j->ok = rt_remove(&j->c, j->path, j->keep_root);
}

/* The worker never ran or its result could not be made: reported as EIO on both platforms. */
#ifdef _WIN32
#define RT_WORKER_FAILED ERROR_GEN_FAILURE
#else
#define RT_WORKER_FAILED EIO
#endif

static void rt_job_done(napi_env env, napi_status status, void *data) {
  rt_job *j = (rt_job *)data;
  napi_value v = NULL;
  if (status == napi_ok && j->ok && napi_create_uint32(env, j->c.links, &v) == napi_ok) {
    napi_resolve_deferred(env, j->deferred, v);
  } else {
    if (!j->c.code) { j->c.code = (uint32_t)RT_WORKER_FAILED; j->c.step = "worker"; j->c.name[0] = 0; }
    v = rt_error(env, &j->c);
    if (!v) napi_get_undefined(env, &v);
    napi_reject_deferred(env, j->deferred, v);
  }
  napi_delete_async_work(env, j->work);
  free(j->path);
  free(j);
}

static napi_value remove_tree_async(napi_env env, napi_callback_info info) {
  int keep_root = 0;
  rt_char *path = rt_args(env, info, "removeTreeAsync(path, keepRoot?): path must be a non-empty string", &keep_root);
  if (!path) return NULL;
  rt_job *j = (rt_job *)calloc(1, sizeof(rt_job));
  napi_value promise, label;
  if (!j) { free(path); return fail(env, "removeTreeAsync: out of memory"); }
  j->path = path;
  j->keep_root = keep_root;
  if (napi_create_promise(env, &j->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "guppyRemoveTree", NAPI_AUTO_LENGTH, &label) != napi_ok ||
      napi_create_async_work(env, NULL, label, rt_job_run, rt_job_done, j, &j->work) != napi_ok) {
    free(path); free(j);
    return fail(env, "removeTreeAsync: the job could not be created");
  }
  if (napi_queue_async_work(env, j->work) != napi_ok) {
    napi_delete_async_work(env, j->work);
    free(path); free(j);
    return fail(env, "removeTreeAsync: the job could not be queued");
  }
  return promise;
}

#ifdef _WIN32
/*
 * MIRROR-PARSE-ZERO-108: threadCpuMs() -> number, the CPU time of the CALLING thread in ms.
 *
 * process.threadCpuUsage is GetThreadTimes on Windows: it moves a whole scheduler step (15.6 ms) at a
 * time, charged to whichever thread runs at the clock interrupt. A parse slice of a few ms reads 0 or
 * a step, never its own work. QueryThreadCycleTime counts the cycles the thread itself ran, updated at
 * every switch, so it has no step.
 *
 * Cycles are turned into ms with one rate, measured once and then never changed (a rate that moved
 * between two readings would move every earlier cycle with it). The rate is the processor's cycle
 * counter against QueryPerformanceCounter between two points: the first load of this addon and the
 * first call. Both counters run on wall time, so a preemption between the points does not bend it.
 * Each point is read as counter, cycles, counter and kept only if the two counter readings are close,
 * so a preemption inside a point is not taken either. If the first call comes within 2 ms of the
 * load, it waits out the rest of those 2 ms, once.
 * Throws when a reading fails or the rate cannot be measured; the caller then stays on its own clock.
 */
#include <intrin.h>

typedef struct { LONGLONG qpc; unsigned __int64 tsc; } cpu_point;
static cpu_point cpu_p0;
static int cpu_p0_set = 0;
static double cpu_cycles_per_ms = 0;

/* One point in time on both counters. 0 if no clean reading could be taken. */
static int cpu_point_read(cpu_point *out, LONGLONG qpf) {
  LONGLONG close_ticks = qpf / 200000; /* 5 us */
  if (close_ticks < 1) close_ticks = 1;
  for (int i = 0; i < 64; i++) {
    LARGE_INTEGER a, b;
    if (!QueryPerformanceCounter(&a)) return 0;
    unsigned __int64 t = __rdtsc();
    if (!QueryPerformanceCounter(&b)) return 0;
    if (b.QuadPart - a.QuadPart <= close_ticks) {
      out->qpc = a.QuadPart + (b.QuadPart - a.QuadPart) / 2;
      out->tsc = t;
      return 1;
    }
  }
  return 0;
}

static void cpu_clock_load(void) {
  LARGE_INTEGER f;
  if (cpu_p0_set || !QueryPerformanceFrequency(&f) || f.QuadPart <= 0) return;
  cpu_p0_set = cpu_point_read(&cpu_p0, f.QuadPart);
}

static napi_value thread_cpu_ms(napi_env env, napi_callback_info info) {
  (void)info;
  if (cpu_cycles_per_ms <= 0) {
    LARGE_INTEGER f;
    if (!QueryPerformanceFrequency(&f) || f.QuadPart <= 0) return fail(env, "threadCpuMs: no performance counter");
    if (!cpu_p0_set) cpu_clock_load();
    if (!cpu_p0_set) return fail(env, "threadCpuMs: the first point of the rate could not be read");
    LONGLONG need = f.QuadPart / 500; /* 2 ms */
    cpu_point p1;
    for (;;) {
      if (!cpu_point_read(&p1, f.QuadPart)) return fail(env, "threadCpuMs: the second point of the rate could not be read");
      if (p1.qpc - cpu_p0.qpc >= need) break;
    }
    double ms = (double)(p1.qpc - cpu_p0.qpc) * 1000.0 / (double)f.QuadPart;
    double rate = (double)(p1.tsc - cpu_p0.tsc) / ms;
    /* 100 MHz to 100 GHz: outside it the cycle counter is not a clock (or went backwards). */
    if (p1.tsc <= cpu_p0.tsc || !(rate >= 1e5 && rate <= 1e8)) return fail(env, "threadCpuMs: the cycle rate could not be measured");
    cpu_cycles_per_ms = rate;
  }
  ULONG64 cycles;
  if (!QueryThreadCycleTime(GetCurrentThread(), &cycles)) return fail(env, "threadCpuMs: QueryThreadCycleTime failed");
  napi_value out;
  if (napi_create_double(env, (double)cycles / cpu_cycles_per_ms, &out) != napi_ok) return NULL;
  return out;
}
#endif

static int export_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn) == napi_ok &&
         napi_set_named_property(env, exports, name, fn) == napi_ok;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "finalPath", NAPI_AUTO_LENGTH, final_path, NULL, &fn) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "finalPath", fn) != napi_ok) return NULL;
  napi_value api;
  if (napi_create_uint32(env, GUPPY_REMOVE_TREE_API, &api) != napi_ok ||
      napi_set_named_property(env, exports, "removeTreeApi", api) != napi_ok ||
      !export_fn(env, exports, "removeTree", remove_tree) ||
      !export_fn(env, exports, "removeTreeAsync", remove_tree_async)) {
    return NULL;
  }
#ifdef _WIN32
  if (!export_fn(env, exports, "procOpen", proc_open) || !export_fn(env, exports, "procAlive", proc_alive) ||
      !export_fn(env, exports, "procClose", proc_close) || !export_fn(env, exports, "procAdopt", proc_adopt) ||
      !export_fn(env, exports, "posixRename", posix_rename) ||
      !export_fn(env, exports, "posixRenameAsync", posix_rename_async)) {
    return NULL;
  }
  cpu_clock_load();
  if (!export_fn(env, exports, "threadCpuMs", thread_cpu_ms)) return NULL;
#endif
  return exports;
}
