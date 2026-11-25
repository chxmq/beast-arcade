import type { App } from '../main.ts';

/**
 * Retired: the TV-era channel guide. The game select (route `arcade`) replaced it, and the router
 * already maps `guide` there; this stays so older links and screens keep compiling.
 */
export function guideScreen(app: App) {
  const t = window.setTimeout(() => app.go({ name: 'arcade' }), 0);
  return () => clearTimeout(t);
}
