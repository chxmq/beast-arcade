// Presenter entry point: WebGL2 if available, otherwise Canvas2D.

import { create2DPresenter } from './present-2d.ts';
import { createGLPresenter, webgl2Available } from './present-gl.ts';
import type { Presenter } from './present-common.ts';

export type { PresentOpts, Presenter, RGB } from './present-common.ts';
export { DEFAULT_INK, DEFAULT_PAPER } from './present-common.ts';

/**
 * Create a presenter for `canvas`. The canvas should be sized with CSS; its backing store is kept
 * at CSS size x devicePixelRatio automatically. `prefer: '2d'` forces the fallback.
 */
export function createPresenter(canvas: HTMLCanvasElement, prefer: 'auto' | '2d' = 'auto'): Presenter {
  if (prefer !== '2d' && webgl2Available()) {
    try {
      const p = createGLPresenter(canvas);
      if (p) return p;
    } catch (e) {
      console.warn('WebGL2 presenter failed, falling back to Canvas2D', e);
    }
  }
  return create2DPresenter(canvas);
}
