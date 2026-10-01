import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import elmYao from './elm-yao';
import type { RoleDef, RoleRegistry } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);

function mkEngine(hands: Record<string, Card[]>, roles: Record<string, RoleDef>, startPlayerId = 'p0') {
  const players: EnginePlayer[] = Object.keys(hands).map((id, i) => ({
    id,
    name: `玩家${i}`,
    roleId: roles[id]?.id ?? '',
  }));
  const registry: RoleRegistry = new Map(Object.values(roles).map((r) => [r.id, r]));
  const engine = new GameEngine(defaultRules, players, {
    rng: mulberry32(1),
    startPlayerId,
    roles: registry,
    handsOverride: hands,
  });
  engine.start();
  return engine;
}

describe('第二席 圣母（斜视）', () => {
  it('相差 1（含更低方向）：对4 接对5', () => {
    const hands = {
      p0: [byRank(5, 2)[0]!, byRank(5, 2)[1]!, ...byRank(10, 3)],
      p1: [byRank(4, 2)[0]!, byRank(4, 2)[1]!, ...byRank(9, 3)],
    };
    const engine = mkEngine(hands, { p1: elmYao });
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]).ok).toBe(true); // 对5
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 对4 接对5
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'xie-shi')).toBe(true);
    expect(engine.snapshotFor('p0').table!.rank).toBe(4);
  });

  it('相差 0：对5 接对5', () => {
    const hands = {
      p0: [byRank(5, 2)[0]!, byRank(5, 2)[1]!, ...byRank(10, 3)],
      p1: [deck.filter((c) => c.rank === 5)[2]!, deck.filter((c) => c.rank === 5)[3]!, ...byRank(9, 3)],
    };
    const engine = mkEngine(hands, { p1: elmYao });
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]).ok).toBe(true);
  });

  it('相差 2 及以上不发动：对7 接对5 被拒绝', () => {
    const hands = {
      p0: [byRank(5, 2)[0]!, byRank(5, 2)[1]!, ...byRank(10, 3)],
      p1: [byRank(7, 2)[0]!, byRank(7, 2)[1]!, ...byRank(9, 3)],
    };
    const engine = mkEngine(hands, { p1: elmYao });
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r.ok).toBe(false);
  });

  it('顺子：起点差 1 可接（345 接 456）', () => {
    const hands = {
      p0: [byRank(4, 1)[0]!, byRank(5, 1)[0]!, byRank(6, 1)[0]!, ...byRank(10, 2)],
      p1: [byRank(3, 1)[0]!, deck.filter((c) => c.rank === 4)[1]!, deck.filter((c) => c.rank === 5)[1]!, ...byRank(9, 2)],
    };
    const engine = mkEngine(hands, { p1: elmYao });
    expect(engine.playCards('p0', hands.p0.slice(0, 3).map((c) => c.id)).ok).toBe(true); // 456
    const r = engine.playCards('p1', hands.p1.slice(0, 3).map((c) => c.id)); // 345 接 456
    expect(r.ok).toBe(true);
  });

  it('炸弹：同张数点数差 1 可接（3×5 接 3×6）', () => {
    const hands = {
      p0: [byRank(6, 3)[0]!, byRank(6, 3)[1]!, byRank(6, 3)[2]!, ...byRank(10, 2)],
      p1: [byRank(5, 3)[0]!, byRank(5, 3)[1]!, byRank(5, 3)[2]!, ...byRank(9, 2)],
    };
    const engine = mkEngine(hands, { p1: elmYao });
    expect(engine.playCards('p0', hands.p0.slice(0, 3).map((c) => c.id)).ok).toBe(true); // 3×6
    const r = engine.playCards('p1', hands.p1.slice(0, 3).map((c) => c.id)); // 3×5 接 3×6
    expect(r.ok).toBe(true);
  });

  it('不同张数炸弹不发动：3×8 接 4×5 被拒绝', () => {
    const hands = {
      p0: [byRank(5, 4)[0]!, byRank(5, 4)[1]!, byRank(5, 4)[2]!, byRank(5, 4)[3]!, ...byRank(10, 1)],
      p1: [byRank(8, 3)[0]!, byRank(8, 3)[1]!, byRank(8, 3)[2]!, ...byRank(9, 2)],
    };
    const engine = mkEngine(hands, { p1: elmYao });
    expect(engine.playCards('p0', hands.p0.slice(0, 4).map((c) => c.id)).ok).toBe(true); // 4×5
    const r = engine.playCards('p1', hands.p1.slice(0, 3).map((c) => c.id)); // 3×8
    expect(r.ok).toBe(false);
  });
});
