type Child = Node | string | null | undefined | false;

/** Tiny element helper: h('div', { class: 'x' }, child, 'text'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function shortAddr(a: string): string {
  if (!a || a === '0x0') return 'unknown';
  const s = a.toLowerCase();
  return s.length > 12 ? `${s.slice(0, 6)}..${s.slice(-4)}` : s;
}

export function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/** HH:MM:SS:FF broadcast timecode from 60 Hz ticks. */
export function timecode(tick: number): string {
  const f = Math.floor((tick % 60) / 2);
  const s = Math.floor(tick / 60);
  return `00:${pad(Math.floor(s / 60), 2)}:${pad(s % 60, 2)}:${pad(f, 2)}`;
}
