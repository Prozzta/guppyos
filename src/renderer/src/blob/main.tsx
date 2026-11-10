/**
 * GUPPY-BLOB-P01: the blob overlay renderer. A blobatar face that idles; a click opens the radial
 * ring (UX: agents/god/refs/stapler-ring.png); a drag moves the overlay (main follows its own
 * cursor reading). Only `window.blob` (src/preload/blob.ts) is available here.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'blobatar/motion.css';
import './blob.css';
import { BlobApp } from './BlobApp';

const root = document.getElementById('blob-root');
if (root) createRoot(root).render(<StrictMode><BlobApp /></StrictMode>);
