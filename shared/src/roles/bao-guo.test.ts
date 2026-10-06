// 角色：陈正（引路者·马场之王）—— 四技能测试：见习 / 反力矩 / 五连鞭 / 压腿。
// 测试环境说明：handsOverride 模式下牌堆不洗牌、翻牌从牌堆尾部取，牌堆顶可精确预测——
// 默认牌堆顶两张 = 小王(d2)、大王(d2)（陈正 16 vs 14 胜，差 2）；把大王(d2)放进手牌后
// 牌堆顶 = 2♦(d2)、小王(d2)（陈正 2+2=4 vs 14 负，差 10）。压腿的平局分支与反力矩共用
// 「mine > theirs」判定、由反力矩平局用例覆盖（相邻两张牌无法构成压腿平局点差）。
import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import baoGuo from './bao-guo';
import kingNan from './king-nan';
import yyXue from './yy-xue';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const pick = (r: number, s: number) => deck.find((c) => c.rank === r && c.suit === s)!;
const joker = (big: boolean) => deck.find((c) => c.rank === (big ? 17 : 16))!;
const jokerOfDeck = (big: boolean, d: number) => deck.find((c) => c.rank === (big ? 17 : 16) && c.deck === d)!;

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
  let n = snap.deckCount + snap.discardCount + snap.revealed.length + snap.tableSide.length + snap.stagedDiscards.reduce((x, e) => x + e.cards.length, 0);
  for (const p of snap.players) n += p.handCount;
  if (snap.table) n += snap.table.cards.length;
  return n;
}

/** 见习完整流程（选目标 → 私摸 2 → 暗交 1 张；giveId 缺省自动交第 1 张） */
function jianXi(engine: GameEngine, target: string, giveId?: number): void {
  const r = engine.useSkillAction('p0', { skillId: 'jian-xi' });
  expect(r.ok).toBe(true);
  const pickAsk = r.ok ? (r.pendingAsk as SkillAsk) : null;
  expect(pickAsk?.kind).toBe('pickTarget');
  const g = engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: target });
  expect(g.ok).toBe(true);
  const giveAsk = g.ok ? (g.pendingAsk as SkillAsk) : null;
  expect(giveAsk?.kind).toBe('pickCards');
  expect(giveAsk?.cards).toHaveLength(2);
  const done = engine.resolveAsk('p0', {
    askId: giveAsk!.askId!,
    ...(giveId ? { cardIds: [giveId] } : { choice: 'decline' as const }),
  });
  expect(done.ok).toBe(true);
}

/** 反力矩完整流程（选目标 → 陈正暗选 → 对方暗选）→ 返回拼点结算结果（获胜时带弃牌询问） */
function fanLi(engine: GameEngine, target: string, myCardId: number, tCardId: number) {
  const r = engine.useSkillAction('p0', { skillId: 'fan-li-ju' });
  expect(r.ok).toBe(true);
  const pickAsk = r.ok ? (r.pendingAsk as SkillAsk) : null;
  expect(pickAsk?.kind).toBe('pickTarget');
  const s1 = engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: target });
  expect(s1.ok).toBe(true);
  const selfAsk = s1.ok ? (s1.pendingAsk as SkillAsk) : null;
  expect(selfAsk?.kind).toBe('pickCards');
  const s2 = engine.resolveAsk('p0', { askId: selfAsk!.askId!, cardIds: [myCardId] });
  expect(s2.ok).toBe(true);
  const tAsk = s2.ok ? (s2.pendingAsk as SkillAsk) : null;
  expect(tAsk?.kind).toBe('pickCards');
  expect(tAsk?.askPlayerId).toBe(target);
  return engine.resolveAsk(target, { askId: tAsk!.askId!, cardIds: [tCardId] });
}

/** 测试角色：pickTarget 候选 = 所有其他未淘汰玩家（用于验证引擎对罚站玩家的候选过滤） */
const pickAll: RoleDef = {
  id: 'test-pick-all',
  name: '全选者',
  skills: [{ id: 'quan-xuan', name: '全选', description: '测试用：候选含所有其他未淘汰玩家' }],
  skillActions: [{ skillId: 'quan-xuan', when: 'myTurn', label: '全选' }],
  hooks: {
    onSkillAction(ctx) {
      if (ctx.answer) return; // 弃权后不再重问
      return {
        ok: true,
        ask: {
          kind: 'pickTarget',
          prompt: '选一个',
          targetCandidates: ctx.game
            .players()
            .filter((p) => p.id !== ctx.self.id && !ctx.game.eliminated(p.id))
            .map((p) => p.id),
        },
      };
    },
  },
};

