import type { App } from '../main.ts';

/**
 * Retired: the TV-era story intro. The one line of story now plays in attract mode (boot.ts) on
 * first launch, and the router maps `story` to the game select; this stays so routes compile.
 */
export function storyScreen(app: App) {
  const t = window.setTimeout(() => app.go({ name: 'arcade' }), 0);
  return () => clearTimeout(t);
}
