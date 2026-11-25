// Posts today's tape root (same code path as the Vercel cron), from a terminal.
// Loads server env from the shell and .env / .env.local (values are never printed).
//   npm run post-root               post it (sends post_tape_root from the relayer)
//   npm run post-root -- --dry-run  compute the root and fee-estimate the signed tx; sends nothing
import { loadEnv } from 'vite';

const fileEnv = loadEnv('development', process.cwd(), '');
for (const [k, v] of Object.entries(fileEnv)) if (process.env[k] === undefined) process.env[k] = v;

if (process.argv.includes('--dry-run')) {
  const { readEnv } = await import('../server/env.ts');
  const { chainFor } = await import('../server/chain.ts');
  const { expiresAtFor, treeFor, utcDay } = await import('../server/seeds.ts');
  const env = readEnv();
  if (env.mode !== 'chain') throw new Error(`not configured for chain: ${env.reason}`);
  const chain = chainFor(env);
  const day = utcDay();
  const latest = await chain.latestRoot();
  const tree = await treeFor(env.secret!, day, env.tapesPerDay);
  const est = await chain.estimate('post_tape_root', [tree.root, BigInt(env.tapesPerDay), BigInt(expiresAtFor(day))]);
  console.log(JSON.stringify({ dryRun: true, day, n: env.tapesPerDay, root: '0x' + tree.root.toString(16), latestRootId: latest.rootId, estimate: est }, null, 2));
} else {
  if (!process.env.CRON_SECRET) throw new Error('CRON_SECRET is not set');
  const { postRoot } = await import('../server/handlers.ts');
  const res = await postRoot(new Request('http://localhost/api/cron/post-root', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }));
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
}
