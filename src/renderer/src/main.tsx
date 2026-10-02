import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import brandLogo from '@brand/logo.png?url';
import './design/global.css';
import { startRendererStartupTiming } from './startupTiming';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installRendererErrorForwarder } from './rendererErrors';

// HISTORY-SCROLL-FREEZE F3: an uncaught renderer error leaves a renderer-error row in log.jsonl.
installRendererErrorForwarder();

// STARTUP-TIMING-162: long tasks and first redraws of the first 60 s (then it stops).
startRendererStartupTiming();

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/png';
favicon.href = brandLogo;
document.head.appendChild(favicon);

const splashMark = document.querySelector('#cth-splash .mk');
if (splashMark) {
  const img = document.createElement('img');
  img.src = brandLogo;
  img.alt = 'Munder Difflin';
  img.style.cssText = 'height:56px;width:auto;display:block';
  splashMark.replaceWith(img);
}

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

// HISTORY-SCROLL-FREEZE F3: the ROOT boundary. Without one, React 18 unmounts the whole tree on
// an uncaught render error and the window goes dead with no message and no log row.
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary where="The app" recover="reload">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
