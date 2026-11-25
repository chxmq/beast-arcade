// Constants from SPEC.md. Changing anything here means regenerating the Cairo parity vectors.

export const FIELD_W = 256;
export const FIELD_H = 144;
export const TPS = 60;
export const N_SPAWNS = 40;
export const MAX_TICK = 4000;
export const MAX_STRIKES = 400;
/** Min ticks after a strike that hit (or overkilled), and after a miss. */
export const GAP_HIT = 6;
export const GAP_MISS = 18;
/** Kept for older callers: the strictest gap. */
export const MIN_STRIKE_GAP = GAP_MISS;
export const REACTION_TICKS = 8;
export const PLAYER_LIVES = 5;
export const JAM_MISSES = 3;
export const FEATURED_PCT = 45;

export const T_TICK = 1n;
export const T_SPECIES = 2n;
export const T_POS_X = 3n;
export const T_POS_Y = 4n;
export const T_VEL = 5n;
export const T_LIFE = 6n;
export const T_AFFIX = 7n;
export const T_SHINY = 8n;
/** 1 in SHINY_ONE_IN Beasts is shiny. */
export const SHINY_ONE_IN = 12n;
/** caught_mask / shiny_mask are u128: at most this many roster entries. */
export const MAX_ROSTER = 128;

export const MAGIC = 0;
export const HUNTER = 1;
export const BRUTE = 2;
export type BeastType = 0 | 1 | 2;
export const TYPE_NAMES = ['Magic', 'Hunter', 'Brute'] as const;

export const NO_INDEX = 255;
export const MISS_INDEX = 63;
export const OVERKILL_INDEX = 62;
export const NO_TYPE = 3;

export const EV_STRIKE = 1;
export const EV_ESCAPE = 2;
export const EV_KILL = 3;
export const EV_JAM = 4;

// 1-indexed (index 0 = none), Loot Survivor vocabulary.
export const PREFIXES = [
  '',
  'Agony', 'Apocalypse', 'Armageddon', 'Beast', 'Behemoth', 'Blight', 'Blood', 'Bramble', 'Brimstone', 'Brood',
  'Carrion', 'Cataclysm', 'Chimeric', 'Corpse', 'Corruption', 'Damnation', 'Death', 'Demon', 'Dire', 'Dragon',
  'Dread', 'Doom', 'Dusk', 'Eagle', 'Empyrean', 'Fate', 'Foe', 'Gale', 'Ghoul', 'Gloom',
  'Glyph', 'Golem', 'Grim', 'Hate', 'Havoc', 'Honour', 'Horror', 'Hypnotic', 'Kraken', 'Loath',
  'Maelstrom', 'Mind', 'Miracle', 'Morbid', 'Oblivion', 'Onslaught', 'Pain', 'Pandemonium', 'Phoenix', 'Plague',
  'Rage', 'Rapture', 'Rune', 'Skull', 'Sol', 'Soul', 'Sorrow', 'Spirit', 'Storm', 'Tempest',
  'Torment', 'Vengeance', 'Victory', 'Viper', 'Vortex', 'Woe', 'Wrath', "Light's", 'Shimmering',
] as const;

export const SUFFIXES = [
  '',
  'Bane', 'Root', 'Bite', 'Song', 'Roar', 'Grasp', 'Instrument', 'Glow', 'Bender', 'Shadow',
  'Whisper', 'Shout', 'Growl', 'Tear', 'Peak', 'Form', 'Sun', 'Moon',
] as const;

export const PREFIX_GALE = 28;
export const PREFIX_STORM = 59;
export const PREFIX_TEMPEST = 60;
export const PREFIX_DUSK = 23;
export const PREFIX_GLOOM = 30;
export const PREFIX_VORTEX = 65;
export const PREFIX_SHIMMERING = 69;
export const SUFFIX_BANE = 1;
export const SUFFIX_SHADOW = 10;
export const SUFFIX_WHISPER = 11;
export const SUFFIX_SHOUT = 12;
export const SUFFIX_PEAK = 15;

/** Renderer persistence by tier (SPEC §12). */
export const PERSIST_BY_TIER = [0, 0.7, 0.76, 0.82, 0.88, 0.93] as const;
export const FAINT_PENALTY = 0.08;
