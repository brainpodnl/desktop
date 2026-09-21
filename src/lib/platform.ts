/**
 * Which keyboard this window is under. The app menu carries the real
 * accelerator on macOS, so this exists for the two places the DOM has to agree
 * with it: the shortcut printed next to a control, and the `Ctrl+,` fallback on
 * the platforms that have no app menu to put a Settings item in.
 */
export const isMac = navigator.userAgent.includes('Mac');

/** As a user would read it off the menu bar. */
export const SETTINGS_SHORTCUT = isMac ? '⌘,' : 'Ctrl+,';
