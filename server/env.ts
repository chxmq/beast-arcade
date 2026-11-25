// Server configuration from environment variables. Secrets are never logged or returned.
//
//   STATIC_CONTRACT    StaticGame address (unset: no chain; see BROADCAST_OFFCHAIN)
//   RELAYER_ADDRESS    relayer account (allowed via set_relayer), sends post_tape_root / submit_broadcast
//   RELAYER_PK         relayer account private key
//   BROADCAST_SECRET   hex felt < 2^251: the tape seed secret (seed = poseidon([secret, day, k])) and ticket MAC key
//   RPC_URL            Starknet JSON-RPC (default: zan.top public Sepolia, spec 0.10)
//   TAPES_PER_DAY      leaves per daily root (default 4096)
//   CRON_SECRET        bearer token for /api/cron/post-root (Vercel cron sends it automatically)
//   BROADCAST_OFFCHAIN "1": no contract, local test mode (the Vite dev server sets it when STATIC_CONTRACT is unset)

export const DEFAULT_RPC_URL = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';

/** Fixed seed secret of the local offchain test mode only (never used with a contract). */
const DEV_SECRET = 0x5354415449432d444556n; // 'STATIC-DEV'

export interface ServerEnv {
  mode: 'chain' | 'offchain' | 'off';
  /** Why mode is 'off'. */
  reason?: string;
  contract: string | null;
  relayerAddress: string | null;
  relayerPk: string | null;
  secret: bigint | null;
  rpcUrl: string;
  tapesPerDay: number;
  cronSecret: string | null;
}

const str = (k: string): string | null => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : null;
};

const isAddress = (v: string | null): v is string => !!v && /^0x[0-9a-fA-F]{1,64}$/.test(v);

function parseSecret(v: string | null): bigint | null {
  if (!v || !/^0x[0-9a-fA-F]{1,63}$/.test(v)) return null;
  const x = BigInt(v);
  return x > 0n && x < 2n ** 251n ? x : null;
}

let cached: { key: string; env: ServerEnv } | null = null;

export function readEnv(): ServerEnv {
  const keys = ['STATIC_CONTRACT', 'RELAYER_ADDRESS', 'RELAYER_PK', 'BROADCAST_SECRET', 'RPC_URL', 'TAPES_PER_DAY', 'CRON_SECRET', 'BROADCAST_OFFCHAIN'];
  const key = keys.map((k) => process.env[k] ?? '').join('\u0000');
  if (cached && cached.key === key) return cached.env;

  const contract = str('STATIC_CONTRACT');
  const secret = parseSecret(str('BROADCAST_SECRET'));
  const n = Number(str('TAPES_PER_DAY') ?? 4096);
  const env: ServerEnv = {
    mode: 'off',
    contract: isAddress(contract) ? contract : null,
    relayerAddress: isAddress(str('RELAYER_ADDRESS')) ? str('RELAYER_ADDRESS') : null,
    relayerPk: str('RELAYER_PK'),
    secret,
    rpcUrl: str('RPC_URL') ?? DEFAULT_RPC_URL,
    tapesPerDay: Number.isInteger(n) && n >= 1 && n <= 16384 ? n : 4096,
    cronSecret: str('CRON_SECRET'),
  };
  if (env.contract) {
    if (!secret) env.reason = 'BROADCAST_SECRET missing or invalid';
    else if (!env.relayerAddress || !env.relayerPk) env.reason = 'relayer not configured';
    else env.mode = 'chain';
  } else if (str('BROADCAST_OFFCHAIN') === '1') {
    env.mode = 'offchain';
    env.secret = secret ?? DEV_SECRET;
  } else {
    env.reason = contract ? 'STATIC_CONTRACT invalid' : 'no contract configured';
  }
  if (env.reason && env.contract) console.warn(`[broadcast] off air: ${env.reason}`);
  cached = { key, env };
  return env;
}
