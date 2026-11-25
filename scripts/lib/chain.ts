// Reads Beast definitions and genesis token metadata from the Beasts V3 contracts.

import { decodeByteArrayString, decodeDataUri, decodeShortString, toHex, u256Calldata } from './cairo.ts';
import type { Call, CachedRpc } from './rpc.ts';

export interface BeastDefinition {
  name: string;
  beastType: number;
  tier: number;
  minter: string;
  soundManager: string;
  speciesOwner: string;
  artProvider: string;
  statsSource: string;
  factoryProvider: boolean;
  artLocked: boolean;
  minterLocked: boolean;
}

export interface TokenAttribute {
  trait_type: string;
  value: string | number;
  display_type?: string;
}

export interface TokenMetadata {
  name: string;
  description: string;
  image: string;
  attributes: TokenAttribute[];
  animation_url?: string;
  [k: string]: unknown;
}

export interface RawBeast {
  speciesId: number;
  def: BeastDefinition;
  creator: string;
  owner: string;
  registryDescription: string;
  genesisTokenId: string;
  token: TokenMetadata;
}

export function parseDefinition(r: string[]): BeastDefinition {
  if (r.length < 11) throw new Error(`get_definition: expected 11 felts, got ${r.length}`);
  return {
    name: decodeShortString(r[0]),
    beastType: Number(BigInt(r[1])),
    tier: Number(BigInt(r[2])),
    minter: toHex(r[3]),
    soundManager: toHex(r[4]),
    speciesOwner: toHex(r[5]),
    artProvider: toHex(r[6]),
    statsSource: toHex(r[7]),
    factoryProvider: BigInt(r[8]) !== 0n,
    artLocked: BigInt(r[9]) !== 0n,
    minterLocked: BigInt(r[10]) !== 0n,
  };
}

export async function fetchBeasts(
  rpc: CachedRpc,
  registry: string,
  nft: string,
  speciesIds: number[],
): Promise<RawBeast[]> {
  const perSpecies = (sid: number): Call[] => {
    const a = [toHex(BigInt(sid))];
    return [
      { contract: registry, fn: 'get_definition', calldata: a },
      { contract: registry, fn: 'get_species_creator', calldata: a },
      { contract: registry, fn: 'get_species_owner', calldata: a },
      { contract: registry, fn: 'get_description', calldata: a },
      { contract: nft, fn: 'get_genesis_token_id', calldata: a },
    ];
  };
  const K = 5;
  console.log(`Fetching registry data for ${speciesIds.length} species...`);
  const res = await rpc.callMany(speciesIds.flatMap(perSpecies));

  const tokenIds = speciesIds.map((_, i) => toHex(res[i * K + 4][0]));
  console.log(`Fetching token_uri for ${speciesIds.length} genesis tokens...`);
  const uris = await rpc.callMany(
    tokenIds.map((t) => ({ contract: nft, fn: 'token_uri', calldata: u256Calldata(t) })),
    6,
  );

  return speciesIds.map((speciesId, i) => {
    const r = res.slice(i * K, i * K + K);
    if (BigInt(tokenIds[i]) === 0n) throw new Error(`species ${speciesId}: no genesis token`);
    const uri = decodeByteArrayString(uris[i]);
    const { bytes } = decodeDataUri(uri);
    const token = JSON.parse(bytes.toString('utf8')) as TokenMetadata;
    return {
      speciesId,
      def: parseDefinition(r[0]),
      creator: toHex(r[1][0]),
      owner: toHex(r[2][0]),
      registryDescription: decodeByteArrayString(r[3]),
      genesisTokenId: tokenIds[i],
      token,
    };
  });
}

export function attr(t: TokenMetadata, name: string): string | undefined {
  const a = t.attributes.find((x) => x.trait_type === name);
  return a === undefined ? undefined : String(a.value);
}

/** Extract the embedded art (a data:image/... URI) from the token's SVG image. */
export function extractArt(t: TokenMetadata): { mime: string; bytes: Buffer }[] {
  const { bytes: svgBytes, mime } = decodeDataUri(t.image);
  if (!mime.includes('svg')) return [decodeDataUri(t.image)];
  const svg = svgBytes.toString('utf8');
  const found: { mime: string; bytes: Buffer }[] = [];
  const re = /data:image\/(gif|png|webp|jpeg);base64,([A-Za-z0-9+/=]+)/g;
  for (let m = re.exec(svg); m; m = re.exec(svg)) {
    found.push({ mime: `image/${m[1]}`, bytes: Buffer.from(m[2], 'base64') });
  }
  return found;
}
