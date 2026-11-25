import { assetUrl, decodeMask, type Roster, type RosterEntry } from '../data/roster.ts';
import type { RenderBeast } from '../render/field.ts';
import { shortAddr } from '../ui/dom.ts';
import { PREFIXES, SUFFIXES, TYPE_NAMES } from '../sim/spec.ts';
import { tierClarity } from './visual.ts';

const masks = new Map<number, Uint8Array>();
const arts = new Map<number, HTMLImageElement>();

export function maskOf(e: RosterEntry): Uint8Array {
  let m = masks.get(e.speciesId);
  if (!m) {
    m = decodeMask(e);
    masks.set(e.speciesId, m);
  }
  return m;
}

/** Motion persistence of a tier, the same table the hunt uses (src/game/visual.ts). */
export function persistOf(tier: number, faint = false): number {
  return tierClarity(tier, faint);
}

/** 0..1 signal strength for audio and UI (T1 faintest). */
export function strengthOf(tier: number): number {
  return (Math.max(1, Math.min(5, tier)) - 1) / 4;
}

export function artOf(e: RosterEntry): HTMLImageElement {
  let img = arts.get(e.speciesId);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = assetUrl(e.art);
    arts.set(e.speciesId, img);
  }
  return img;
}

export type ArtMode = 'art' | 'shiny' | 'silhouette';

/** Shiny look: the art re-toned to gold, keeping a little of its own colour. */
export function shinyPixels(d: Uint8ClampedArray) {
  for (let i = 0; i < d.length; i += 4) {
    const l = (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255;
    const k = Math.min(1, l * 1.25 + 0.08);
    d[i] = Math.min(255, 255 * k * 0.78 + d[i] * 0.22);
    d[i + 1] = Math.min(255, 205 * k * 0.78 + d[i + 1] * 0.22);
    d[i + 2] = Math.min(255, 70 * k * 0.78 + d[i + 2] * 0.22);
  }
}

function silhouettePixels(d: Uint8ClampedArray) {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 52;
    d[i + 1] = 50;
    d[i + 2] = 45;
    d[i + 3] = d[i + 3] > 24 ? 255 : 0;
  }
}

const modeCache = new Map<string, HTMLCanvasElement>();

/**
 * The art cropped to its box, as a canvas at native resolution (scale it with CSS, pixelated).
 * `shiny` re-tones it to gold, `silhouette` flattens it to a dim grey outline shape.
 */
export function artCrop(e: RosterEntry, mode: ArtMode = 'art'): HTMLCanvasElement {
  const [ax, ay, aw, ah] = e.artBox;
  const c = document.createElement('canvas');
  c.width = Math.max(1, aw);
  c.height = Math.max(1, ah);
  const img = artOf(e);
  const paint = () => {
    const g = c.getContext('2d');
    if (!g) return;
    g.drawImage(img, ax, ay, aw, ah, 0, 0, aw, ah);
    if (mode === 'art') return;
    try {
      const id = g.getImageData(0, 0, c.width, c.height);
      (mode === 'shiny' ? shinyPixels : silhouettePixels)(id.data);
      g.putImageData(id, 0, 0);
    } catch {
      /* tainted canvas: leave the plain art */
    }
  };
  if (img.complete && img.naturalWidth) paint();
  else img.addEventListener('load', paint, { once: true });
  return c;
}

/** A shared, already-toned canvas for drawing into other canvases (cards). Null until the art has loaded. */
export function artSource(e: RosterEntry, mode: ArtMode = 'art'): CanvasImageSource | null {
  const img = artOf(e);
  if (!img.complete || !img.naturalWidth) return null;
  if (mode === 'art') return img;
  const key = `${e.speciesId}:${mode}`;
  let c = modeCache.get(key);
  if (!c) {
    c = artCrop(e, mode);
    modeCache.set(key, c);
  }
  return c;
}

/** Source rect to draw `artSource(e, mode)` with: the whole canvas for toned art, the crop box for the raw image. */
export function artRect(e: RosterEntry, mode: ArtMode): [number, number, number, number] {
  return mode === 'art' ? e.artBox : [0, 0, Math.max(1, e.artBox[2]), Math.max(1, e.artBox[3])];
}

export function preloadArt(roster: Roster, featuredOnly = false) {
  for (const e of roster.entries) if (!featuredOnly || e.featured) artOf(e);
}

export function beastName(e: RosterEntry, prefix = 0, suffix = 0): string {
  const affix = prefix && suffix ? `${PREFIXES[prefix]} ${SUFFIXES[suffix]} ` : '';
  return `${affix}${e.name}`;
}

export function typeName(t: number): string {
  return TYPE_NAMES[t] ?? '?';
}

/** Motion word the player learns to read (chains are named after it). */
export const MOTION = ['SWIRL', 'STREAK', 'SLAM'] as const;

/** Displayed level (SPEC section 5: lvl * 4). */
export function displayLevel(lvl: number): number {
  return lvl * 4;
}

/** A Beast drifting slowly around a field, used for ambient screens (guide, primer, AI test). */
export class Drifter {
  x: number;
  y: number;
  private vx: number;
  private vy: number;
  t = 0;
  private static nextId = 1000;
  readonly id = Drifter.nextId++;
  constructor(public e: RosterEntry, private fw: number, private fh: number, public type: 0 | 1 | 2 = e.type as 0 | 1 | 2, public persist = persistOf(e.tier), speed = 0.35) {
    this.x = Math.random() * Math.max(1, fw - e.w);
    this.y = Math.random() * Math.max(1, fh - e.h);
    // Same movement language as the hunt: Magic floats diagonally, Hunter darts sideways, Brute lumbers.
    const sx = Math.random() < 0.5 ? -1 : 1;
    const sy = Math.random() < 0.5 ? -1 : 1;
    if (type === 0) { this.vx = sx * speed * 0.8; this.vy = sy * speed * 0.8; }
    else if (type === 1) { this.vx = sx * speed * 1.9; this.vy = sy * speed * 0.15; }
    else { this.vx = sx * speed * 0.55; this.vy = sy * speed * 0.3; }
  }
  step(): RenderBeast {
    this.t++;
    this.x += this.vx;
    this.y += this.vy;
    const maxX = this.fw - this.e.w;
    const maxY = this.fh - this.e.h;
    if (this.x < 0 || this.x > maxX) { this.vx = -this.vx; this.x = Math.max(0, Math.min(maxX, this.x)); }
    if (this.y < 0 || this.y > maxY) { this.vy = -this.vy; this.y = Math.max(0, Math.min(maxY, this.y)); }
    return { id: this.id, px: Math.floor(this.x), py: Math.floor(this.y), w: this.e.w, h: this.e.h, mask: maskOf(this.e), type: this.type, persist: this.persist, t: this.t };
  }
}

export function featured(roster: Roster): RosterEntry[] {
  return roster.entries.filter((e) => e.featured && !e.maskWarning);
}

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Artist credit: Art Hackathon creator address, or Loot Survivor for the originals. */
export function artistOf(e: RosterEntry): string {
  if (!e.featured || !e.creator || /^0x0*$/.test(e.creator)) return 'Loot Survivor';
  return shortAddr(e.creator);
}
