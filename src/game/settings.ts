// Per-viewer conveniences only; the game works the same without storage.
const KEY = 'static.settings.v1';

interface Settings {
  calm: boolean;
  primerSeen: boolean;
  storySeen: boolean;
  muted: boolean;
}

function load(): Settings {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const base: Settings = { calm: reduced, primerSeen: false, storySeen: false, muted: false };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...base, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return base;
}

export const settings: Settings = load();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}
