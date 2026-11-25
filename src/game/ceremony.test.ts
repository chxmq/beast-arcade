import { describe, expect, it } from 'vitest';
import { alertFor, beatTime, catchKind, catchLabel, encounterLine, planCatch, poseAt, tierColor } from './ceremony.ts';

describe('catch kind', () => {
  it('ranks king over shiny over rare', () => {
    expect(catchKind({ boss: true, shiny: true, featured: true })).toBe('king');
    expect(catchKind({ boss: false, shiny: true, featured: true })).toBe('shiny');
    expect(catchKind({ boss: false, shiny: false, featured: true })).toBe('rare');
    expect(catchKind({ boss: false, shiny: false, featured: false })).toBe('common');
  });
});

describe('catch plan and pose', () => {
  it('a plain catch has no wobble and is quick', () => {
    const p = planCatch('common');
    expect(p.wobbles).toBe(0);
    expect(p.flipAt).toBe(p.wobbleAt);
    expect(p.total).toBeLessThan(1100);
  });
  it('rare, shiny and king wobble three times before the flip', () => {
    for (const k of ['rare', 'shiny', 'king'] as const) {
      const p = planCatch(k);
      expect(p.wobbles).toBe(3);
      expect(p.flipAt - p.wobbleAt).toBe(3 * p.beatMs);
      expect(beatTime(p, 2) - beatTime(p, 0)).toBe(2 * p.beatMs);
      expect(p.total).toBeLessThan(2400);
    }
  });
  it('walks the phases in order and ends in the tray', () => {
    const p = planCatch('shiny');
    const phases: string[] = [];
    for (let t = 0; t <= p.total + 50; t += 5) {
      const ph = poseAt(p, t).phase;
      if (phases[phases.length - 1] !== ph) phases.push(ph);
    }
    expect(phases).toEqual(['implode', 'wobble', 'flip', 'hold', 'fly', 'done']);
    expect(poseAt(p, p.total + 1)).toMatchObject({ phase: 'done', fly: 1, face: 'front' });
  });
  it('shows the back until the middle of the flip, squashes to zero there, then the front', () => {
    const p = planCatch('rare');
    expect(poseAt(p, p.flipAt - 1).face).toBe('back');
    expect(poseAt(p, p.flipAt + p.flipMs * 0.25).face).toBe('back');
    expect(poseAt(p, p.flipAt + p.flipMs * 0.5).scaleX).toBeLessThan(0.05);
    expect(poseAt(p, p.flipAt + p.flipMs * 0.75).face).toBe('front');
    expect(poseAt(p, p.holdAt + 1).scaleX).toBe(1);
  });
  it('wobble tilts inside a beat and rests between ticks, beat index counts 0..2', () => {
    const p = planCatch('king');
    const beats = new Set<number>();
    let tilted = false;
    let rested = false;
    for (let t = p.wobbleAt; t < p.flipAt; t += 3) {
      const o = poseAt(p, t);
      beats.add(o.beat);
      if (Math.abs(o.angle) > 0.05) tilted = true;
      if (o.angle === 0) rested = true;
      expect(Math.abs(o.angle)).toBeLessThanOrEqual(0.33);
    }
    expect([...beats]).toEqual([0, 1, 2]);
    expect(tilted && rested).toBe(true);
    expect(poseAt(p, 10).angle).toBe(0);
  });
  it('flight only moves forward', () => {
    const p = planCatch('common');
    let last = -1;
    for (let t = 0; t <= p.total; t += 10) {
      const f = poseAt(p, t).fly;
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });
});

describe('encounter text', () => {
  it('names the species', () => {
    expect(encounterLine('Kurama')).toBe('A wild KURAMA appeared!');
    expect(encounterLine('Stone beast')).toBe('A wild STONE BEAST appeared!');
  });
  it('alerts only for rare, shiny and king, never with coordinates', () => {
    expect(alertFor('common', 'Magic', 1)).toBeNull();
    expect(alertFor('rare', 'Hunter', 2)).toMatchObject({ text: 'RARE BEAST', sub: 'Hunter . 2 taps . leaves sooner', cls: 'rare' });
    expect(alertFor('shiny', 'Brute', 1)).toMatchObject({ text: 'SHINY!', sub: 'Brute . 1 tap . pays triple', cls: 'shiny' });
    expect(alertFor('king', 'Brute', 8)).toMatchObject({ text: 'THE KING', cls: 'king' });
    for (const k of ['rare', 'shiny', 'king'] as const) {
      const a = alertFor(k, 'Magic', 2)!;
      expect(`${a.text} ${a.sub}`).not.toMatch(/left|right|top|bottom|x=|y=|\d+,\s*\d+/i);
    }
  });
  it('labels', () => {
    expect(catchLabel(false, false, false, '#012')).toBe('CAUGHT!');
    expect(catchLabel(true, false, false, '#012')).toBe('NEW ENTRY #012');
    expect(catchLabel(false, true, false, '#012')).toBe('SHINY!');
    expect(catchLabel(true, true, false, '#012')).toBe('SHINY! NEW #012');
    expect(catchLabel(true, false, true, '#098')).toBe('KING CAUGHT! NEW #098');
  });
  it('tier colours cover 1..5 and clamp', () => {
    expect(new Set([1, 2, 3, 4, 5].map(tierColor)).size).toBe(5);
    expect(tierColor(0)).toBe(tierColor(1));
    expect(tierColor(9)).toBe(tierColor(5));
  });
});
