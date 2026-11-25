import type { IncomingMessage } from 'node:http';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Dev only: serves /api/* with the same Web handlers Vercel runs (server/handlers.ts), loaded
 * through Vite's SSR loader so edits apply without a restart. Server env vars come from the
 * shell and from .env / .env.local (all keys, server-side only; set STATIC_SKIP_ENV_FILES=1 to
 * ignore the files). Without STATIC_CONTRACT the API runs in offchain test mode.
 */
function broadcastApi(): Plugin {
  return {
    name: 'static-broadcast-api',
    apply: 'serve',
    configureServer(server) {
      if (process.env.VITEST) return;
      if (process.env.STATIC_SKIP_ENV_FILES !== '1') {
        const fileEnv = loadEnv(server.config.mode, server.config.root, '');
        for (const [k, v] of Object.entries(fileEnv)) if (process.env[k] === undefined) process.env[k] = v;
      }
      if (!process.env.STATIC_CONTRACT && process.env.BROADCAST_OFFCHAIN === undefined) process.env.BROADCAST_OFFCHAIN = '1';

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        try {
          const mod = (await server.ssrLoadModule('/server/handlers.ts')) as typeof import('./server/handlers.ts');
          const response = await mod.route(await toRequest(req));
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          if (e instanceof Error) server.ssrFixStacktrace(e);
          console.error(e);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'dev api error' }));
        }
      });
    },
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method, headers, body });
}

export default defineConfig({
  plugins: [broadcastApi()],
  // vitest: the sim/merkle/render suites are CPU-heavy; do not flake on a busy machine.
  test: { testTimeout: 30000 },
} as Parameters<typeof defineConfig>[0]);
