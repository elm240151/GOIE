import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import patrick from './patrick';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
/** 指定点数+花色的前 n 张（0♠ 1♥ 2♣ 3♦） */
const suitOf = (r: number, s: number, n: number) =>
  deck.filter((c) => c.rank === r && c.suit === s).slice(0, n);

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

describe('第七席 圣帕特里克（无名）', () => {
  const hands = {
    p0: [byRank(3, 2)[0]!, deck.filter((c) => c.rank === 3)[2]!, ...byRank(9, 3)], // ♠3♣3（避开 ♠4 的 id）
    p1: byRank(13, 5), // 中间人无牌可接
    p2: [suitOf(4, 0, 2)[0]!, suitOf(4, 0, 2)[1]!, ...byRank(10, 3)], // 无名：两张黑桃4
  };

  it('插队接牌：被响应者摸 X 张，从无名下家继续，播报技能', () => {
    const engine = mkEngine(hands, { p2: patrick });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 起对3
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('cutIn');
    const a = engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'yes', cardIds: hands.p2.slice(0, 2).map((c) => c.id) });
    expect(a.ok).toBe(true);
    const events = a.ok ? a.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wu-ming')).toBe(true);
    const snap = engine.snapshotFor('p2');
    expect(snap.table?.rank).toBe(4);
    expect(snap.turnPlayerId).toBe('p0'); // 从无名 p2 的下家继续（插队跳过了 p1）
    expect(snap.players[0]!.handCount).toBe(5 - 2 + 8); // 摸 X = ♠4+♠4（与被压 ♠3♣3 同花色）
    expect(snap.players[2]!.handCount).toBe(3); // 5 - 2
  });

  it('拒绝插队：正常轮转', () => {
    const engine = mkEngine(hands, { p2: patrick });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const d = engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(engine.snapshotFor('p1').turnPlayerId).toBe('p1');
  });

  it('响应牌与被压牌无同花色：不触发插队询问', () => {
    // 无名只有 ♥4♦4 + 3 张 ♥/♦ 10（被压 ♠3♣3 无 ♥/♦ 之外的花色）：
    // 无同花色牌（炸弹也无同花色，2026-10-06 跟牌枚举含炸弹）→ 无插队询问
    const hands2 = {
      p0: [byRank(3, 2)[0]!, deck.filter((c) => c.rank === 3)[2]!, ...byRank(9, 3)], // ♠3♣3
      p1: byRank(13, 5),
      p2: [suitOf(4, 1, 1)[0]!, suitOf(4, 3, 1)[0]!, ...suitOf(10, 1, 2), ...suitOf(10, 3, 1)], // ♥4♦4 + 3×10（♥♥♦）
    };
    const engine = mkEngine(hands2, { p2: patrick });
    const r = engine.playCards('p0', [hands2.p0[0]!.id, hands2.p0[1]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(false); // 无插队询问
    expect(engine.snapshotFor('p1').turnPlayerId).toBe('p1'); // 正常轮到 p1
  });

  it('插队者就是下家：直接正常轮转，不询问', () => {
    // p2 无名是 p0 的下家（2 人局）
    const hands2 = {
      p0: [byRank(3, 2)[0]!, deck.filter((c) => c.rank === 3)[2]!, ...byRank(9, 3)], // ♠3♣3
      p1: [suitOf(4, 0, 2)[0]!, suitOf(4, 0, 2)[1]!, ...byRank(10, 3)],
    };
    const engine = mkEngine(hands2, { p1: patrick });
    const r = engine.playCards('p0', [hands2.p0[0]!.id, hands2.p0[1]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(false);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1');
  });

  it('普通响应（2人局）：响应牌同花色 → 被响应者摸 X，轮转正常继续', () => {
    // p0 起对3 → p1（无名，2人局无插队）普通接 ♠4♠4 → p0 摸 X = 4+4 = 8，轮转回到 p0
    const hands2 = {
      p0: [byRank(3, 2)[0]!, deck.filter((c) => c.rank === 3)[2]!, ...byRank(9, 3)],
      p1: [suitOf(4, 0, 2)[0]!, suitOf(4, 0, 2)[1]!, ...byRank(10, 3)],
    };
    const engine = mkEngine(hands2, { p1: patrick });
    const r = engine.playCards('p0', [hands2.p0[0]!.id, hands2.p0[1]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(false); // 2人局无插队询问
    const r2 = engine.playCards('p1', hands2.p1.slice(0, 2).map((c) => c.id)); // 普通接 ♠4♠4
    expect(r2.ok).toBe(true);
    const events = r2.ok ? r2.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wu-ming')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.turnPlayerId).toBe('p0'); // 轮转正常继续（回到 p0）
    expect(snap.players[0]!.handCount).toBe(5 - 2 + 8); // p0 摸 X = 4+4
    expect(snap.players[1]!.handCount).toBe(3); // 5 - 2
  });

  it('普通响应（3人局，拒绝插队后轮到再接）：同样触发被响应者摸 X，轮转回自己下家', () => {
    // p0 起对3 → p2 拒绝插队 → p1 过 → p2 普通接 ♠4♠4 → p0 摸 8；轮转从 p2 下家（p0）继续，与插队一致
    const engine = mkEngine(hands, { p2: patrick });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    expect(r.ok && r.suspended).toBe(true); // 先有插队询问
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r2 = engine.playCards('p2', hands.p2.slice(0, 2).map((c) => c.id)); // 普通接 ♠4♠4
    expect(r2.ok).toBe(true);
    const events = r2.ok ? r2.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wu-ming')).toBe(true);
    const snap = engine.snapshotFor('p2');
    expect(snap.turnPlayerId).toBe('p0'); // 从无名 p2 的下家继续
    expect(snap.players[0]!.handCount).toBe(5 - 2 + 8);
    expect(snap.players[2]!.handCount).toBe(3);
  });

  it('单张同花色响应（2人局）：也触发，X = 单张点数', () => {
    // 用户实测场景：p0 起 ♠3 → 无名普通接 ♠4（单张同花色）→ p0 摸 X = 4
    const hands2 = {
      p0: [suitOf(3, 0, 1)[0]!, ...byRank(9, 4)],
      p1: [suitOf(4, 0, 1)[0]!, ...byRank(10, 4)],
    };
    const engine = mkEngine(hands2, { p1: patrick });
    const r = engine.playCards('p0', [hands2.p0[0]!.id]);
    expect(r.ok).toBe(true);
    const r2 = engine.playCards('p1', [hands2.p1[0]!.id]); // 单张 ♠4 压 ♠3
    expect(r2.ok).toBe(true);
    const events = r2.ok ? r2.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wu-ming')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.turnPlayerId).toBe('p0');
    expect(snap.players[0]!.handCount).toBe(5 - 1 + 4); // p0 摸 X = 4
    expect(snap.players[1]!.handCount).toBe(4);
  });

  it('A 记 1、2 记 2（2026-10-06 用户确认）：对A 响应 → 被响应者摸 1+1；对2 响应 → 摸 2+2', () => {
    // 对A：p0 起 ♠K♠K → 无名 ♠A♠A 恰好接 → p0 摸 X = 1+1 = 2（不再是 14+14）
    const hA = {
      p0: [...suitOf(13, 0, 2), ...byRank(9, 3)],
      p1: [...suitOf(14, 0, 2), ...byRank(10, 3)],
    };
    const eA = mkEngine(hA, { p1: patrick });
    expect(eA.playCards('p0', [hA.p0[0]!.id, hA.p0[1]!.id]).ok).toBe(true);
    expect(eA.playCards('p1', [hA.p1[0]!.id, hA.p1[1]!.id]).ok).toBe(true);
    expect(eA.snapshotFor('p0').players[0]!.handCount).toBe(5 - 2 + 2);
    // 对2：p0 起 ♠A♠A → 无名 ♠2♠2 压一切 → p0 摸 X = 2+2 = 4（不再是 15+15）
    const h2 = {
      p0: [...suitOf(14, 0, 2), ...byRank(9, 3)],
      p1: [...suitOf(15, 0, 2), ...byRank(10, 3)],
    };
    const e2 = mkEngine(h2, { p1: patrick });
    expect(e2.playCards('p0', [h2.p0[0]!.id, h2.p0[1]!.id]).ok).toBe(true);
    expect(e2.playCards('p1', [h2.p1[0]!.id, h2.p1[1]!.id]).ok).toBe(true);
    expect(e2.snapshotFor('p0').players[0]!.handCount).toBe(5 - 2 + 4);
  });

  it('单张不同花色响应：不触发', () => {
    const hands2 = {
      p0: [suitOf(3, 0, 1)[0]!, ...byRank(9, 4)],
      p1: [suitOf(4, 1, 1)[0]!, ...byRank(10, 4)], // ♥4
    };
    const engine = mkEngine(hands2, { p1: patrick });
    expect(engine.playCards('p0', [hands2.p0[0]!.id]).ok).toBe(true);
    const r2 = engine.playCards('p1', [hands2.p1[0]!.id]);
    expect(r2.ok).toBe(true);
    const events = r2.ok ? r2.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wu-ming')).toBe(false);
    expect(engine.snapshotFor('p1').players[0]!.handCount).toBe(4); // 未摸牌
  });

  it('多花色响应：X 只算与被压牌同花色的牌（用户示例 ♠5♥6♦7 ← ♣6♦7♠8 → 7+8=15）', () => {
    const hands2 = {
      p0: [suitOf(5, 0, 1)[0]!, suitOf(6, 1, 1)[0]!, suitOf(7, 3, 2)[0]!, ...byRank(9, 2)], // ♠5♥6♦7
      p1: [suitOf(6, 2, 1)[0]!, suitOf(7, 3, 2)[1]!, suitOf(8, 0, 1)[0]!, ...byRank(10, 2)], // ♣6♦7♠8
    };
    const engine = mkEngine(hands2, { p1: patrick });
    const r = engine.playCards('p0', hands2.p0.slice(0, 3).map((c) => c.id)); // 顺子 567
    expect(r.ok).toBe(true);
    const r2 = engine.playCards('p1', hands2.p1.slice(0, 3).map((c) => c.id)); // 顺子 678
    expect(r2.ok).toBe(true);
    const events = r2.ok ? r2.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wu-ming')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.turnPlayerId).toBe('p0');
    // 同花色：♦7（♦ 在 {♠♥♦} 中）+ ♠8（♠ 在 {♠♥♦} 中）= 15；♣6 不算
    expect(snap.players[0]!.handCount).toBe(5 - 3 + 15);
  });

  it('插队单张（3人局）：单张同花色也能插队，X = 单张点数', () => {
    const hands2 = {
      p0: [suitOf(3, 0, 1)[0]!, ...byRank(9, 4)], // 起 ♠3
      p1: byRank(13, 5),
      p2: [suitOf(4, 0, 1)[0]!, ...byRank(10, 4)], // 无名：♠4
    };
    const engine = mkEngine(hands2, { p2: patrick });
    const r = engine.playCards('p0', [hands2.p0[0]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(true); // 单张同花色也有插队询问
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('cutIn');
    const a = engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'yes', cardIds: [hands2.p2[0]!.id] });
    expect(a.ok).toBe(true);
    const snap = engine.snapshotFor('p2');
    expect(snap.table?.rank).toBe(4);
    expect(snap.turnPlayerId).toBe('p0');
    expect(snap.players[0]!.handCount).toBe(5 - 1 + 4); // X = ♠4 = 4
  });
});
