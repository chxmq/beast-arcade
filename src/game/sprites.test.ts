import { describe, expect, it } from 'vitest';
import { FIELD_H, FIELD_W, REACTION_TICKS } from '../sim/spec.ts';
import {
  artScale, boxRect, catchPose, devToField, dilate1, fieldToDev, fleePose, goldify, habitatPixels, HABITATS, hitPose,
  idlePose, isOpaqueArt, pixelSize, popScale, posedRect, REST, silhouette, spriteRect, stageLayout, wanderPos,
} from './sprites.ts';
import type { ChannelId } from './channels.ts';

const SCREENS: [number, number, number][] = [[960, 540, 1], [960, 540, 2], [1280, 720, 1], [412, 232, 3], [1000, 600, 1.5], [333, 187, 1]];

describe('stage layout', () => {
  it('fills the screen with the field, centred, and maps pointers back to the same field pixel', () => {
    for (const [w, hh, dpr] of SCREENS) {
      const L = stageLayout(w, hh, dpr);
      expect(L.devW).toBe(Math.round(w * dpr));
      expect(FIELD_W * L.s).toBeLessThanOrEqual(L.devW + 1e-6);
      expect(FIELD_H * L.s).toBeLessThanOrEqual(L.devH + 1e-6);
      // one side is filled exactly
      expect(Math.min(L.devW - FIELD_W * L.s, L.devH - FIELD_H * L.s)).toBeLessThan(1e-6);
      for (let x = 0; x < FIELD_W; x += 7) {
        for (let y = 0; y < FIELD_H; y += 5) {
          const d = fieldToDev(L, x + 0.5, y + 0.5);
          expect(devToField(L, d.x, d.y)).toEqual({ x, y, inside: true });
        }
      }
      expect(devToField(L, L.offX - 2, L.offY + 5).inside).toBe(false);
      expect(devToField(L, L.offX + FIELD_W * L.s + 1, L.offY + 5).inside).toBe(false);
    }
  });

  it('backdrop pixels are whole device pixels close to one field pixel', () => {
    for (const [w, hh, dpr] of SCREENS) {
      const L = stageLayout(w, hh, dpr);
      const P = pixelSize(L);
      expect(Number.isInteger(P)).toBe(true);
      expect(Math.abs(P - L.s)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
});

describe('sprite layout', () => {
  // Real roster shapes: common 32 px art in a 48 px box, featured 64 px art, wide and thin ones.
  const SHAPES: [number, number, number, number][] = [[48, 48, 32, 32], [59, 48, 32, 26], [50, 48, 56, 54], [26, 48, 29, 53], [64, 42, 64, 42], [22, 48, 24, 52], [64, 44, 29, 20]];

  it('art scale is a whole number and the closest one to the hitbox', () => {
    for (const [w, hh, dpr] of SCREENS) {
      const L = stageLayout(w, hh, dpr);
      for (const [bw, bh, aw, ah] of SHAPES) {
        const k = artScale(L.s, bw, bh, aw, ah);
        expect(Number.isInteger(k)).toBe(true);
        expect(k).toBeGreaterThanOrEqual(1);
        const target = Math.min((bw * L.s) / aw, (bh * L.s) / ah);
        if (target >= 1) expect(Math.abs(k - target)).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });

  it('art is centred on the hitbox at the sim position, in whole device pixels', () => {
    for (const [w, hh, dpr] of SCREENS) {
      const L = stageLayout(w, hh, dpr);
      for (const [bw, bh, aw, ah] of SHAPES) {
        for (const [px, py] of [[0, 0], [FIELD_W - bw, FIELD_H - bh], [101, 37]]) {
          const b = boxRect(L, px, py, bw, bh);
          const r = spriteRect(L, px, py, bw, bh, aw, ah);
          for (const v of [r.x, r.y, r.w, r.h, b.x, b.y, b.w, b.h]) expect(Number.isInteger(v)).toBe(true);
          expect(r.w).toBe(aw * r.k);
          expect(r.h).toBe(ah * r.k);
          // centres agree to within a device pixel
          expect(Math.abs(r.x + r.w / 2 - (b.x + b.w / 2))).toBeLessThanOrEqual(1);
          expect(Math.abs(r.y + r.h / 2 - (b.y + b.h / 2))).toBeLessThanOrEqual(1);
          // the hitbox in device px is the sim box (w x h field px from px, py)
          const tl = fieldToDev(L, px, py);
          expect(Math.abs(b.x - tl.x)).toBeLessThanOrEqual(0.5);
          expect(Math.abs(b.w - bw * L.s)).toBeLessThanOrEqual(1);
          // and the art covers it closely: most of the hitbox is under the art, most of the art is on the hitbox
          if (r.k >= 4) {
            const ox = Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x));
            const oy = Math.max(0, Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y));
            // rounding the scale to a whole number costs at most half an art pixel of scale
            const bound = (r.k / (r.k + 0.5)) ** 2 * 0.96;
            expect((ox * oy) / (b.w * b.h)).toBeGreaterThan(bound);
            expect((ox * oy) / (r.w * r.h)).toBeGreaterThan(bound);
          }
        }
      }
    }
  });

  it('a resting pose draws exactly the sprite rect; a squash keeps the feet on the ground', () => {
    const L = stageLayout(960, 540, 2);
    const e = { w: 48, h: 48 };
    const r = spriteRect(L, 40, 30, 48, 48, 32, 32);
    const rest = posedRect(L, e, 32, 32, 40, 30, REST);
    expect({ x: rest.x, y: rest.y, w: rest.w, h: rest.h }).toEqual({ x: r.x, y: r.y, w: r.w, h: r.h });
    const sq = posedRect(L, e, 32, 32, 40, 30, { ...REST, sx: 1.2, sy: 0.8 });
    expect(sq.y + sq.h).toBe(r.y + r.h);
    expect(Math.abs(sq.x + sq.w / 2 - (r.x + r.w / 2))).toBeLessThanOrEqual(1);
  });
});

describe('poses', () => {
  it('pop-in grows within the reaction window (when the Beast cannot be hit yet) and settles at 1', () => {
    expect(popScale(0)).toBeCloseTo(0.25);
    expect(popScale(REACTION_TICKS)).toBe(1);
    expect(popScale(REACTION_TICKS + 30)).toBe(1);
    let max = 0;
    for (let a = 0; a <= REACTION_TICKS; a += 0.25) max = Math.max(max, popScale(a));
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThan(1.15);
  });

  it('idle motion stays small enough not to leave the hitbox', () => {
    for (const type of [0, 1, 2]) {
      for (let age = 0; age < 400; age++) {
        for (const calm of [false, true]) {
          const p = idlePose(type, age, 0.37, calm);
          expect(Math.abs(p.dx)).toBeLessThanOrEqual(1.5);
          expect(Math.abs(p.dy)).toBeLessThanOrEqual(1.5);
          expect(p.sx).toBeGreaterThan(0.9);
          expect(p.sx).toBeLessThan(1.1);
          expect(p.sy).toBeGreaterThan(0.9);
          expect(p.sy).toBeLessThan(1.1);
        }
      }
    }
  });

  it('a hit flashes first, squashes, and springs back', () => {
    expect(hitPose(0).flash).toBe(true);
    expect(hitPose(60).flash).toBe(false);
    expect(hitPose(20).sx).toBeGreaterThan(1);
    expect(hitPose(20).sy).toBeLessThan(1);
    expect(hitPose(200)).toEqual({ sx: 1, sy: 1, flash: false });
    expect(hitPose(-Infinity)).toEqual({ sx: 1, sy: 1, flash: false });
  });

  it('a catch shrinks to nothing; a flee leaves the screen on its side and fades', () => {
    expect(catchPose(0).sy).toBeCloseTo(1);
    expect(catchPose(1).sy).toBe(0);
    expect(catchPose(0.5).flash).toBe(true);
    const right = fleePose(1, 1, 200);
    expect(right.dx).toBeCloseTo(200);
    expect(right.alpha).toBeCloseTo(0);
    expect(fleePose(1, -1, 200).dx).toBeCloseTo(-200);
    expect(fleePose(0.3, 1, 200).dy).toBeLessThan(0);
  });
});

describe('menu wander', () => {
  it('stays inside its field for every type, even when the Beast is as big as the field', () => {
    for (const type of [0, 1, 2]) {
      for (const [w, hh, fw, fh] of [[48, 48, 160, 90], [64, 56, 64, 56], [30, 48, 120, 68]]) {
        for (let t = 0; t < 2000; t += 7) {
          const p = wanderPos(type, t, w, hh, fw, fh, 0.41);
          expect(p.px).toBeGreaterThanOrEqual(0);
          expect(p.py).toBeGreaterThanOrEqual(0);
          expect(p.px).toBeLessThanOrEqual(Math.max(0, fw - w));
          expect(p.py).toBeLessThanOrEqual(Math.max(0, fh - hh));
          expect(Number.isInteger(p.px) && Number.isInteger(p.py)).toBe(true);
        }
      }
    }
  });
});

describe('silhouettes', () => {
  it('tells a painting from a cut-out sprite', () => {
    const aw = 8;
    const ah = 6;
    const clear = new Uint8ClampedArray(aw * ah * 4);
    const solid = new Uint8ClampedArray(aw * ah * 4).fill(255);
    expect(isOpaqueArt(clear, aw, ah)).toBe(false);
    expect(isOpaqueArt(solid, aw, ah)).toBe(true);
  });

  it('resamples the hitbox mask to the art grid with a 1 px margin; cut-outs keep stray art pixels, paintings are clipped', () => {
    const w = 4;
    const h = 4;
    const mask = new Uint8Array(w * h);
    mask[1 * w + 1] = mask[1 * w + 2] = mask[2 * w + 1] = mask[2 * w + 2] = 1; // a 2x2 body in a 4x4 box
    const aw = 8;
    const ah = 8;
    const rgba = new Uint8ClampedArray(aw * ah * 4);
    rgba[(0 * aw + 0) * 4 + 3] = 255; // a stray pixel in the corner
    const cut = silhouette(mask, w, h, rgba, aw, ah, false);
    const paint = silhouette(mask, w, h, rgba, aw, ah, true);
    const W = aw + 2;
    expect(cut.length).toBe(W * (ah + 2));
    expect(cut[1 * W + 1]).toBe(1); // stray kept on a cut-out
    expect(paint[1 * W + 1]).toBe(0); // clipped on a painting
    expect(paint[(1 + 3) * W + 1 + 3]).toBe(1); // the body
    expect(paint[0]).toBe(0); // margin stays empty
    const d = dilate1(paint, W, ah + 2);
    expect(d.reduce((a, b) => a + b, 0)).toBeGreaterThan(paint.reduce((a, b) => a + b, 0));
  });
});

describe('habitats', () => {
  const ids: ChannelId[] = ['snowfall', 'magic', 'hunter', 'brute', 'hackathon', 'king'];

  it('every habitat paints only its own palette, deterministically, at any size', () => {
    for (const id of ids) {
      for (const [c, r] of [[256, 144], [137, 77], [40, 23]]) {
        const a = habitatPixels(id, c, r);
        const b = habitatPixels(id, c, r);
        expect(a).toEqual(b);
        expect(a.length).toBe(c * r);
        const max = a.reduce((m, v) => Math.max(m, v), 0);
        expect(max).toBeLessThan(HABITATS[id].palette.length);
        // a pattern, not a flat fill
        expect(new Set(a).size).toBeGreaterThan(2);
      }
    }
  });

  it('is a pattern, not static noise: most pixels match the pixel beside them', () => {
    for (const id of ids) {
      const c = 256;
      const r = 144;
      const a = habitatPixels(id, c, r);
      let same = 0;
      for (let y = 0; y < r; y++) for (let x = 1; x < c; x++) if (a[y * c + x] === a[y * c + x - 1]) same++;
      expect(same / (r * (c - 1))).toBeGreaterThan(0.6);
    }
  });

  it('FEVER re-tones a palette to gold and keeps brightness order', () => {
    const lum = (hex: string) => {
      const v = parseInt(hex.slice(1), 16);
      return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
    };
    for (const id of ids) {
      const pal = HABITATS[id].palette;
      const gold = goldify(pal);
      expect(gold.length).toBe(pal.length);
      for (const c of gold) {
        const v = parseInt(c.slice(1), 16);
        const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
        expect(r).toBeGreaterThanOrEqual(g);
        expect(g).toBeGreaterThanOrEqual(b);
      }
      for (let i = 0; i < pal.length; i++) {
        for (let j = 0; j < pal.length; j++) {
          if (lum(pal[i]) + 12 < lum(pal[j])) expect(lum(gold[i])).toBeLessThanOrEqual(lum(gold[j]));
        }
      }
    }
  });
});
