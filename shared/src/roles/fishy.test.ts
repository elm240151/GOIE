import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import fishy from './fishy';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

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

/** 牌守恒：所有手牌 + 牌堆 + 弃牌 + 桌面 + 边牌 + 翻牌区 = 162 */
function total(engine: GameEngine): number {
  const snap = engine.snapshotFor('p0');
  let n = snap.deckCount + snap.discardCount + snap.revealed.length + snap.tableSide.length;
  for (const p of snap.players) n += p.handCount;
  if (snap.table) n += snap.table.cards.length;
  return n;
}

/** 挂起询问 */
function askOf(r: ReturnType<GameEngine['pass']> | ReturnType<GameEngine['playCards']>): SkillAsk | null {
  return r.ok ? (r.pendingAsk as SkillAsk) : null;
}

describe('海棠（洄游/隐匿）', () => {
  it('洄游：出牌即切换牌序，倒序恰好小一级可压', () => {
    const hands = { p0: [byRank(5, 1)[0]!, byRank(9, 1)[0]!], p1: [byRank(4, 1)[0]!, byRank(10, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').orderReversed).toBe(true);
    // 倒序：p1 用 4 压 5 合法
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
  });

  it('洄游：倒序下 6 压不了 5（必须恰好小一级）', () => {
    const hands = { p0: [byRank(5, 1)[0]!, byRank(9, 1)[0]!], p1: [byRank(6, 1)[0]!, byRank(10, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('恰好小一级');
  });

  it('洄游：倒序 3 压一切但 3 压不了 3', () => {
    const hands = { p0: [byRank(9, 1)[0]!, byRank(7, 1)[0]!], p1: [byRank(3, 1)[0]!, byRank(10, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    // p1 用 3 压 9（倒序 3 最大）
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    // p0 手上没有 3 → 过 → 新轮
    expect(engine.pass('p0').ok).toBe(true);
    // 轮末恢复正序
    expect(engine.snapshotFor('p0').orderReversed).toBe(false);
  });

  it('洄游：倒序 3 压不了 3（只有炸弹能压）', () => {
    const hands = { p0: [byRank(3, 1)[0]!, byRank(9, 1)[0]!], p1: [byRank(3, 1)[0]!, byRank(10, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('只有炸弹');
  });

  it('洄游：倒序对3 只有炸压', () => {
    const hands = {
      p0: [byRank(3, 2)[0]!, byRank(3, 2)[1]!, byRank(9, 1)[0]!],
      p1: [byRank(4, 2)[0]!, byRank(4, 2)[1]!, byRank(10, 1)[0]!],
    };
    const engine = mkEngine(hands, { p0: fishy });
    // p0 起对3（手上还有 9，不触发禁止收尾）
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('只有炸弹');
  });

  it('洄游：倒序 A 响应 2', () => {
    const hands = { p0: [byRank(15, 1)[0]!, byRank(9, 1)[0]!], p1: [byRank(14, 1)[0]!, byRank(10, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
  });

  it('洄游：倒序顺子 654 接 543', () => {
    const hands = {
      p0: [byRank(5, 1)[0]!, byRank(4, 1)[0]!, byRank(3, 1)[0]!, byRank(9, 1)[0]!],
      p1: [byRank(6, 1)[0]!, byRank(5, 1)[0]!, byRank(4, 1)[0]!, byRank(10, 1)[0]!],
    };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]).ok).toBe(true);
  });

  it('洄游：每次出牌切换一次，海棠自己的出牌按切换前顺序判定，偶数次回正序', () => {
    const hands = { p0: [byRank(5, 1)[0]!, byRank(3, 1)[0]!, byRank(7, 1)[0]!], p1: [byRank(4, 2)[0]!, byRank(4, 2)[1]!] };
    const engine = mkEngine(hands, { p0: fishy });
    // p0 出5（正序判定）→ 切倒序
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.snapshotFor('p0').orderReversed).toBe(true);
    // p1 用 4 压 5（倒序）→ 海棠用 3 压 4（倒序判定：3 压一切）→ 切回正序
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    expect(engine.snapshotFor('p0').orderReversed).toBe(false);
    // p1 用 4 压 3（正序恰好大一级）→ 空手获胜
    const r = engine.playCards('p1', [hands.p1[1]!.id]);
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1');
  });

  it('洄游：轮末恢复正序，下一轮从正序重新计数', () => {
    const hands = { p0: [byRank(5, 1)[0]!, byRank(7, 1)[0]!], p1: [byRank(4, 1)[0]!, byRank(6, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.snapshotFor('p0').orderReversed).toBe(true);
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    // p0 过（7 压不了 4）→ 轮末：p1 补摸 1 张，恢复正序
    const r = engine.pass('p0');
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.orderReversed).toBe(false);
    expect(snap.turnPlayerId).toBe('p1');
    expect(snap.table).toBeNull();
    expect(r.ok && r.events.some((e) => e.type === 'round:ended' && e.drew === 1)).toBe(true);
  });

  it('倒序禁止收尾：单3 打完手牌被拒（玩家留在局中不判负）', () => {
    const hands = { p0: [byRank(5, 1)[0]!, byRank(3, 1)[0]!], p1: [byRank(4, 1)[0]!, byRank(10, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 切倒序
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p0', [hands.p0[1]!.id]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('不能以单 3/对 3 打完手牌');
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing');
    expect(snap.players[0]!.handCount).toBe(1);
    expect(snap.players[0]!.eliminated).toBeFalsy();
    // 过牌继续在局中
    expect(engine.pass('p0').ok).toBe(true);
    expect(total(engine)).toBe(162);
  });

  it('倒序禁止收尾：对3 打完手牌被拒；非收尾单3 合法', () => {
    const hands = {
      p0: [byRank(5, 1)[0]!, byRank(3, 2)[0]!, byRank(3, 2)[1]!],
      p1: [byRank(4, 1)[0]!, byRank(10, 1)[0]!],
    };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 切倒序
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p0', [hands.p0[1]!.id, hands.p0[2]!.id]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('不能以单 3/对 3 打完手牌');
    // 换成先出单3（手牌还剩一张 3，非收尾）→ 合法，且切回正序
    const r2 = engine.playCards('p0', [hands.p0[1]!.id]);
    expect(r2.ok).toBe(true);
    expect(engine.snapshotFor('p0').orderReversed).toBe(false);
  });

  it('倒序禁止收尾：3炸 打完手牌正常获胜（炸弹不受禁止收尾限制）', () => {
    const hands = {
      p0: [byRank(5, 1)[0]!, byRank(3, 3)[0]!, byRank(3, 3)[1]!, byRank(3, 3)[2]!],
      p1: [byRank(4, 1)[0]!, byRank(10, 1)[0]!],
    };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 切倒序
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p0', [hands.p0[1]!.id, hands.p0[2]!.id, hands.p0[3]!.id]);
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
  });

  it('隐匿：整轮未出牌 → 轮末确认 → 选牌 → 弃一摸一（先于整备补摸）', () => {
    const hands = { p0: [byRank(9, 1)[0]!, byRank(8, 1)[0]!], p1: [byRank(5, 1)[0]!, byRank(6, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy }, 'p1');
    const snap0 = engine.snapshotFor('p0');
    expect(snap0.deckCount).toBe(158);
    // p1 起牌 → p0 过（压不了 5）→ 轮末：隐匿询问挂起
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.pass('p0');
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('隐匿');
    // 确认 → 选牌询问（候选 = 全部手牌，1-1 张）
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(pickAsk?.kind).toBe('pickCards');
    expect(pickAsk?.cards?.map((c) => c.id)).toEqual([hands.p0[0]!.id, hands.p0[1]!.id]);
    expect(pickAsk?.min).toBe(1);
    expect(pickAsk?.max).toBe(1);
    // 弃 9 → 摸 1（先于轮末补摸）
    const done = engine.resolveAsk('p0', { askId: pickAsk!.askId!, cardIds: [hands.p0[0]!.id] });
    expect(done.ok).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'skill:triggered' && /重铸/.test(e.text))).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p1' && e.drew === 1)).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(2); // 8 + 摸 1
    expect(snap.discardCount).toBe(2); // 重铸弃 9 + 轮末桌面弃 5
    expect(snap.deckCount).toBe(156); // 158 - 隐匿摸 1 - p1 补摸 1
    expect(snap.turnPlayerId).toBe('p1');
    expect(snap.orderReversed).toBe(false);
    expect(total(engine)).toBe(162);
  });

  it('隐匿：弃权则放弃重铸，轮末照常补摸', () => {
    const hands = { p0: [byRank(9, 1)[0]!, byRank(8, 1)[0]!], p1: [byRank(5, 1)[0]!, byRank(6, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy }, 'p1');
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.pass('p0');
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(d.ok && !d.events.some((e) => e.type === 'skill:triggered' && /重铸/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(2);
    expect(snap.discardCount).toBe(1); // 只有轮末桌面弃 5，无重铸弃牌
    expect(snap.deckCount).toBe(157); // 只扣 p1 补摸
    expect(total(engine)).toBe(162);
  });

  it('隐匿：本回合出过牌（含偶数次回正序）不发动', () => {
    const hands = { p0: [byRank(5, 1)[0]!, byRank(3, 1)[0]!, byRank(7, 1)[0]!], p1: [byRank(4, 1)[0]!, byRank(10, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 出 1 次
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true); // 出 2 次 → 回正序
    expect(engine.snapshotFor('p0').orderReversed).toBe(false);
    // p1 过（10 压不了 3）→ 轮末：海棠出过牌，无隐匿询问
    const r = engine.pass('p1');
    expect(r.ok).toBe(true);
    expect(r.ok && !r.pendingAsk).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'round:ended' && e.drew === 1)).toBe(true);
  });

  it('隐匿：只出了一次牌（奇数次）也不发动', () => {
    const hands = { p0: [byRank(5, 1)[0]!, byRank(9, 1)[0]!], p1: [byRank(4, 1)[0]!, byRank(10, 1)[0]!] };
    const engine = mkEngine(hands, { p0: fishy });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 出 1 次
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.pass('p0');
    expect(r.ok).toBe(true);
    expect(r.ok && !r.pendingAsk).toBe(true);
  });
});
