'use strict';
// @electron/asar resolves createPackage with out.end(), the archive's write stream, before that stream has
// closed its file handle. Under Electron a folder that holds a file still open cannot be removed (ENOTEMPTY),
// so a test that cleans up right after packing starts against an open archive. packClosed() waits for 'close'.
async function archiveClosed(ws) {
  if (!ws || typeof ws.once !== 'function' || typeof ws.closed !== 'boolean') {
    throw new Error('createPackage no longer resolves with its write stream: the test cannot wait for the archive to close');
  }
  if (ws.closed) return;
  await new Promise((res, rej) => { ws.once('close', res); ws.once('error', rej); });
}
// asar.createPackage(...args), resolved only once the archive is closed.
async function packClosed(asar, ...args) {
  await archiveClosed(await asar.createPackage(...args));
}
module.exports = { archiveClosed, packClosed };
