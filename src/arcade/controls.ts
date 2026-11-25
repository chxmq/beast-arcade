// Cabinet controls: one bus for keyboard, the on-screen control panel, and touch.
// Games subscribe to buttons; pointer input on the screen stays with each game.

export type Button = 'A' | 'B' | 'C' | 'START' | 'COIN' | 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';

export const BUTTONS: readonly Button[] = ['A', 'B', 'C', 'START', 'COIN', 'LEFT', 'RIGHT', 'UP', 'DOWN'];

type Handler = (button: Button) => void;

/** KeyboardEvent.key (lower-cased) to cabinet button. ARCADE.md section 3. */
export const KEYMAP: Readonly<Record<string, Button>> = {
  a: 'A', j: 'A', '1': 'A', z: 'A',
  s: 'B', k: 'B', '2': 'B', x: 'B',
  d: 'C', l: 'C', '3': 'C', c: 'C',
  enter: 'START', ' ': 'START',
  '5': 'COIN',
  arrowleft: 'LEFT', arrowright: 'RIGHT', arrowup: 'UP', arrowdown: 'DOWN',
};

/** The cabinet button a key drives, or null. */
export function keyToButton(key: string): Button | null {
  return KEYMAP[key.toLowerCase()] ?? null;
}

export class Controls {
  private handlers = new Map<Button, Set<Handler>>();
  private releaseHandlers = new Map<Button, Set<Handler>>();
  private down = new Set<Button>();
  private visual = new Set<(button: Button, down: boolean) => void>();
  private any = new Set<Handler>();

  /** `target` gets the keyboard listeners (the window in the browser; none in tests). */
  constructor(target: Window | null = typeof window === 'undefined' ? null : window) {
    if (!target) return;
    target.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const b = keyToButton(e.key);
      if (!b) return;
      e.preventDefault();
      if (e.repeat) return;
      this.press(b);
    });
    target.addEventListener('keyup', (e) => {
      const b = keyToButton(e.key);
      if (b) this.release(b);
    });
    target.addEventListener('blur', () => this.releaseAll());
  }

  /** Subscribe to a button press. Returns the unsubscribe function. */
  on(button: Button, fn: Handler): () => void {
    let set = this.handlers.get(button);
    if (!set) this.handlers.set(button, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Subscribe to a button release. */
  onRelease(button: Button, fn: Handler): () => void {
    let set = this.releaseHandlers.get(button);
    if (!set) this.releaseHandlers.set(button, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Any button press (idle timers, attract mode). Runs before the button's own handlers. */
  onAny(fn: Handler): () => void {
    this.any.add(fn);
    return () => this.any.delete(fn);
  }

  /** The cabinet panel listens here to light its buttons. */
  onVisual(fn: (button: Button, down: boolean) => void): () => void {
    this.visual.add(fn);
    return () => this.visual.delete(fn);
  }

  isDown(button: Button): boolean {
    return this.down.has(button);
  }

  press(button: Button): void {
    if (this.down.has(button)) return;
    this.down.add(button);
    for (const fn of this.visual) fn(button, true);
    for (const fn of [...this.any]) fn(button);
    for (const fn of [...(this.handlers.get(button) ?? [])]) fn(button);
  }

  release(button: Button): void {
    if (!this.down.delete(button)) return;
    for (const fn of this.visual) fn(button, false);
    for (const fn of [...(this.releaseHandlers.get(button) ?? [])]) fn(button);
  }

  /** Let go of everything (window blur, a touch cancelled by the OS). */
  releaseAll(): void {
    for (const b of [...this.down]) this.release(b);
  }
}

export const controls = new Controls();
