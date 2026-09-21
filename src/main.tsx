import '@/styles/global.css';

import { getCurrentWindow } from '@tauri-apps/api/window';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app';
import { bootTheme } from '@/lib/theme';
import { SettingsWindow } from '@/screens/settings';

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing the #root element');

/*
 * Before the root, not inside it. The window is transparent until something
 * paints, so the first frame React produces is the first frame there is — and
 * it has to already be in the right palette, or a dark Mac opens this app with
 * a white flash.
 */
bootTheme();

/*
 * Two windows, one document. Settings is a second `NSWindow` pointed at this
 * same `index.html` with its own label, which keeps one bundle, one stylesheet
 * and one theme layer rather than a second Vite entry drifting away from the
 * first.
 */
const settings = getCurrentWindow().label === 'settings';

createRoot(container).render(
  <StrictMode>{settings ? <SettingsWindow /> : <App />}</StrictMode>,
);
