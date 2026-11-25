// Microgame factory: one class per game, dealt by the engine.
import type { GameCtx, GameId, Microgame } from '../types.ts';
import { BossGame } from './boss.ts';
import { CatchGame } from './catch.ts';
import { CounterGame } from './counter.ts';
import { DodgeGame } from './dodge.ts';
import { DuelGame } from './duel.ts';
import { EyesGame } from './eyes.ts';
import { FeedGame } from './feed.ts';
import { MashGame } from './mash.ts';
import { ShinyGame } from './shiny.ts';

export function createGame(id: GameId, ctx: GameCtx): Microgame {
  switch (id) {
    case 'catch': return new CatchGame(ctx);
    case 'counter': return new CounterGame(ctx);
    case 'duel': return new DuelGame(ctx);
    case 'shiny': return new ShinyGame(ctx);
    case 'eyes': return new EyesGame(ctx);
    case 'dodge': return new DodgeGame(ctx);
    case 'mash': return new MashGame(ctx);
    case 'feed': return new FeedGame(ctx);
    case 'boss': return new BossGame(ctx);
  }
}

export { BossGame, CatchGame, CounterGame, DodgeGame, DuelGame, EyesGame, FeedGame, MashGame, ShinyGame };
