/**
 * REBRAND-GUPPY (1.1.82, Jim B1): carry Windows "Open at login" across the exe rename.
 *
 * Onboarding's OPEN AT LOGIN toggle calls app.setLoginItemSettings({ openAtLogin }), and on Windows
 * Electron writes an HKCU ...\CurrentVersion\Run value whose command is process.execPath, i.e.
 * ...\Munder Difflin.exe up to 1.1.81. The update deletes that exe and nothing else rewrites the
 * value (the installer does not know about it; the toggle lives only in onboarding), so the app
 * would silently stop starting at login and getLoginItemSettings() would read false.
 *
 * On every packaged Windows start: if a login item for the old exe in THIS install folder is on,
 * turn it on for the running exe, and turn the old one off if it is still there (it is, only when
 * its Run value name differs from ours; by default the name is the same and the first call
 * already rewrote it). Idempotent: once moved, the old path no longer reads as on.
 *
 * Free of any `electron` import (the app object is passed in), so test/rebrand-a-182 drives it
 * with a stub.
 */
import { basename, dirname, join } from 'node:path';

export const OLD_EXE_NAME = 'Munder Difflin.exe';

export interface LoginItemApp {
  getLoginItemSettings(options?: { path?: string }): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; path?: string }): void;
}

export type LoginItemOutcome = 'skipped' | 'none' | 'moved';

export function carryLoginItem(app: LoginItemApp, execPath: string, opts: { platform?: NodeJS.Platform; packaged?: boolean } = {}): LoginItemOutcome {
  if ((opts.platform ?? process.platform) !== 'win32' || opts.packaged === false) return 'skipped';
  if (basename(execPath).toLowerCase() === OLD_EXE_NAME.toLowerCase()) return 'skipped';   // still the old exe
  const oldExe = join(dirname(execPath), OLD_EXE_NAME);
  if (!app.getLoginItemSettings({ path: oldExe }).openAtLogin) return 'none';
  app.setLoginItemSettings({ openAtLogin: true });
  if (app.getLoginItemSettings({ path: oldExe }).openAtLogin) app.setLoginItemSettings({ openAtLogin: false, path: oldExe });
  return 'moved';
}
