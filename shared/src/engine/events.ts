import type { Card } from '../cards';
import type { Combo } from './combos';

// 引擎事件数据（判别联合）；GameEvent = 数据 + seq（单调递增供客户端排序）
export type GameEventData =
  | { type: 'game:started'; leaderId: string }
  | { type: 'deal:done' }
  | { type: 'turn:started'; playerId: string }
  | { type: 'cards:played'; playerId: string; combo: Combo }
  | { type: 'table:attributed'; playerId: string; fromPlayerId: string; combo: Combo }
  | { type: 'table:side'; playerId: string; card: Card }
  | { type: 'passed'; playerId: string }
  | { type: 'round:ended'; lastPlayerId: string; drew: number; ledBy?: string }
  | { type: 'cards:drawn'; playerId: string; count: number }
  | { type: 'cards:revealed'; playerId: string; cards: Card[]; purpose: string }
  | { type: 'player:eliminated'; playerId: string; reason: string }
  | { type: 'skill:triggered'; playerId: string; roleId: string; skillId: string; text: string }
  | { type: 'skill:peek'; viewerId: string; targetId: string; cards: Card[] }
  | { type: 'skill:peeked'; viewerId: string; targetId: string }
  | { type: 'game:error'; playerId: string; reason: string }
  | { type: 'game:ended'; winnerId: string | null; scoreDeltas: Record<string, number>; totals: Record<string, number> };

export type GameEvent = GameEventData & { seq: number };
