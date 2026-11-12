/**
 * BLOB-MESSAGE: the one host for dialogs the blob's ring opens in the Guppy window. Main sends
 * 'blob:openInApp' with the action; each action registers its dialog in BLOB_APP_DIALOGS
 * (message: UHera; screenshot: Dwight; meeting: Andy). An action with no dialog yet opens nothing.
 */
import { useEffect, useState } from 'react';
import type { BlobAppAction } from '@shared/blob';
import { BlobMessageDialog } from './BlobMessageDialog';

export type BlobAppDialog = (p: { onClose(): void }) => JSX.Element;
export const BLOB_APP_DIALOGS: Partial<Record<BlobAppAction, BlobAppDialog>> = {
  message: BlobMessageDialog,
};

export function BlobAppDialogs(): JSX.Element | null {
  const [open, setOpen] = useState<BlobAppAction | null>(null);
  useEffect(() => window.cth.onBlobOpenInApp((action) => {
    if (BLOB_APP_DIALOGS[action]) setOpen(action);
  }), []);
  const Dialog = open ? BLOB_APP_DIALOGS[open] : undefined;
  return Dialog ? <Dialog onClose={() => setOpen(null)} /> : null;
}
