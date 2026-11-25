import { describe, expect, it, vi } from 'vitest';
import { BUTTONS, Controls, KEYMAP, keyToButton, type Button } from './controls.ts';

describe('keyboard mapping (ARCADE.md section 3)', () => {
  const cases: [string, Button][] = [
    ['a', 'A'], ['j', 'A'], ['1', 'A'], ['z', 'A'],
    ['s', 'B'], ['k', 'B'], ['2', 'B'], ['x', 'B'],
    ['d', 'C'], ['l', 'C'], ['3', 'C'], ['c', 'C'],
    ['Enter', 'START'], [' ', 'START'],
    ['5', 'COIN'],
    ['ArrowLeft', 'LEFT'], ['ArrowRight', 'RIGHT'], ['ArrowUp', 'UP'], ['ArrowDown', 'DOWN'],
  ];
  it.each(cases)('%j drives %s', (key, b) => {
    expect(keyToButton(key)).toBe(b);
  });
  it('is case-insensitive (caps lock, shift)', () => {
    expect(keyToButton('A')).toBe('A');
    expect(keyToButton('K')).toBe('B');
    expect(keyToButton('ENTER')).toBe('START');
  });
  it('leaves every other key alone', () => {
    for (const k of ['Escape', 'Tab', 'q', 'w', 'e', 'f', 'g', 'm', '4', '6', '0', 'Shift', 'F5']) expect(keyToButton(k)).toBeNull();
  });
  it('every mapped key lands on a real button, and every button but none is reachable', () => {
    for (const b of Object.values(KEYMAP)) expect(BUTTONS).toContain(b);
    for (const b of BUTTONS) expect(Object.values(KEYMAP)).toContain(b);
  });
});

/** A stand-in for window: collects listeners so tests can fire key events. */
function fakeWindow() {
  const ls = new Map<string, ((e: unknown) => void)[]>();
  return {
    target: { addEventListener: (t: string, fn: (e: unknown) => void) => ls.set(t, [...(ls.get(t) ?? []), fn]) } as unknown as Window,
    fire(type: string, e: Omit<Partial<KeyboardEvent>, 'target'> & { target?: unknown } = {}) {
      const ev = { metaKey: false, ctrlKey: false, altKey: false, repeat: false, target: null, preventDefault: vi.fn(), ...e };
      for (const fn of ls.get(type) ?? []) fn(ev);
      return ev;
    },
  };
}

describe('the controls bus', () => {
  it('a key press presses the button once; repeats and modifiers are ignored', () => {
    const w = fakeWindow();
    const c = new Controls(w.target);
    const a = vi.fn();
    c.on('A', a);
    const ev = w.fire('keydown', { key: 'z' });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(a).toHaveBeenCalledTimes(1);
    expect(c.isDown('A')).toBe(true);
    w.fire('keydown', { key: 'z', repeat: true });
    w.fire('keydown', { key: 'a' });
    expect(a).toHaveBeenCalledTimes(1);
    w.fire('keyup', { key: 'z' });
    expect(c.isDown('A')).toBe(false);
    w.fire('keydown', { key: 'a', metaKey: true });
    w.fire('keydown', { key: 'a', ctrlKey: true });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('typing in a text field does not press buttons', () => {
    const w = fakeWindow();
    const c = new Controls(w.target);
    const s = vi.fn();
    c.on('START', s);
    const ev = w.fire('keydown', { key: ' ', target: { tagName: 'INPUT' } });
    expect(s).not.toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('press/release from the panel, visuals, release handlers, onAny and unsubscribe', () => {
    const c = new Controls(null);
    const order: string[] = [];
    const offAny = c.onAny((b) => order.push(`any:${b}`));
    const offB = c.on('B', () => order.push('B'));
    const offUp = c.onRelease('B', () => order.push('B up'));
    const vis: [Button, boolean][] = [];
    c.onVisual((b, d) => vis.push([b, d]));
    c.press('B');
    c.press('B');
    c.release('B');
    c.release('B');
    expect(order).toEqual(['any:B', 'B', 'B up']);
    expect(vis).toEqual([['B', true], ['B', false]]);
    offAny();
    offB();
    offUp();
    c.press('B');
    c.release('B');
    expect(order).toEqual(['any:B', 'B', 'B up']);
  });

  it('a handler that subscribes during a press does not get that press', () => {
    const c = new Controls(null);
    const late = vi.fn();
    c.on('A', () => { c.on('A', late); });
    c.press('A');
    expect(late).not.toHaveBeenCalled();
    c.release('A');
    c.press('A');
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('releaseAll and window blur let go of everything held', () => {
    const w = fakeWindow();
    const c = new Controls(w.target);
    c.press('LEFT');
    c.press('A');
    w.fire('blur');
    expect(c.isDown('LEFT')).toBe(false);
    expect(c.isDown('A')).toBe(false);
    c.press('UP');
    c.releaseAll();
    expect(c.isDown('UP')).toBe(false);
  });
});
