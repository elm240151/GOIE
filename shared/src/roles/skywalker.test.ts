import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry } from './types';
import fishy from './fishy';
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

  it('蛋神：单 Q 可以压单 2（压一切，含 2——2026-10-07 用户澄清）', () => {
    const hands = {
      p0: [byRank(15, 1)[0]!, ...byRank(10, 4)],
      p1: [byRank(12, 1)[0]!, ...byRank(8, 4)],
    };
    const engine = mkEngine(hands, { p1: skywalker });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'dan-shen')).toBe(true);
    expect(engine.snapshotFor('p0').table!.rank).toBe(12);
  });

  it('蛋神：对 Q 可以压对 2（对 Q 压一切对子——2026-10-07 用户澄清）', () => {
    const hands = {
      p0: [...byRank(15, 2), ...byRank(10, 3)],
      p1: [...byRank(12, 2), ...byRank(8, 3)], // 对Q + 余牌（非收尾，避开仁德禁收尾）
    };
    const engine = mkEngine(hands, { p1: skywalker });
    expect(engine.playCards('p0', hands.p0.slice(0, 2).map((c) => c.id)).ok).toBe(true);
    const r = engine.playCards('p1', hands.p1.slice(0, 2).map((c) => c.id));
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'dan-shen')).toBe(true);
    expect(engine.snapshotFor('p0').table!.rank).toBe(12);
  });

  it('蛋神：倒序下单 Q 压单 3，压完后照常被 J 压（2026-10-07 用户澄清）', () => {
    const hands = {
      p0: [byRank(5, 1)[0]!, byRank(11, 1)[0]!, ...byRank(8, 3)], // 海棠：先起 5 切倒序，再出 J 压 Q
      p1: [byRank(3, 1)[0]!, ...byRank(9, 4)], // 倒序 3 压一切
      p2: [byRank(12, 1)[0]!, ...byRank(7, 4)], // 杰杰：单Q 压 3
    };
    const engine = mkEngine(hands, { p0: fishy, p2: skywalker });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 海棠起 5 → 倒序
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true); // 倒序 3 压一切
    const r = engine.playCards('p2', [hands.p2[0]!.id]); // 单Q 压 3（蛋神）
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'dan-shen')).toBe(true);
    const rj = engine.playCards('p0', [hands.p0[1]!.id]); // 倒序 J 照常压 Q
    expect(rj.ok).toBe(true);
  });

  it('蛋神：倒序下对 Q 压对 3（对 Q 压一切对子，倒序镜像）', () => {
    const hands = {
      p0: [...byRank(5, 2), ...byRank(8, 3)], // 海棠：起对 5 切倒序
      p1: [...byRank(3, 2), ...byRank(9, 3)], // 倒序对 3 压一切对子
      p2: [...byRank(12, 2), ...byRank(7, 3)], // 杰杰：对Q 压对 3
    };
    const engine = mkEngine(hands, { p0: fishy, p2: skywalker });
    expect(engine.playCards('p0', hands.p0.slice(0, 2).map((c) => c.id)).ok).toBe(true);
    expect(engine.playCards('p1', hands.p1.slice(0, 2).map((c) => c.id)).ok).toBe(true);
    const r = engine.playCards('p2', hands.p2.slice(0, 2).map((c) => c.id));
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'dan-shen')).toBe(true);
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

  it('仁德：最后一张不可为 Q 只禁单 Q/对 Q——含 Q 的顺子、炸弹收尾照常可打出（2026-10-07 用户澄清）', () => {
    // 含 Q 的顺子 10JQKA 收尾 → 可打出并获胜
    const hands = {
      p0: [byRank(10, 1)[0]!, byRank(11, 1)[0]!, byRank(12, 1)[0]!, byRank(13, 1)[0]!, byRank(14, 1)[0]!],
      p1: byRank(8, 5),
    };
    const engine = mkEngine(hands, { p0: skywalker });
    const r = engine.playCards('p0', hands.p0.map((c) => c.id));
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');

    // 对 Q 收尾 → 仍被否决
    const hands2 = { p0: byRank(12, 2), p1: byRank(8, 5) };
    const e2 = mkEngine(hands2, { p0: skywalker });
    const r2 = e2.playCards('p0', hands2.p0.map((c) => c.id));
    expect(r2.ok).toBe(false);
    expect((r2 as { reason: string }).reason).toContain('仁德');

    // 炸弹 QQQ 收尾 → 可打出并获胜
    const hands3 = { p0: byRank(12, 3), p1: byRank(8, 5) };
    const e3 = mkEngine(hands3, { p0: skywalker });
    const r3 = e3.playCards('p0', hands3.p0.map((c) => c.id));
    expect(r3.ok).toBe(true);
    expect(e3.snapshotFor('p0').winnerId).toBe('p0');
  });
});
