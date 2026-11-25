// Input adapter: the cabinet button bus (keyboard, control panel, touch panel) plus pointer
// taps and moves on the MICRO MAYHEM canvas, collected into one FrameInput per frame.
import { controls, type Button } from '../arcade/controls.ts';
import type { Btn, FrameInput, Pt } from './types.ts';

const BUTTONS: readonly Btn[] = ['A', 'B', 'C', 'START', 'LEFT', 'RIGHT', 'UP', 'DOWN'];

export class MicroInput {
  private taps: Pt[] = [];
  private presses: Btn[] = [];
  private pointer: Pt | null = null;
  private lastPointer = 0;
  private lastKey = 0;
  private offs: (() => void)[] = [];
  /** Raw button listener (results screen, escape handling). */
  onButton: ((b: Btn) => void) | null = null;

  constructor(el: HTMLElement, private readonly toLogical: (cx: number, cy: number) => Pt) {
    for (const b of BUTTONS) {
      this.offs.push(controls.on(b as Button, () => {
        this.presses.push(b);
        if (b === 'LEFT' || b === 'RIGHT') this.lastKey = performance.now();
        this.onButton?.(b);
      }));
    }
    const down = (e: PointerEvent) => {
      if (e.button !== undefined && e.button > 0) return;
      const p = this.toLogical(e.clientX, e.clientY);
      this.taps.push(p);
      this.pointer = p;
      this.lastPointer = performance.now();
    };
    const move = (e: PointerEvent) => {
      // Mouse: hovering steers. Touch and pen: only while pressed (dragging).
      if (e.pointerType !== 'mouse' && e.buttons === 0) return;
      this.pointer = this.toLogical(e.clientX, e.clientY);
      this.lastPointer = performance.now();
    };
    const ctx = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('contextmenu', ctx);
    this.offs.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('contextmenu', ctx);
    });
  }

  /** Everything since the last frame. */
  frame(): FrameInput {
    const out: FrameInput = {
      taps: this.taps,
      presses: this.presses,
      pointer: this.pointer,
      pointerLead: this.pointer !== null && this.lastPointer >= this.lastKey,
      left: controls.isDown('LEFT'),
      right: controls.isDown('RIGHT'),
    };
    this.taps = [];
    this.presses = [];
    return out;
  }

  /** Drop anything queued (after a phase change that should not inherit taps). */
  flush(): void {
    this.taps = [];
    this.presses = [];
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.onButton = null;
  }
}