describe('陈正（见习/反力矩/五连鞭/压腿）', () => {
  it('见习：选目标→私摸2→暗交1→罚站（出牌被拒/可过/下轮解除/连续两回合限制/弃权不消耗）', () => {
    const hands = { p0: byRank(3, 5), p1: byRank(10, 5), p2: byRank(5, 5) };
    const engine = mkEngine(hands, { p0: baoGuo });
    // 开局：陈正起牌，无自动询问（见习是主动技）
    let snap = engine.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p0');
    expect(snap.pendingAsk).toBeNull();
    expect(snap.roundBannedIds).toEqual([]);
    // 发动：选目标（候选不含自己）
    const r = engine.useSkillAction('p0', { skillId: 'jian-xi' });
    expect(r.ok).toBe(true);
    const pickAsk = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(pickAsk?.kind).toBe('pickTarget');
    expect(pickAsk?.targetCandidates).toEqual(['p1', 'p2']);
    // 选 p1：陈正私摸 2 张 → 选 1 张暗交
    const g = engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' });
    expect(g.ok).toBe(true);
    const giveAsk = g.ok ? (g.pendingAsk as SkillAsk) : null;
    expect(giveAsk?.kind).toBe('pickCards');
    expect(giveAsk?.cards).toHaveLength(2);
    snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(7); // 5 + 私摸 2
    const done = engine.resolveAsk('p0', { askId: giveAsk!.askId!, cardIds: [giveAsk!.cards![0]!.id] });
    expect(done.ok).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'skill:triggered' && /罚站/.test(e.text))).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(6); // 交 1 留 1
    expect(snap.players[1]!.handCount).toBe(6);
    expect(snap.roundBannedIds).toEqual(['p1']);
    // 陈正照常出牌；罚站者出牌被拒、可以过
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const block = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(block.ok).toBe(false);
    expect((block as { reason: string }).reason).toContain('罚站');
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    // 轮末：罚站解除，陈正保住牌权
    snap = engine.snapshotFor('p0');
    expect(snap.roundBannedIds).toEqual([]);
    expect(snap.turnPlayerId).toBe('p0');
    // 连续两回合不能见习同一人：候选只剩 p2
    const r2 = engine.useSkillAction('p0', { skillId: 'jian-xi' });
    const pickAsk2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(pickAsk2?.targetCandidates).toEqual(['p2']);
    // 弃权：不消耗、照常出牌
    expect(engine.resolveAsk('p0', { askId: pickAsk2!.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    expect(total(engine)).toBe(162);
  });

  it('见习：弃权不消耗次数、每局限 X+2 次（X=人数）', () => {
    const hands = { p0: byRank(3, 8), p1: byRank(10, 8), p2: byRank(11, 8) };
    const engine = mkEngine(hands, { p0: baoGuo });
    const roundEnd = () => {
      expect(engine.playCards('p0', [engine.snapshotFor('p0').players[0]!.hand![0]!.id]).ok).toBe(true);
      expect(engine.pass('p1').ok).toBe(true);
      expect(engine.pass('p2').ok).toBe(true);
    };
    // R1 见习 p1（1 次）→ R2 弃权（不消耗）→ R3~R6 用完剩余 4 次（交替目标避开连续限制）→ R7 用尽
    jianXi(engine, 'p1');
    roundEnd();
    const r2 = engine.useSkillAction('p0', { skillId: 'jian-xi' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'decline' }).ok).toBe(true);
    roundEnd();
    // R3：弃权未消耗，且隔了一轮 p1 重新可选
    const r3 = engine.useSkillAction('p0', { skillId: 'jian-xi' });
    const ask3 = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(ask3?.targetCandidates).toEqual(['p1', 'p2']);
    expect(engine.resolveAsk('p0', { askId: ask3!.askId!, choice: 'decline' }).ok).toBe(true);
    jianXi(engine, 'p2'); // 2
    roundEnd();
    jianXi(engine, 'p1'); // 3
    roundEnd();
    jianXi(engine, 'p2'); // 4
    roundEnd();
    jianXi(engine, 'p1'); // 5
    roundEnd();
    // 第 6 次：用尽
    const r7 = engine.useSkillAction('p0', { skillId: 'jian-xi' });
    expect(r7.ok).toBe(false);
    expect((r7 as { reason: string }).reason).toContain('用尽');
    expect(total(engine)).toBe(162);
  });

  it('见习：give 阶段超时/弃权自动交第 1 张', () => {
    const hands = { p0: byRank(3, 5), p1: byRank(10, 5), p2: byRank(5, 5) };
    const engine = mkEngine(hands, { p0: baoGuo });
    const r = engine.useSkillAction('p0', { skillId: 'jian-xi' });
    const pickAsk = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const g = engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' });
    const giveAsk = g.ok ? (g.pendingAsk as SkillAsk) : null;
    // 弃选 → 自动交第 1 张
    const done = engine.resolveAsk('p0', { askId: giveAsk!.askId!, choice: 'decline' });
    expect(done.ok).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'skill:triggered' && /收下 1 张暗牌并罚站/.test(e.text))).toBe(
      true
    );
    const snap = engine.snapshotFor('p0');
    expect(snap.players[1]!.handCount).toBe(6);
    expect(snap.players[0]!.handCount).toBe(6);
    expect(snap.roundBannedIds).toEqual(['p1']);
    expect(total(engine)).toBe(162);
  });

  it('见习：私摸超上限照常淘汰、目标仍罚站、回合让出', () => {
    const hands = { p0: [...byRank(3, 12), ...byRank(4, 7)], p1: byRank(10, 5), p2: byRank(11, 5) };
    const engine = mkEngine(hands, { p0: baoGuo });
    const r = engine.useSkillAction('p0', { skillId: 'jian-xi' });
    const pickAsk = r.ok ? (r.pendingAsk as SkillAsk) : null;
    // 19 + 2 = 21 > 20 → 陈正淘汰
    const done = engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' });
    expect(done.ok).toBe(true);
    expect(done.ok && !done.pendingAsk).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.eliminated).toBe(true);
    expect(snap.phase).toBe('playing');
    expect(snap.roundBannedIds).toEqual(['p1']);
    expect(snap.turnPlayerId).toBe('p1'); // 淘汰让出回合
    expect(total(engine)).toBe(162);
  });

  it('反力矩：获胜——两张拼点牌交给对方 + 陈正自弃 1 张（之后照常出牌）', () => {
    const hands = {
      p0: [pick(13, 0), pick(5, 2), pick(3, 1), pick(9, 3)], // K♠ 5♣ 3♥ 9♦
      p1: [pick(3, 0), ...byRank(10, 4)],
      p2: byRank(6, 5),
    };
    const engine = mkEngine(hands, { p0: baoGuo });
    const done = fanLi(engine, 'p1', hands.p0[0]!.id, hands.p1[0]!.id); // K(+2)=15 vs 3 → 胜
    expect(done.ok).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'cards:revealed' && (e as { purpose?: string }).purpose === '反力矩拼点')).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'skill:triggered' && /拼点获胜/.test(e.text))).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.players[1]!.handCount).toBe(6); // 5 - 1 + 2
    expect(snap.players[0]!.handCount).toBe(3); // 4 - 1，待弃 1
    const discardAsk = done.ok ? (done.pendingAsk as SkillAsk) : null;
    expect(discardAsk?.kind).toBe('pickCards');
    expect(discardAsk?.cards).toHaveLength(3);
    // 自弃一张 → 照常出牌
    const d = engine.resolveAsk('p0', { askId: discardAsk!.askId!, cardIds: [hands.p0[3]!.id] });
    expect(d.ok).toBe(true);
    expect(d.ok && !d.pendingAsk).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(2);
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    expect(total(engine)).toBe(162);
  });

  it('反力矩：落败——陈正获得两张拼点牌；平局算陈正输', () => {
    // 落败：3(+2)=5 vs K=13
    const handsA = {
      p0: [pick(3, 1), pick(5, 2), pick(9, 3), pick(10, 0)],
      p1: [pick(13, 0), ...byRank(6, 4)],
      p2: byRank(7, 5),
    };
    const engineA = mkEngine(handsA, { p0: baoGuo });
    const doneA = fanLi(engineA, 'p1', handsA.p0[0]!.id, handsA.p1[0]!.id);
    expect(doneA.ok).toBe(true);
    expect(doneA.ok && !doneA.pendingAsk).toBe(true);
    expect(doneA.ok && doneA.events.some((e) => e.type === 'skill:triggered' && /拼点落败/.test(e.text))).toBe(true);
    const snapA = engineA.snapshotFor('p0');
    expect(snapA.players[0]!.handCount).toBe(5); // 4 - 1 + 2
    expect(snapA.players[1]!.handCount).toBe(4);
    expect(total(engineA)).toBe(162);
    // 平局：5(+2)=7 vs 7 → 算陈正输
    const handsB = {
      p0: [pick(5, 2), pick(3, 1), pick(9, 3), pick(10, 0)],
      p1: [pick(7, 3), ...byRank(6, 4)],
      p2: byRank(8, 5),
    };
    const engineB = mkEngine(handsB, { p0: baoGuo });
    const doneB = fanLi(engineB, 'p1', handsB.p0[0]!.id, handsB.p1[0]!.id);
    expect(doneB.ok).toBe(true);
    expect(doneB.ok && doneB.events.some((e) => e.type === 'skill:triggered' && /拼点落败/.test(e.text))).toBe(true);
    const snapB = engineB.snapshotFor('p0');
    expect(snapB.players[0]!.handCount).toBe(5);
    expect(snapB.players[1]!.handCount).toBe(4);
    expect(total(engineB)).toBe(162);
  });

  it('反力矩：弃权作罢（选目标弃权 / 对方弃权都不动手牌）', () => {
    const hands = {
      p0: [pick(13, 0), pick(5, 2), pick(3, 1), pick(9, 3)],
      p1: [pick(3, 0), ...byRank(10, 4)],
      p2: byRank(6, 5),
    };
    // 选目标弃权
    const engine = mkEngine(hands, { p0: baoGuo });
    const r = engine.useSkillAction('p0', { skillId: 'fan-li-ju' });
    const pickAsk = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: pickAsk!.askId!, choice: 'decline' }).ok).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(4);
    expect(snap.pendingAsk).toBeNull();
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    // 对方弃权（暗选阶段）：选牌阶段不动手牌
    const engine2 = mkEngine(hands, { p0: baoGuo });
    const r2 = engine2.useSkillAction('p0', { skillId: 'fan-li-ju' });
    const pickAsk2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const s1 = engine2.resolveAsk('p0', { askId: pickAsk2!.askId!, targetPlayerId: 'p1' });
    const selfAsk = s1.ok ? (s1.pendingAsk as SkillAsk) : null;
    const s2 = engine2.resolveAsk('p0', { askId: selfAsk!.askId!, cardIds: [hands.p0[0]!.id] });
    const tAsk = s2.ok ? (s2.pendingAsk as SkillAsk) : null;
    expect(tAsk?.askPlayerId).toBe('p1');
    const done = engine2.resolveAsk('p1', { askId: tAsk!.askId!, choice: 'decline' });
    expect(done.ok).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'cards:revealed')).toBe(false);
    snap = engine2.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(4);
    expect(snap.players[1]!.handCount).toBe(5);
    expect(total(engine2)).toBe(162);
  });

  it('反力矩：手牌不足 3 张不能发动', () => {
    const hands = { p0: [pick(3, 1), pick(5, 2)], p1: byRank(10, 5), p2: byRank(6, 5) };
    const engine = mkEngine(hands, { p0: baoGuo });
    const r = engine.useSkillAction('p0', { skillId: 'fan-li-ju' });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('手牌不足');
  });

  it('反力矩被动：牌权被抢夺时询问（弃权 / 完整拼点流程后轮到新起牌者）', () => {
    const hands = {
      p0: [pick(3, 1), pick(6, 2), pick(9, 3), pick(13, 0)], // 6♥ 不与 p2 的 byRank(5,5) 重叠
      p1: byRank(4, 4),
      p2: byRank(5, 5),
    };
    // 弃权路径
    const engine = mkEngine(hands, { p0: baoGuo });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true);
    expect(engine.pass('p0').ok).toBe(true);
    const r = engine.pass('p1');
    expect(r.ok).toBe(true);
    // 轮在 p1 的过牌处结束：beginTurn 内 onTurnStart 的询问附加在结束回合的那次 pass 结果上
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('抢夺');
    expect(engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.pendingAsk).toBeNull();
    expect(snap.turnPlayerId).toBe('p2');
    expect(engine.playCards('p2', [hands.p2[1]!.id]).ok).toBe(true); // 新起牌者照常出牌
    // 完整拼点路径（新引擎）
    const engine2 = mkEngine(hands, { p0: baoGuo });
    expect(engine2.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine2.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    expect(engine2.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true);
    expect(engine2.pass('p0').ok).toBe(true);
    const r2 = engine2.pass('p1');
    expect(r2.ok).toBe(true);
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('confirm');
    const yes = engine2.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(pickAsk?.kind).toBe('pickTarget');
    expect(pickAsk?.targetCandidates).toEqual(['p1', 'p2']);
    const s1 = engine2.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' });
    const selfAsk = s1.ok ? (s1.pendingAsk as SkillAsk) : null;
    // 陈正轮末补摸 1 张后 4 张手牌，暗选 K♠
    const s2 = engine2.resolveAsk('p0', { askId: selfAsk!.askId!, cardIds: [hands.p0[3]!.id] });
    const tAsk = s2.ok ? (s2.pendingAsk as SkillAsk) : null;
    expect(tAsk?.askPlayerId).toBe('p1');
    const done = engine2.resolveAsk('p1', { askId: tAsk!.askId!, cardIds: [hands.p1[1]!.id] }); // 15 vs 4 → 胜
    expect(done.ok).toBe(true);
    const discardAsk = done.ok ? (done.pendingAsk as SkillAsk) : null;
    expect(discardAsk?.kind).toBe('pickCards');
    expect(engine2.resolveAsk('p0', { askId: discardAsk!.askId!, choice: 'decline' }).ok).toBe(true); // 自动弃第一张
    snap = engine2.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p2');
    expect(engine2.playCards('p2', [hands.p2[1]!.id]).ok).toBe(true);
    expect(total(engine2)).toBe(162);
  });

  it('反力矩被动：陈正保住牌权不询问；手牌不足 3 张不询问', () => {
    // 保住牌权（轮末最后出牌者 = 陈正）
    const hands = {
      p0: [pick(3, 1), pick(5, 2), pick(9, 3), pick(13, 0)],
      p1: byRank(10, 5),
      p2: byRank(6, 5),
    };
    const engine = mkEngine(hands, { p0: baoGuo });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2');
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    // 手牌不足 3 张：被抢夺也不询问
    const hands2 = { p0: [pick(3, 1), pick(6, 2)], p1: byRank(4, 4), p2: byRank(5, 5) }; // 6♥ 不与 p2 重叠
    const engine2 = mkEngine(hands2, { p0: baoGuo });
    expect(engine2.playCards('p0', [hands2.p0[0]!.id]).ok).toBe(true);
    expect(engine2.playCards('p1', [hands2.p1[0]!.id]).ok).toBe(true);
    expect(engine2.playCards('p2', [hands2.p2[0]!.id]).ok).toBe(true);
    expect(engine2.pass('p0').ok).toBe(true);
    const r2 = engine2.pass('p1'); // 轮在 p1 的过牌处结束
    expect(r2.ok).toBe(true);
    expect(r2.ok ? r2.pendingAsk : null).toBeFalsy(); // 手牌 1 < 3（ok() 无询问时 pendingAsk 为 undefined）
    expect(engine2.snapshotFor('p0').turnPlayerId).toBe('p2');
  });

  it('五连鞭：≥5 张触发（含自己），yes 令出牌者摸 1 张；decline 则出牌者打光即胜', () => {
    const straight5 = [pick(3, 0), pick(4, 0), pick(5, 0), pick(6, 0), pick(7, 0)];
    // 别人打（p1 起牌打光 → 亡语询问）
    const engine = mkEngine({ p1: straight5, p0: byRank(10, 5), p2: byRank(11, 5) }, { p0: baoGuo }, 'p1');
    const r = engine.playCards('p1', straight5.map((c) => c.id));
    expect(r.ok).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('5 张');
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(yes.ok).toBe(true);
    expect(yes.ok && yes.events.some((e) => e.type === 'skill:triggered' && /摸 1 张/.test(e.text))).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing'); // 摸 1 张 → 手牌非空，不立即获胜
    expect(snap.winnerId).toBeNull();
    expect(snap.players[0]!.handCount).toBe(1); // hands 顺序 [p1, p0, p2]：players[0] = p1
    expect(snap.turnPlayerId).toBe('p0');
    // 含自己（陈正打光）：yes 摸 1 继续；decline 直接获胜
    const engine2 = mkEngine({ p0: straight5, p1: byRank(10, 5), p2: byRank(11, 5) }, { p0: baoGuo });
    const r2 = engine2.playCards('p0', straight5.map((c) => c.id));
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('confirm');
    expect(engine2.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' }).ok).toBe(true);
    snap = engine2.snapshotFor('p0');
    expect(snap.phase).toBe('playing');
    expect(snap.players[0]!.handCount).toBe(1);
    expect(snap.turnPlayerId).toBe('p1');
    const engine3 = mkEngine({ p0: straight5, p1: byRank(10, 5), p2: byRank(11, 5) }, { p0: baoGuo });
    const r3 = engine3.playCards('p0', straight5.map((c) => c.id));
    const ask3 = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(engine3.resolveAsk('p0', { askId: ask3!.askId!, choice: 'decline' }).ok).toBe(true);
    snap = engine3.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
    expect(total(engine)).toBe(162);
    expect(total(engine3)).toBe(162);
  });

  it('压腿：别人炸弹触发，弃权无事', () => {
    const hands = { p1: [...byRank(9, 4), pick(12, 1), pick(12, 2)], p0: byRank(10, 5), p2: byRank(6, 5) };
    const engine = mkEngine(hands, { p0: baoGuo }, 'p1');
    const r = engine.playCards('p1', byRank(9, 4).map((c) => c.id));
    expect(r.ok).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('炸弹');
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'cards:revealed')).toBe(false);
    const snap = engine.snapshotFor('p0');
    expect(snap.discardCount).toBe(0);
    expect(snap.turnPlayerId).toBe('p0'); // hands 顺序 [p1, p0, p2]：p1 的下家是 p0
    expect(total(engine)).toBe(162);
  });

  it('压腿：拼点获胜（陈正 +2）对方摸 |点差| 张、两张拼点牌弃置', () => {
    const hands = { p1: [...byRank(9, 4), pick(12, 1), pick(12, 2)], p0: byRank(10, 5), p2: byRank(6, 5) };
    const engine = mkEngine(hands, { p0: baoGuo }, 'p1');
    const r = engine.playCards('p1', byRank(9, 4).map((c) => c.id));
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const y = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(y.ok).toBe(true);
    // 牌堆顶 = 小王、大王：陈正 14+2=16 vs 14 → 胜，差 2
    expect(y.ok && y.events.some((e) => e.type === 'cards:revealed' && (e as { purpose?: string }).purpose === '压腿拼点')).toBe(true);
    expect(y.ok && y.events.some((e) => e.type === 'skill:triggered' && /拼点获胜/.test(e.text) && /摸 2 张/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.revealed).toHaveLength(0); // 两张拼点牌一律弃置
    expect(snap.discardCount).toBe(2);
    expect(snap.players[0]!.handCount).toBe(4); // 出牌者（p1 = players[0]）：2 张余牌 + 摸 2
    expect(total(engine)).toBe(162);
  });

  it('压腿：拼点落败陈正摸 |点差| 张', () => {
    const hands = {
      p1: [...byRank(9, 4), pick(12, 1), pick(12, 2)],
      p0: byRank(10, 5),
      p2: [...byRank(6, 5), jokerOfDeck(true, 2)], // 大王(d2)进手牌 → 牌堆顶 = 2♦、小王：4 vs 14 → 负，差 10
    };
    const engine = mkEngine(hands, { p0: baoGuo }, 'p1');
    const r = engine.playCards('p1', byRank(9, 4).map((c) => c.id));
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const y = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(y.ok).toBe(true);
    expect(y.ok && y.events.some((e) => e.type === 'skill:triggered' && /拼点落败/.test(e.text) && /摸 10 张/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.discardCount).toBe(2);
    expect(snap.players[1]!.handCount).toBe(15); // 陈正（p0 = players[1]）：5 + 10
    expect(total(engine)).toBe(162);
  });

  it('压腿：自己炸弹不触发（五连鞭张数不足也不触发）', () => {
    const hands = { p0: [...byRank(9, 4), pick(10, 1), pick(11, 1)], p1: byRank(6, 5), p2: byRank(7, 5) };
    const engine = mkEngine(hands, { p0: baoGuo });
    const r = engine.playCards('p0', byRank(9, 4).map((c) => c.id));
    expect(r.ok).toBe(true);
    expect(r.ok && !r.pendingAsk).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1');
  });

  it('亡语同场顺序：旺旺 → 五连鞭 → 压腿 → 巨石（≥5 张炸弹压楠王）', () => {
    const hands = {
      p0: [pick(3, 1), pick(10, 0), pick(10, 1), pick(10, 2), pick(10, 3)], // 楠王
      p1: byRank(11, 5), // 陈正
      p2: byRank(9, 5), // 5 张炸弹
      p3: byRank(6, 5), // 巨石
    };
    const engine = mkEngine(hands, { p0: kingNan, p1: baoGuo, p3: yyXue });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.playCards('p2', hands.p2.map((c) => c.id));
    // ① 旺旺（priority 100）先问
    let ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('旺旺');
    // ② 五连鞭
    let a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(a.ok).toBe(true);
    ask = a.ok ? (a.pendingAsk as SkillAsk) : null;
    expect(ask?.prompt).toContain('5 张');
    // ③ 压腿（五连鞭 yes → 出牌者摸 1 张后仍续问）
    a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && /摸 1 张/.test(e.text))).toBe(true);
    ask = a.ok ? (a.pendingAsk as SkillAsk) : null;
    expect(ask?.prompt).toContain('炸弹');
    // ④ 巨石（priority 0）最后问
    a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'decline' });
    expect(a.ok).toBe(true);
    ask = a.ok ? (a.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('suit');
    expect(ask?.prompt).toContain('巨石');
    a = engine.resolveAsk('p3', { askId: ask!.askId!, choice: 'decline' });
    expect(a.ok).toBe(true);
    expect(a.ok && !a.pendingAsk).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing'); // 五连鞭摸 1 张 → 打光者手牌非空，不获胜
    expect(snap.players[2]!.handCount).toBe(1);
    expect(snap.turnPlayerId).toBe('p3');
    expect(total(engine)).toBe(162);
  });

  it('罚站：不能被技能选为目标（引擎候选过滤）+ 罚站者自己的技能仍可用', () => {
    const hands = {
      p0: [pick(3, 1), pick(10, 0), pick(10, 1), pick(10, 2), pick(10, 3)], // 陈正
      p1: byRank(11, 5), // 全选者
      p2: byRank(6, 5), // 全选者（被见习）
      p3: byRank(7, 5),
    };
    const engine = mkEngine(hands, { p0: baoGuo, p1: pickAll, p2: pickAll });
    jianXi(engine, 'p2'); // p2 罚站
    // 陈正反力矩候选不含罚站者（角色层过滤）
    const rf = engine.useSkillAction('p0', { skillId: 'fan-li-ju' });
    const rfAsk = rf.ok ? (rf.pendingAsk as SkillAsk) : null;
    expect(rfAsk?.targetCandidates).toEqual(['p1', 'p3']);
    expect(engine.resolveAsk('p0', { askId: rfAsk!.askId!, choice: 'decline' }).ok).toBe(true);
    // 陈正照常出牌 → 轮到 p1：其候选含 p2 但被引擎过滤
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const q1 = engine.useSkillAction('p1', { skillId: 'quan-xuan' });
    expect(q1.ok).toBe(true);
    const ask1 = q1.ok ? (q1.pendingAsk as SkillAsk) : null;
    expect(ask1?.targetCandidates).toEqual(['p0', 'p3']); // p2 罚站被过滤
    expect(engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    // 轮到 p2（罚站中）：自己的技能仍可用
    const q2 = engine.useSkillAction('p2', { skillId: 'quan-xuan' });
    expect(q2.ok).toBe(true);
    const ask2 = q2.ok ? (q2.pendingAsk as SkillAsk) : null;
    expect(ask2?.targetCandidates).toEqual(['p0', 'p1', 'p3']);
    expect(engine.resolveAsk('p2', { askId: ask2!.askId!, choice: 'decline' }).ok).toBe(true);
    // 出牌被拒、可以过
    const block = engine.playCards('p2', [hands.p2[0]!.id]);
    expect(block.ok).toBe(false);
    expect((block as { reason: string }).reason).toContain('罚站');
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.pass('p3').ok).toBe(true);
    expect(engine.snapshotFor('p0').roundBannedIds).toEqual([]); // 轮末解除
    expect(total(engine)).toBe(162);
  });
});
