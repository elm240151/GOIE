import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry } from './types';
import skywalker from './skywalker';

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

describe('首席 杰杰一世（蛋神/仁德）', () => {
  it('蛋神：Q 压任何单牌（含 K），播报技能', () => {
    const hands = {
      p0: [byRank(13, 1)[0]!, ...byRank(10, 4)], // 起单K
      p1: [byRank(12, 1)[0]!, ...byRank(8, 4)], // 单Q
    };
    const engine = mkEngine(hands, { p1: skywalker });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // Q 压 K（基础规则非法）
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'dan-shen')).toBe(true);
    expect(engine.snapshotFor('p0').table!.rank).toBe(12);
  });

  it('蛋神：Q 压不了单 2（2 只有炸弹能压）', () => {
    const hands = {
      p0: [byRank(15, 1)[0]!, ...byRank(10, 4)],
      p1: [byRank(12, 1)[0]!, ...byRank(8, 4)],
    };
    const engine = mkEngine(hands, { p1: skywalker });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('炸弹');
  });

  it('仁德：单 3 可以压单 2', () => {
    const hands = {
      p0: [byRank(15, 1)[0]!, ...byRank(10, 4)], // 首席出单2
      p1: [byRank(3, 1)[0]!, ...byRank(8, 4)],
    };
    const engine = mkEngine(hands, { p0: skywalker });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // 单3 压单2
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'ren-de')).toBe(true);
    expect(engine.snapshotFor('p0').table!.rank).toBe(3);
  });

  it('仁德：最后一张手牌不可为 Q（响应时否决 + 死锁守卫自动过）', () => {
    const hands = {
      p0: [byRank(12, 1)[0]!, byRank(5, 1)[0]!], // Q + 5
      p1: [byRank(6, 1)[0]!, ...byRank(13, 4)],
    };
    const engine = mkEngine(hands, { p0: skywalker });
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true); // p0 起单5
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true); // p1 接单6
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 最后一张 Q（蛋神本可压，仁德否决）
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('仁德');
    // 死锁守卫：开局只剩 Q 的首席 → 自动过，下家起牌
    const hands2 = { p0: [byRank(12, 1)[0]!], p1: byRank(8, 5) };
    const e2 = mkEngine(hands2, { p0: skywalker });
    const snap = e2.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p1');
    expect(snap.table).toBeNull();
  });
});
