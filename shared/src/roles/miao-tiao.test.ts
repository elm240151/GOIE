import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import miaoTiao from './miao-tiao';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

const deck = buildDeck(3);

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

/** 用 range 内未被使用的牌把各手牌补到 targets 张（已满的手跳过） */
function pad(hands: Record<string, Card[]>, targets: Record<string, number>, range: [number, number]): void {
  const used = new Set<number>();
  for (const h of Object.values(hands)) for (const c of h) used.add(c.id);
  const order = Object.keys(targets);
  let i = 0;
  for (let id = range[0]; id <= range[1]; id++) {
    if (used.has(id)) continue;
    for (let k = 0; k < order.length; k++) {
      const pid = order[(i + k) % order.length]!;
      if (hands[pid]!.length >= targets[pid]!) continue;
      hands[pid]!.push(deck[id]!);
      i = (i + k + 1) % order.length;
      break;
    }
  }
}

/** 牌守恒：手牌（含扣置）+ 桌面 + 展示区 + 边牌 + 牌堆 + 弃牌堆 = 162 */
function assertConserved(engine: GameEngine): void {
  const snap = engine.snapshotFor('p0');
  const handCards = snap.players.reduce((x, p) => x + p.handCount + p.heldCount, 0);
  expect(handCards + (snap.table?.cards.length ?? 0) + snap.revealed.length + snap.tableSide.length + snap.deckCount + snap.discardCount + snap.stagedDiscards.reduce((x, e) => x + e.cards.length, 0)).toBe(162);
}

function ask(engine: GameEngine): SkillAsk {
  const a = engine.snapshotFor('p0').pendingAsk;
  expect(a).not.toBeNull();
  return a as unknown as SkillAsk;
}

/** 开局扣置流程：确认 → 选类型 → 选牌（返回扣置后的手牌/扣置张数） */
function holdAt(engine: GameEngine, kind: '范文（至多 4 张花色互不相同）' | '尖叫鸡（至多 3 张花色相同）', ids: number[]) {
  const c = ask(engine);
  expect(c.prompt).toContain('尖叫');
  const yes = engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' });
  const kindAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
  expect(kindAsk?.kind).toBe('choice');
  const k = engine.resolveAsk('p0', { askId: kindAsk!.askId!, choice: kind });
  const pick = k.ok ? (k.pendingAsk as SkillAsk) : null;
  expect(pick?.kind).toBe('pickCards');
  expect(engine.resolveAsk('p0', { askId: pick!.askId!, cardIds: ids }).ok).toBe(true);
}

