// Balance probe for SPEC v2: simulated clickers with human-like reaction time and aim error,
// plus a blind spam-clicker (the "leave an AI running" case). npx tsx scripts/balance.ts
import { positionAt } from '../src/sim/motion.ts';
import { Run } from '../src/sim/replay.ts';
import type { SimRosterEntry } from '../src/sim/schedule.ts';
import { N_SPAWNS, type BeastType } from '../src/sim/spec.ts';

const roster: SimRosterEntry[] = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../public/data/roster.json', import.meta.url), 'utf8')).entries.map(
  (e: { type: BeastType; tier: number; health: number; aggr: number; w: number; h: number; occ: string }) => ({ type: e.type, tier: e.tier, health: e.health, aggr: e.aggr, w: e.w, h: e.h, occ: BigInt(e.occ) }),
);
const nF = 22;

function mulberry(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** delay: ticks to notice a Beast; aim: chance a click lands inside the silhouette; spam: blind random clicks. */
function play(seed: bigint, delay: number, aim: number, rng: () => number, spam = false) {
  const run = new Run(seed, roster, nF);
  const noticed = new Map<number, number>();
  for (let tick = 0; tick <= run.endTick; tick++) {
    run.advanceTo(tick);
    if (run.dead) break;
    if (!run.canStrike(tick)) continue;
    if (spam) { run.strike({ tick, x: Math.floor(rng() * 256), y: Math.floor(rng() * 144), type: 0 }); continue; }
    let target = -1;
    for (let i = 0; i < run.spawns.length; i++) {
      if (!run.isTargetable(i, tick)) continue;
      if (!noticed.has(i)) noticed.set(i, run.spawns[i].spawnTick + delay + Math.floor(rng() * delay));
      if (tick >= noticed.get(i)!) { target = i; break; }
    }
    if (target < 0) continue;
    const s = run.spawns[target];
    const { px, py } = positionAt(s, tick);
    const onTarget = rng() < aim;
    const x = onTarget ? px + Math.floor(s.entry.w * (0.3 + 0.4 * rng())) : px + (rng() < 0.5 ? -8 : s.entry.w + 8);
    const y = onTarget ? py + Math.floor(s.entry.h * (0.3 + 0.4 * rng())) : py + Math.floor(s.entry.h / 2);
    run.strike({ tick, x: Math.max(0, Math.min(255, x)), y: Math.max(0, Math.min(143, y)), type: 0 });
  }
  return run.finish();
}

const profiles: [string, number, number, boolean?][] = [
  ['oracle', 10, 1],
  ['pro', 20, 0.95],
  ['good', 32, 0.9],
  ['casual', 48, 0.82],
  ['first-timer', 66, 0.72],
  ['blind-spam', 0, 0, true],
];
for (const [name, delay, aim, spam] of profiles) {
  const rng = mulberry(4242);
  let score = 0, kills = 0, alive = 0, deathT = 0, deaths = 0, combo = 0;
  const N = 60;
  for (let k = 0; k < N; k++) {
    const r = play(BigInt(5000 + k), delay, aim, rng, spam);
    score += r.score; kills += r.kills; combo += r.bestCombo;
    if (r.dead) { deaths++; deathT += r.deathTick; } else alive++;
  }
  console.log(`${name.padEnd(12)} score ${String(Math.round(score / N)).padStart(6)}  kills ${(kills / N).toFixed(1).padStart(4)}/${N_SPAWNS}  best combo ${(combo / N).toFixed(0).padStart(3)}  survive ${String(Math.round((alive / N) * 100)).padStart(3)}%  death ${deaths ? (deathT / deaths / 60).toFixed(1) + 's' : '-'}`);
}
