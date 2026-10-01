import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import csChampion from './cs-champion';
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

describe('第六席 企鹅（骚骚）', () => {
  const hands = {
    p0: [byRank(3, 1)[0]!, ...byRank(9, 4)],
    p1: [byRank(4, 1)[0]!, byRank(5, 1)[0]!, deck.filter((c) => c.rank === 5)[2]!, deck.filter((c) => c.rank === 5)[1]!, byRank(10, 1)[0]!], // 企鹅：♠4 ♠5 ♣5 ♥5 ♠10
    p2: byRank(11, 5),
  };

  it('五段询问：同花色 2 张换目标 1 张（自选换 1 张），换完轮下家', () => {
    const engine = mkEngine(hands, { p1: csChampion });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // p0 起单3
    // 阶段 1：确认
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    expect(r1.ok && r1.suspended).toBe(true);
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    expect(ask1?.kind).toBe('confirm');
    const r2 = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'yes' });
    // 阶段 2：选自己 2 张
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('pickCards');
    expect(ask2?.min).toBe(2);
    const r3 = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] }); // ♠4♠5 同花色
    // 阶段 2.5：同花色也算同颜色 → 自选换 1 张还是 2 张
    const askChoice = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(askChoice?.kind).toBe('choice');
    const r3b = engine.resolveAsk('p1', { askId: askChoice!.askId!, choice: '换 1 张' });
    // 阶段 3：选目标
    const ask3 = r3b.ok ? (r3b.pendingAsk as SkillAsk) : null;
    expect(ask3?.kind).toBe('pickTarget');
    const r4 = engine.resolveAsk('p1', { askId: ask3!.askId!, targetPlayerId: 'p0' });
    // 阶段 4：从目标手牌选 1 张
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    expect(ask4?.kind).toBe('pickCards');
    expect(ask4?.min).toBe(1);
    expect(ask4?.cards).toHaveLength(4); // p0 出完单3 剩 4 张
    const takeId = ask4!.cards![0]!.id;
    const a = engine.resolveAsk('p1', { askId: ask4!.askId!, cardIds: [takeId], targetPlayerId: 'p0' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'sao-sao')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players[1]!.handCount).toBe(4); // 5 - 2 + 1
    expect(snap.players[0]!.handCount).toBe(5); // 4 - 1 + 2
    expect(snap.turnPlayerId).toBe('p2'); // 换完轮下家
    expect(snap.table?.rank).toBe(3); // 桌面不变
    expect(snap.players[1]!.hand?.some((c) => c.id === takeId)).toBe(true); // 拿到目标牌
    // 目标 p0 的手牌只有 p0 自己可见，单独取视角验证
    const snap0 = engine.snapshotFor('p0');
    expect(snap0.players[0]!.hand?.some((c) => c.id === hands.p1[0]!.id)).toBe(true); // 目标拿到 ♠4
  });

  it('同颜色（不同花色）2 张换 2 张', () => {
    const engine = mkEngine(hands, { p1: csChampion });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    // ♠4 + ♣5：同黑色不同花色 → 换 2 张
    const r3 = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[2]!.id] });
    const ask3 = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(ask3?.kind).toBe('pickTarget'); // 仅同颜色不同花色：不出现换 1/2 张选择，直接选目标
    const r4 = engine.resolveAsk('p1', { askId: ask3!.askId!, targetPlayerId: 'p0' });
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    expect(ask4?.min).toBe(2);
    const a = engine.resolveAsk('p1', {
      askId: ask4!.askId!,
      cardIds: [ask4!.cards![0]!.id, ask4!.cards![1]!.id],
      targetPlayerId: 'p0',
    });
    expect(a.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players[1]!.handCount).toBe(5); // 5 - 2 + 2
    expect(snap.players[0]!.handCount).toBe(4); // 4 - 2 + 2
    expect(snap.turnPlayerId).toBe('p2');
  });

  it('两张牌花色颜色都不同：无法发动，轮次不变', () => {
    const engine = mkEngine(hands, { p1: csChampion });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    // ♠4 + ♥5：花色不同、颜色不同
    const a = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[3]!.id] });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && /无法发动/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players[1]!.handCount).toBe(5); // 未交换
    expect(snap.turnPlayerId).toBe('p1'); // 轮次不变，仍须接牌
  });

  it('回归：盲抽阶段答案只带 cardIds 不带 targetPlayerId（客户端真实载荷），交换仍执行', () => {
    const engine = mkEngine(hands, { p1: csChampion });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const r3 = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] }); // ♠4♠5 同花色
    const askChoice = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(askChoice?.kind).toBe('choice');
    const r3b = engine.resolveAsk('p1', { askId: askChoice!.askId!, choice: '换 1 张' });
    const ask3 = r3b.ok ? (r3b.pendingAsk as SkillAsk) : null;
    const r4 = engine.resolveAsk('p1', { askId: ask3!.askId!, targetPlayerId: 'p0' });
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    expect(ask4?.kind).toBe('pickCards');
    const takeId = ask4!.cards![0]!.id;
    // 与客户端一致：只带 cardIds（目标存于技能状态）
    const a = engine.resolveAsk('p1', { askId: ask4!.askId!, cardIds: [takeId] });
    expect(a.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players[1]!.handCount).toBe(4); // 5 - 2 + 1
    expect(snap.players[0]!.handCount).toBe(5); // 4 - 1 + 2
    expect(snap.turnPlayerId).toBe('p2'); // 换完轮下家
    expect(snap.players[1]!.hand?.some((c) => c.id === takeId)).toBe(true); // 拿到目标牌
  });

  it('确认阶段放弃：无事发生', () => {
    const engine = mkEngine(hands, { p1: csChampion });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'decline' });
    expect(a.ok).toBe(true);
    expect(engine.snapshotFor('p1').turnPlayerId).toBe('p1');
  });

  it('2 人局：换牌视为过牌 → 直接轮末（对方摸 1 张并起新回合）', () => {
    const hands2 = {
      p0: [byRank(3, 1)[0]!, ...byRank(9, 4)],
      p1: [byRank(4, 1)[0]!, byRank(5, 1)[0]!, ...byRank(10, 3)], // 企鹅：♠4♠5 同花色
    };
    const engine = mkEngine(hands2, { p1: csChampion });
    expect(engine.playCards('p0', [hands2.p0[0]!.id]).ok).toBe(true); // p0 起单3
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const r3 = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [hands2.p1[0]!.id, hands2.p1[1]!.id] }); // ♠4♠5
    const askChoice = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(askChoice?.kind).toBe('choice');
    const r3b = engine.resolveAsk('p1', { askId: askChoice!.askId!, choice: '换 1 张' });
    const ask3 = r3b.ok ? (r3b.pendingAsk as SkillAsk) : null;
    const r4 = engine.resolveAsk('p1', { askId: ask3!.askId!, targetPlayerId: 'p0' });
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    const takeId = ask4!.cards![0]!.id;
    const a = engine.resolveAsk('p1', { askId: ask4!.askId!, cardIds: [takeId] });
    expect(a.ok).toBe(true);
    const events = a.ok ? a.events : [];
    expect(events.some((e) => e.type === 'round:ended')).toBe(true); // 换完直接轮末，无需 p0 再点过
    const snap = engine.snapshotFor('p1');
    expect(snap.table).toBeNull(); // 新回合开始
    expect(snap.turnPlayerId).toBe('p0'); // 最后出牌者 p0 摸 1 张并起新回合
    expect(snap.players[0]!.handCount).toBe(6); // 4 - 1 + 2 + 1（轮末摸）
    expect(snap.players[1]!.handCount).toBe(4); // 5 - 2 + 1
  });

  it('3 人局：中间人已过 → 换牌后直接轮末（出牌者摸 1 张并起新回合）', () => {
    const hands3 = {
      p0: [byRank(3, 1)[0]!, ...byRank(9, 4)],
      p1: byRank(13, 5), // 中间人无牌可接 → 过
      p2: [byRank(4, 1)[0]!, byRank(5, 1)[0]!, ...byRank(10, 3)], // 企鹅
    };
    const engine = mkEngine(hands3, { p2: csChampion });
    expect(engine.playCards('p0', [hands3.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r1 = engine.useSkillAction('p2', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p2', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const r3 = engine.resolveAsk('p2', { askId: ask2!.askId!, cardIds: [hands3.p2[0]!.id, hands3.p2[1]!.id] }); // ♠4♠5
    const askChoice = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(askChoice?.kind).toBe('choice');
    const r3b = engine.resolveAsk('p2', { askId: askChoice!.askId!, choice: '换 1 张' });
    const ask3 = r3b.ok ? (r3b.pendingAsk as SkillAsk) : null;
    const r4 = engine.resolveAsk('p2', { askId: ask3!.askId!, targetPlayerId: 'p0' });
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    const takeId = ask4!.cards![0]!.id;
    const a = engine.resolveAsk('p2', { askId: ask4!.askId!, cardIds: [takeId] });
    expect(a.ok).toBe(true);
    const events = a.ok ? a.events : [];
    expect(events.some((e) => e.type === 'round:ended')).toBe(true); // p1 已过 + 换牌视为过 → 轮末
    const snap = engine.snapshotFor('p2');
    expect(snap.table).toBeNull();
    expect(snap.turnPlayerId).toBe('p0');
    expect(snap.players[0]!.handCount).toBe(6); // 4 - 1 + 2 + 1（轮末摸）
  });

  it('3 人局：中间人已接牌 → 换牌后轮到出牌者继续接（本轮不结束）', () => {
    const hands3 = {
      p0: [byRank(3, 1)[0]!, ...byRank(9, 4)], // 起 ♠3
      p1: [byRank(4, 1)[0]!, ...byRank(11, 4)], // 接 ♠4
      p2: [byRank(5, 1)[0]!, byRank(6, 1)[0]!, ...byRank(10, 3)], // 企鹅：♠5♠6
    };
    const engine = mkEngine(hands3, { p2: csChampion });
    expect(engine.playCards('p0', [hands3.p0[0]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [hands3.p1[0]!.id]).ok).toBe(true); // p1 接 ♠4
    const r1 = engine.useSkillAction('p2', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p2', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const r3 = engine.resolveAsk('p2', { askId: ask2!.askId!, cardIds: [hands3.p2[0]!.id, hands3.p2[1]!.id] }); // ♠5♠6
    const askChoice = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(askChoice?.kind).toBe('choice');
    const r3b = engine.resolveAsk('p2', { askId: askChoice!.askId!, choice: '换 1 张' });
    const ask3 = r3b.ok ? (r3b.pendingAsk as SkillAsk) : null;
    const r4 = engine.resolveAsk('p2', { askId: ask3!.askId!, targetPlayerId: 'p1' });
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    const takeId = ask4!.cards![0]!.id;
    const a = engine.resolveAsk('p2', { askId: ask4!.askId!, cardIds: [takeId] });
    expect(a.ok).toBe(true);
    const events = a.ok ? a.events : [];
    expect(events.some((e) => e.type === 'round:ended')).toBe(false); // 本轮未结束
    const snap = engine.snapshotFor('p2');
    expect(snap.turnPlayerId).toBe('p0'); // 轮到 p0 继续接 p1 的 ♠4
    expect(snap.table?.rank).toBe(4); // 桌面仍是 ♠4
  });

  it('同花色自选换 2 张：拿目标 2 张，手牌不足 2 张的玩家不进目标列表', () => {
    const hands3 = {
      p0: [byRank(3, 1)[0]!, ...byRank(9, 4)], // 起 ♠3，剩 4 张
      p1: [byRank(4, 1)[0]!, byRank(5, 1)[0]!, ...byRank(10, 3)], // 企鹅：♠4♠5
      p2: byRank(11, 1), // 只有 1 张：换 2 张时不应出现在目标列表
    };
    const engine = mkEngine(hands3, { p1: csChampion });
    expect(engine.playCards('p0', [hands3.p0[0]!.id]).ok).toBe(true);
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const r3 = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [hands3.p1[0]!.id, hands3.p1[1]!.id] }); // ♠4♠5 同花色
    const askChoice = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(askChoice?.kind).toBe('choice');
    const r3b = engine.resolveAsk('p1', { askId: askChoice!.askId!, choice: '换 2 张' });
    const ask3 = r3b.ok ? (r3b.pendingAsk as SkillAsk) : null;
    expect(ask3?.kind).toBe('pickTarget');
    expect(ask3?.targetCandidates).toEqual(['p0']); // p2 只有 1 张，被排除
    const r4 = engine.resolveAsk('p1', { askId: ask3!.askId!, targetPlayerId: 'p0' });
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    expect(ask4?.min).toBe(2);
    const a = engine.resolveAsk('p1', {
      askId: ask4!.askId!,
      cardIds: [ask4!.cards![0]!.id, ask4!.cards![1]!.id],
    });
    expect(a.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players[1]!.handCount).toBe(5); // 5 - 2 + 2
    expect(snap.players[0]!.handCount).toBe(4); // 4 - 2 + 2
    expect(snap.turnPlayerId).toBe('p2'); // 换完轮下家
  });

  it('选目标阶段弃权：技能作废，下次发动可重新走完整流程', () => {
    const engine = mkEngine(hands, { p1: csChampion });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    // 第一次：走到选目标阶段后弃权
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const r3 = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] }); // ♠4♠5
    const askChoice = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    const r3b = engine.resolveAsk('p1', { askId: askChoice!.askId!, choice: '换 1 张' });
    const ask3 = r3b.ok ? (r3b.pendingAsk as SkillAsk) : null;
    expect(ask3?.kind).toBe('pickTarget');
    const r4 = engine.resolveAsk('p1', { askId: ask3!.askId!, choice: 'decline' }); // 选目标阶段弃权
    expect(r4.ok).toBe(true);
    expect(engine.snapshotFor('p1').turnPlayerId).toBe('p1'); // 轮次不变
    // 第二次：完整走通（中间态已清，不会被上一次卡死）
    const s1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const a1 = s1.ok ? (s1.pendingAsk as SkillAsk) : null;
    const s2 = engine.resolveAsk('p1', { askId: a1!.askId!, choice: 'yes' });
    const a2 = s2.ok ? (s2.pendingAsk as SkillAsk) : null;
    const s3 = engine.resolveAsk('p1', { askId: a2!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] });
    const aChoice = s3.ok ? (s3.pendingAsk as SkillAsk) : null;
    const s3b = engine.resolveAsk('p1', { askId: aChoice!.askId!, choice: '换 1 张' });
    const a3 = s3b.ok ? (s3b.pendingAsk as SkillAsk) : null;
    const s4 = engine.resolveAsk('p1', { askId: a3!.askId!, targetPlayerId: 'p0' });
    const a4 = s4.ok ? (s4.pendingAsk as SkillAsk) : null;
    const s5 = engine.resolveAsk('p1', { askId: a4!.askId!, cardIds: [a4!.cards![0]!.id] });
    expect(s5.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players[1]!.handCount).toBe(4); // 5 - 2 + 1：交换执行成功
  });
});