describe('苗条：苗条技 + 尖叫', () => {
  it('苗条技：打出 n 种花色摸 n 张（王双计：小王 ♠♣ + ♠5 = 2 种）', () => {
    const hands = {
      p0: [deck[2]!, deck[3]!, deck[52]!, deck[4]!], // ♠5 ♠6 小王 ♠7
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 过牌
    };
    pad(hands, { p0: 8, p1: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: miaoTiao });
    expect(engine.resolveAsk('p0', { askId: ask(engine).askId!, choice: 'decline' }).ok).toBe(true); // 尖叫弃权

    // 对 55（小王当 ♠5）：小王 ♠♣ + ♠5 ♠ = 2 种花色 → 摸 2
    const r = engine.playCards('p0', [hands.p0[2]!.id, hands.p0[0]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'miao-tiao')).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(8); // 8 − 2 + 2

    expect(engine.pass('p1').ok).toBe(true); // 2 人局过即轮末，苗条持牌权再摸 1
    expect(engine.resolveAsk('p0', { askId: ask(engine).askId!, choice: 'decline' }).ok).toBe(true); // 新回合开始的尖叫弃权
    const r2 = engine.playCards('p0', [hands.p0[1]!.id]); // ♠6：1 种花色 → 摸 1
    expect(r2.ok && r2.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'miao-tiao')).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(9); // 9 − 1 + 1
    assertConserved(engine);
  });

  it('尖叫范文 + 亡语：打光手牌时自动收回全部扣置牌，不获胜', () => {
    const hands = {
      p0: [deck[4]!, deck[2]!, deck[16]!], // ♠7 + 扣置 ♠5 ♥6 → 手牌只剩 ♠7
      p1: [deck[5]!, deck[18]!], // ♠8 ♥8
    };
    const engine = mkEngine(hands, { p0: miaoTiao });
    holdAt(engine, '范文（至多 4 张花色互不相同）', [hands.p0[1]!.id, hands.p0[2]!.id]);
    let snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.heldCount).toBe(2);
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(1);

    const r = engine.playCards('p0', [hands.p0[0]!.id]); // ♠7 打光手牌
    expect(r.ok).toBe(true);
    // 亡语门控：苗条技（非亡语）不触发
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'miao-tiao')).toBe(false);
    // 尖叫（亡语）：自动收回全部 → 手牌非空 → 不获胜
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'jian-jiao')).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing');
    expect(snap.winnerId).toBeNull();
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(2);
    expect(snap.players.find((p) => p.id === 'p0')!.heldCount).toBe(0);

    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true); // 无扣置可触发
    assertConserved(engine);
  });

  it('尖叫范文分次触发：打出被扣花色即摸回对应牌，剩余继续等下一个打出者', () => {
    const hands = {
      p0: [deck[4]!, deck[17]!, deck[2]!, deck[16]!], // ♠7 ♥7 + 扣置 ♠5 ♥6
      p1: [deck[5]!, deck[18]!], // ♠8 ♥8
    };
    const engine = mkEngine(hands, { p0: miaoTiao });
    holdAt(engine, '范文（至多 4 张花色互不相同）', [hands.p0[2]!.id, hands.p0[3]!.id]);

    engine.playCards('p0', [hands.p0[0]!.id]); // ♠7：打出 ♠ → 摸回 ♠5（自己打出的也算）
    let snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(3); // ♥7 + 苗条技摸 1 + 摸回 ♠5
    expect(snap.players.find((p) => p.id === 'p0')!.heldCount).toBe(1); // ♥6 继续等

    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true); // ♠8 压：♠ 已无扣置
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(1);
    expect(engine.pass('p0').ok).toBe(true); // 苗条压不了 8（摸到的是王，无 9）
    // 轮末：p1 持牌权 → 新回合开始：已有扣置牌（♥6 未收回）→ 不再询问
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    // 领出 ♥8 → 打出 ♥ → 摸回 ♥6（发给实际打出者）
    expect(engine.playCards('p1', [hands.p1[1]!.id]).ok).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(2); // 轮末摸 1 + 摸回 ♥6
    expect(snap.players.find((p) => p.id === 'p0')!.heldCount).toBe(0);
    assertConserved(engine);
  });

  it('尖叫鸡一次发完 + 亡语：打光手牌的这手牌触发 → 摸回全部 3 张、不能即刻获胜', () => {
    const hands = {
      p0: [deck[5]!, deck[44]!, deck[2]!, deck[6]!, deck[10]!], // ♠8 ♦8 + 扣置 ♠5 ♠9 ♠K
      p1: [deck[60]!], // ♠9（唯一手牌；deck2 ♠9 = 54 + 6）
    };
    const engine = mkEngine(hands, { p0: miaoTiao });
    holdAt(engine, '尖叫鸡（至多 3 张花色相同）', [hands.p0[2]!.id, hands.p0[3]!.id, hands.p0[4]!.id]);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.heldCount).toBe(3);

    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // ♠8：点数 8 不在被扣点数
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // ♠9 压：唯一手牌打光
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'jian-jiao')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing'); // 亡语：摸回后手牌非空，不获胜
    expect(snap.winnerId).toBeNull();
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(3);
    expect(snap.players.find((p) => p.id === 'p0')!.heldCount).toBe(0);
    assertConserved(engine);
  });

  it('尖叫收回主动技：任意时刻（非自己回合）可部分/全部收回', () => {
    const hands = {
      p0: [deck[4]!, deck[6]!, deck[16]!, deck[29]!], // ♠7 ♠9 + 扣置 ♥6 ♣6
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 过牌
    };
    const engine = mkEngine(hands, { p0: miaoTiao });
    holdAt(engine, '范文（至多 4 张花色互不相同）', [hands.p0[2]!.id, hands.p0[3]!.id]);

    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // ♠7 领出 → 轮到 p1
    // 非苗条回合（anyTime）：部分收回 ♥6
    const r1 = engine.useSkillAction('p0', { skillId: 'jian-jiao', cardIds: [hands.p0[2]!.id] });
    expect(r1.ok).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(3);
    expect(snap.players.find((p) => p.id === 'p0')!.heldCount).toBe(1);
    // 全部收回
    const r2 = engine.useSkillAction('p0', { skillId: 'jian-jiao' });
    expect(r2.ok).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(4);
    expect(snap.players.find((p) => p.id === 'p0')!.heldCount).toBe(0);
    assertConserved(engine);
  });

  it('扣置牌也算手牌：手牌 + 扣置 > 20 → 轮末摸牌触发淘汰', () => {
    const hands = {
      p0: [deck[4]!, deck[16]!, deck[29]!], // ♠7 + 扣置 ♥6 ♣6（20 张满手）
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 过牌
    };
    pad(hands, { p0: 20, p1: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: miaoTiao });
    holdAt(engine, '范文（至多 4 张花色互不相同）', [hands.p0[1]!.id, hands.p0[2]!.id]);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(18);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.heldCount).toBe(2);

    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // ♠7（♠ 不匹配被扣 ♥/♣）→ 苗条技 +1
    expect(engine.pass('p1').ok).toBe(true); // 轮末：苗条摸 1 张 → 手牌 19 + 扣置 2 = 21 > 20 → 淘汰
    const snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.eliminated).toBe(true);
    expect(snap.phase).toBe('finished'); // 2 人局剩 1 人
    expect(snap.winnerId).toBe('p1');
    assertConserved(engine);
  });

  it('尖叫次数每局 X+2 次；弃权不消耗；用尽后回合开始不再询问', () => {
    const hands = {
      p0: [deck[12]!], // ♠2 领出
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 过牌
    };
    pad(hands, { p0: 12, p1: 4 }, [109, 159]); // p0 拿到 109-119（♠4-♠A）供各轮领出
    const engine = mkEngine(hands, { p0: miaoTiao });

    // 轮 1：弃权不消耗 → 领出 ♠2 过轮
    expect(engine.resolveAsk('p0', { askId: ask(engine).askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    // 轮 2-5：每次扣 1 张尖叫鸡（共 4 次 = X+2）→ 收回（扣置牌跨回合保留，不收回下轮不再询问）→ 领出过轮
    const heldIds = [109, 111, 113, 115]; // ♠4 ♠6 ♠8 ♠10（扣置）
    const leadIds = [110, 112, 114, 116]; // ♠5 ♠7 ♠9 ♠J（领出）
    for (let round = 0; round < 4; round++) {
      holdAt(engine, '尖叫鸡（至多 3 张花色相同）', [deck[heldIds[round]!]!.id]);
      expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.heldCount).toBe(1);
      expect(engine.useSkillAction('p0', { skillId: 'jian-jiao' }).ok).toBe(true); // 收回全部
      expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.heldCount).toBe(0);
      expect(engine.playCards('p0', [deck[leadIds[round]!]!.id]).ok).toBe(true);
      expect(engine.pass('p1').ok).toBe(true);
    }
    // 轮 6：次数用尽 → 回合开始不再询问
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    assertConserved(engine);
  });

  it('已有扣置牌（跨回合保留）→ 回合开始不再询问；收回后下轮恢复询问；别人可见类型不可见牌面', () => {
    const hands = {
      p0: [deck[4]!, deck[2]!, deck[6]!, deck[16]!, deck[29]!], // ♠7 ♠5 ♠9 ♥6 ♣6
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 过牌
    };
    const engine = mkEngine(hands, { p0: miaoTiao });
    holdAt(engine, '范文（至多 4 张花色互不相同）', [hands.p0[3]!.id, hands.p0[4]!.id]); // 扣 ♥6 ♣6
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.heldCount).toBe(2);
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // ♠7 领出：♠ 不匹配被扣花色 → 保留
    expect(engine.pass('p1').ok).toBe(true);
    // 轮 2：苗条起牌——已有扣置牌 → 不再询问
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    // 别人视角：heldGroups 公开类型 + 张数；held 牌面只对苗条自己可见
    let snap = engine.snapshotFor('p1');
    const p0p = snap.players.find((p) => p.id === 'p0')!;
    expect(p0p.heldCount).toBe(2);
    expect(p0p.held).toBeNull();
    expect(p0p.heldGroups).toEqual([{ kind: 'fanwen', count: 2 }]);
    // 收回（anyTime）→ 领出过轮
    expect(engine.useSkillAction('p0', { skillId: 'jian-jiao' }).ok).toBe(true);
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true); // ♠5 领出
    expect(engine.pass('p1').ok).toBe(true);
    // 轮 3：扣置已收回 → 恢复询问
    const c = ask(engine);
    expect(c.kind).toBe('confirm');
    expect(engine.resolveAsk('p0', { askId: c.askId!, choice: 'decline' }).ok).toBe(true);
    assertConserved(engine);
  });

  it('非法提交不消耗次数：提示重新选牌（重发询问），成功扣置才消耗', () => {
    const hands = {
      p0: [deck[4]!, deck[2]!, deck[3]!, deck[16]!], // ♠7 ♠5 ♠6 ♥6（♠5♠6 同花色 → 范文非法）
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 过牌
    };
    pad(hands, { p0: 12, p1: 4 }, [109, 159]); // p0 补 8 张供后续轮扣置/领出
    const engine = mkEngine(hands, { p0: miaoTiao });
    const c = ask(engine);
    const yes = engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' });
    const kindAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(kindAsk?.kind).toBe('choice');
    const k = engine.resolveAsk('p0', { askId: kindAsk!.askId!, choice: '范文（至多 4 张花色互不相同）' });
    const pick = k.ok ? (k.pendingAsk as SkillAsk) : null;
    expect(pick?.kind).toBe('pickCards');
    // 非法提交：♠5 ♠6 花色相同 → 播报提示 + 重发选牌询问，次数不消耗
    const r1 = engine.resolveAsk('p0', { askId: pick!.askId!, cardIds: [hands.p0[1]!.id, hands.p0[2]!.id] });
    expect(r1.ok).toBe(true);
    expect(r1.ok && r1.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'jian-jiao')).toBe(true);
    const again = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    expect(again?.kind).toBe('pickCards');
    expect(again?.prompt).toContain('重新选择');
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.heldCount).toBe(0);
    // 重新提交合法：♠5 ♥6 花色互异 → 成功扣置
    const r2 = engine.resolveAsk('p0', { askId: again!.askId!, cardIds: [hands.p0[1]!.id, hands.p0[3]!.id] });
    expect(r2.ok).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.heldCount).toBe(2);
    // 非法提交没消耗次数：2 人局 X+2 = 4 次，还能成功扣 3 次（轮 2-4），轮 5 不再询问
    expect(engine.useSkillAction('p0', { skillId: 'jian-jiao' }).ok).toBe(true); // 收回
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // ♠7 领出过轮
    expect(engine.pass('p1').ok).toBe(true);
    const heldIds = [109, 111, 113]; // ♠4 ♠6 ♠8（扣置）
    const leadIds = [110, 112, 114]; // ♠5 ♠7 ♠9（领出）
    for (let round = 0; round < 3; round++) {
      holdAt(engine, '尖叫鸡（至多 3 张花色相同）', [deck[heldIds[round]!]!.id]);
      expect(engine.useSkillAction('p0', { skillId: 'jian-jiao' }).ok).toBe(true); // 收回
      expect(engine.playCards('p0', [deck[leadIds[round]!]!.id]).ok).toBe(true);
      expect(engine.pass('p1').ok).toBe(true);
    }
    // 次数用尽（成功扣置恰好 4 次）→ 不再询问
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    assertConserved(engine);
  });
});
