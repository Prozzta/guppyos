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
 * One export: finalPath(fd: number) -> string. Any failure throws; the caller refuses the access.
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

NAPI_MODULE_INIT() {
  napi_value fn;
  if (napi_create_function(env, "finalPath", NAPI_AUTO_LENGTH, final_path, NULL, &fn) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "finalPath", fn) != napi_ok) return NULL;
  return exports;
}
