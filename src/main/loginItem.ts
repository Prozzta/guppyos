import { app } from 'electron';
import { DEV_ISOLATION } from './devIsolation';

/**
 * Login items are persistent OS state. Keep the decision in a small module so
 * the DEV/trial refusal is directly executable under an Electron stub.
 */
export function setLoginItem(enabled: unknown): boolean {
  if (DEV_ISOLATION) return false;
  app.setLoginItemSettings({ openAtLogin: enabled === true });
  return app.getLoginItemSettings().openAtLogin;
}
