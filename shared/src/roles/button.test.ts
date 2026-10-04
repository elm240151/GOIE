import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import button from './button';
import fishy from './fishy';
import guoTT from './guo-tt';

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

/** 用 range 内未被使用的牌把各手牌补到 targets 张 */
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

/** 牌守恒：手牌 + 桌面 + 桌旁展示（翻面牌）+ 展示区 + 牌堆 + 弃牌堆 = 162 */
function assertConserved(engine: GameEngine): void {
  const snap = engine.snapshotFor('p0');
  const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
  expect(
    handCards + (snap.table?.cards.length ?? 0) + snap.tableSide.length + snap.revealed.length + snap.deckCount + snap.discardCount
  ).toBe(162);
}

describe('轴承：端庄（翻面接牌）', () => {
  it('情况一：翻掉整手单张接上一手（恰好大一级），翻面牌以牌背展示（tableSideHidden）', () => {
    const hands = {
      p0: [deck[1]!, deck[15]!, deck[4]!, deck[5]!], // 轴承：♠4 ♥5 ♠7 ♠8
      p1: [deck[2]!, deck[6]!], // ♠5 ♠9
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button });

    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 起单 ♠4
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true); // ♠5 压（上一手 ♠4）
    // 翻面接牌：出 ♠7（不是恰好大一级）→ 失败，桌面不变
    const bad = engine.playCards('p0', [hands.p0[2]!.id], hands.p1[0]!.id);
    expect(bad.ok).toBe(false);
    expect((bad as { reason: string }).reason).toContain('压不过上一手的牌');

    const r = engine.playCards('p0', [hands.p0[1]!.id], hands.p1[0]!.id); // 翻 ♠5 出 ♥5（接上一手 ♠4）
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'cards:played' && e.combo.type === 'single' && e.combo.rank === 5)).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.type).toBe('single');
    expect(snap.table?.rank).toBe(5);
    expect(snap.prevTable?.type).toBe('single');
    expect(snap.prevTable?.rank).toBe(4); // 上一手仍是 ♠4
    expect(snap.tableSide.map((c) => c.id)).toEqual([hands.p1[0]!.id]); // 翻面的 ♠5 留桌旁
    expect(snap.tableSideHidden).toEqual([hands.p1[0]!.id]); // 以牌背展示（其余玩家可见翻面）
    expect(snap.discardCount).toBe(1); // 被压掉的 ♠4
    expect(snap.turnPlayerId).toBe('p1');
    assertConserved(engine);
  });

  it('情况一：桌面只有这一手牌（无上一手）→ 无法发动', () => {
    const hands = {
      p0: [deck[3]!, deck[4]!], // 轴承：♠6 ♠7
      p1: [deck[2]!, deck[1]!], // ♠5 ♠4（起牌者）
      p2: byRank(3, 4), // 全程过牌（3 压不了 5）
    };
    pad(hands, { p0: 8, p1: 8, p2: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button }, 'p1');

    engine.playCards('p1', [hands.p1[0]!.id]); // 起单 ♠5
    engine.pass('p2');
    const r = engine.playCards('p0', [hands.p0[0]!.id], hands.p1[0]!.id); // 翻 ♠5 出 ♠6
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('只有这一手');
  });

  it('情况二：对5 翻一张 → 剩单5 → 单6 接（正常管牌规则）', () => {
    const hands = {
      p0: [deck[1]!, deck[14]!, deck[3]!, deck[4]!], // 轴承：♠4 ♥4 ♠6 ♠7
      p1: [deck[2]!, deck[15]!], // ♠5 ♥5
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button });

    engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 起对 4
    engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 对 5 压
    const r = engine.playCards('p0', [hands.p0[2]!.id], hands.p1[0]!.id); // 翻 ♠5 → 剩单 ♥5 → 单 6 接
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.type).toBe('single');
    expect(snap.table?.rank).toBe(6);
    expect(snap.prevTable?.type).toBe('single');
    expect(snap.prevTable?.rank).toBe(5); // 上一手 = 剩余单 ♥5
    expect(snap.tableSide.map((c) => c.id)).toEqual([hands.p1[0]!.id]);
    expect(snap.tableSideHidden).toEqual([hands.p1[0]!.id]);
    expect(snap.discardCount).toBe(3); // 对 4 + 剩余 ♥5
    assertConserved(engine);
  });

  it('情况二：345 翻 4 → 剩 35 非法 → 后继 67（翻面接），之后只有炸弹能压', () => {
    const hands = {
      p0: [deck[0]!, deck[1]!, deck[2]!, deck[3]!, deck[4]!], // 轴承：♠3♠4♠5♠6♠7
      p1: [deck[55]!, deck[56]!, deck[57]!, deck[5]!, deck[60]!, deck[73]!, deck[99]!], // ♠4♠5♠6 ♠8 ♠9♥9♦9
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button });

    engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]); // 起 345
    engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]); // 456 压
    const r = engine.playCards('p0', [hands.p0[3]!.id, hands.p0[4]!.id], hands.p1[0]!.id); // 翻 ♠4 → 剩 56 非法 → 后继 67
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'cards:played' && e.combo.type === 'gap' && e.combo.label === '翻面接 67')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.type).toBe('gap');
    expect(snap.table?.rank).toBe(7);
    expect(snap.prevTable).toBeNull(); // 剩余 56 不是合法牌型
    expect(snap.tableSideHidden).toEqual([hands.p1[0]!.id]);
    expect(snap.discardCount).toBe(5); // 345 + 剩余 ♠5♠6
    expect(snap.turnPlayerId).toBe('p1');
    assertConserved(engine);

    // 后继桌面只有炸弹能压：单 8 失败、炸弹 999 成功
    const bad = engine.playCards('p1', [hands.p1[3]!.id]);
    expect(bad.ok).toBe(false);
    expect((bad as { reason: string }).reason).toContain('只有炸弹');
    const bomb = engine.playCards('p1', [hands.p1[4]!.id, hands.p1[5]!.id, hands.p1[6]!.id]);
    expect(bomb.ok).toBe(true);
    const snap2 = engine.snapshotFor('p0');
    expect(snap2.table?.type).toBe('bomb');
    expect(snap2.prevTable?.type).toBe('gap'); // 上一手 = 翻面接（记录为 gap）
    assertConserved(engine);
  });

  it('情况二：剩余非法 → 炸弹直接响应（不走后继）', () => {
    const hands = {
      p0: [deck[0]!, deck[1]!, deck[2]!, deck[19]!, deck[32]!, deck[45]!], // 轴承：♠345 + ♥9♣9♦9
      p1: [deck[55]!, deck[56]!, deck[57]!], // ♠456
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button });

    engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]);
    engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]);
    const r = engine.playCards('p0', [hands.p0[3]!.id, hands.p0[4]!.id, hands.p0[5]!.id], hands.p1[0]!.id); // 翻 ♠4 炸 999
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.type).toBe('bomb');
    expect(snap.table?.rank).toBe(9);
    expect(snap.prevTable).toBeNull();
    expect(snap.tableSideHidden).toEqual([hands.p1[0]!.id]);
    assertConserved(engine);
  });

  it('翻面接出的后继桌面 ≥3 张同样触发橐驼地坛（按张数算，询问含翻面接牌型）', () => {
    const hands = {
      p0: byRank(13, 4), // 全程过牌
      p1: [deck[0]!, deck[1]!, deck[2]!, deck[3]!, deck[15]!, deck[17]!, deck[18]!], // 轴承：♠3456 + ♥5♥7♥8
      p2: [deck[55]!, deck[56]!, deck[57]!, deck[58]!], // 橐驼：♠4567
    };
    pad(hands, { p0: 8, p1: 8, p2: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p1: button, p2: guoTT }, 'p1');

    const lead = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id, hands.p1[3]!.id]); // 起 3456
    expect(lead.ok && lead.suspended).toBe(true); // 地坛询问橐驼
    const ask1 = lead.ok ? (lead.pendingAsk as SkillAsk) : null;
    expect(ask1?.kind).toBe('confirm');
    expect(engine.pendingAskPlayerId).toBe('p2');
    engine.resolveAsk('p2', { askId: ask1!.askId!, choice: 'decline' });

    const play2 = engine.playCards('p2', [hands.p2[0]!.id, hands.p2[1]!.id, hands.p2[2]!.id, hands.p2[3]!.id]); // 4567（自己打出不判定）
    expect(play2.ok && !play2.suspended).toBe(true);
    engine.pass('p0');
    const r = engine.playCards('p1', [hands.p1[4]!.id, hands.p1[5]!.id, hands.p1[6]!.id], hands.p2[1]!.id); // 翻 ♠5 → 剩 467 → 后继 578
    expect(r.ok && r.suspended).toBe(true); // 3 张 → 地坛再次询问（按张数算）
    const ask2 = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('confirm');
    expect(engine.pendingAskPlayerId).toBe('p2');
    expect(ask2?.prompt).toContain('翻面接 578');
    const d = engine.resolveAsk('p2', { askId: ask2!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    // 挂起期间的事件随解答结果下发
    expect(d.ok && d.events.some((e) => e.type === 'cards:played' && e.combo.type === 'gap' && e.combo.label === '翻面接 578')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.type).toBe('gap');
    expect(snap.turnPlayerId).toBe('p2');
    assertConserved(engine);
  });

  it('留 2 禁止收尾同样适用于翻面接牌：翻面接单 2 打完手牌 → 拒绝', () => {
    const hands = {
      p0: [deck[5]!, deck[12]!], // 轴承：♠8 ♠2（出完 ♠2 即空手）
      p1: [deck[6]!], // ♠9
    };
    pad(hands, { p0: 2, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button });

    engine.playCards('p0', [hands.p0[0]!.id]); // 起单 ♠8
    engine.playCards('p1', [hands.p1[0]!.id]); // ♠9 压（恰好大一级）
    const r = engine.playCards('p0', [hands.p0[1]!.id], hands.p1[0]!.id); // 翻 ♠9 出 ♠2（打完手牌）
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('不能以单 2');
  });

  it('倒序（海棠洄游）：后继同样 = 点数 +1（345 翻 4 剩 35 → 后继 46，不镜像）', () => {
    const hands = {
      p0: [deck[16]!, deck[14]!, deck[13]!], // 轴承：♥6 ♥4 ♥3
      p1: [deck[0]!, deck[1]!, deck[2]!], // 海棠：♠345
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button, p1: fishy }, 'p1');

    engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]); // 起 345 → 洄游切倒序
    expect(engine.snapshotFor('p0').orderReversed).toBe(true);

    // 翻 4 → 剩 35 → 后继 46（倒序同样 +1，与正序一致）
    const r = engine.playCards('p0', [hands.p0[1]!.id, hands.p0[0]!.id], hands.p1[1]!.id);
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'cards:played' && e.combo.type === 'gap' && e.combo.label === '翻面接 46')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.type).toBe('gap');
    expect(snap.table?.rank).toBe(6);
    expect(snap.orderReversed).toBe(true);
    expect(snap.tableSideHidden).toEqual([hands.p1[1]!.id]);
    expect(snap.discardCount).toBe(2); // 剩余 ♠3♠5
    assertConserved(engine);
  });

  it('倒序：剩余合法时按倒序镜像接牌（对2 翻一张 → 剩单2 → A 响应 2，与正序对称）', () => {
    const hands = {
      p0: [deck[11]!, deck[3]!, deck[4]!], // 轴承：♠A ♠6 ♠7
      p1: [deck[12]!, deck[25]!], // 海棠：♠2 ♥2（对2）
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button, p1: fishy }, 'p1');

    engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 起对 2 → 洄游切倒序
    expect(engine.snapshotFor('p0').orderReversed).toBe(true);

    const r = engine.playCards('p0', [hands.p0[0]!.id], hands.p1[0]!.id); // 翻 ♠2 → 剩单 ♥2 → 倒序 A 响应 2
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.type).toBe('single');
    expect(snap.table?.rank).toBe(14); // A
    expect(snap.tableSideHidden).toEqual([hands.p1[0]!.id]);
    expect(snap.orderReversed).toBe(true);
    assertConserved(engine);
  });

  it('守卫：非轴承不能翻面；起牌时不能发动端庄', () => {
    const hands = {
      p0: [deck[2]!, deck[3]!], // 轴承：♠5 ♠6
      p1: [deck[6]!, deck[5]!], // ♠9 ♠8（普通玩家）
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button });

    const lead = engine.playCards('p0', [hands.p0[0]!.id], 999); // 起牌带 flippedCardId
    expect(lead.ok).toBe(false);
    expect((lead as { reason: string }).reason).toContain('起牌时不能发动');
    engine.playCards('p0', [hands.p0[0]!.id]); // 正常起 ♠5
    const r = engine.playCards('p1', [hands.p1[0]!.id], hands.p0[0]!.id); // p1 想翻面
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('端庄');
  });
});

describe('轴承：窃笑（私密查看手牌）', () => {
  it('轮到自己时查看一名玩家手牌（查看者收到手牌、被查看者收到提示），本轮再次使用被拒', () => {
    const hands = {
      p0: [deck[2]!, deck[3]!, deck[4]!, deck[5]!], // 轴承：♠5♠6♠7♠8
      p1: byRank(10, 4), // ♠10♥10♣10♦10
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button });

    const r = engine.useSkillAction('p0', { skillId: 'qie-xiao' });
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('pickTarget');
    expect(ask?.targetCandidates).toEqual(['p1']);

    const p1HandIds = engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.hand!.map((c) => c.id).sort();
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, targetPlayerId: 'p1' });
    expect(a.ok).toBe(true);
    const peek = a.ok ? a.events.find((e) => e.type === 'skill:peek') : undefined;
    expect(peek).toBeDefined();
    if (peek && peek.type === 'skill:peek') {
      expect(peek.viewerId).toBe('p0');
      expect(peek.targetId).toBe('p1');
      expect(peek.cards.map((c) => c.id).sort()).toEqual(p1HandIds); // 私密事件携带对方完整手牌
    }
    expect(a.ok && a.events.some((e) => e.type === 'skill:peeked' && e.viewerId === 'p0' && e.targetId === 'p1')).toBe(true);

    const again = engine.useSkillAction('p0', { skillId: 'qie-xiao' }); // 本轮已用
    expect(again.ok).toBe(false);
    expect((again as { reason: string }).reason).toContain('本轮已经使用过');
  });

  it('弃权不消耗；轮末重置后新回合可再次窃笑', () => {
    const hands = {
      p0: [deck[2]!, deck[3]!, deck[4]!, deck[5]!], // 轴承：♠5♠6♠7♠8
      p1: byRank(10, 4),
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: button });

    // 弃权不消耗：两次询问都可发起
    const r1 = engine.useSkillAction('p0', { skillId: 'qie-xiao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'decline' });
    const r2 = engine.useSkillAction('p0', { skillId: 'qie-xiao' });
    expect(r2.ok && r2.suspended).toBe(true);
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    engine.resolveAsk('p0', { askId: ask2!.askId!, targetPlayerId: 'p1' }); // 本轮消耗

    // 出完这一轮 → 轮末重置
    engine.playCards('p0', [hands.p0[0]!.id]); // 起单 ♠5
    engine.pass('p1');
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0'); // p0 获牌权，摸 1 起新回合

    // 新回合：窃笑可再次使用
    const r3 = engine.useSkillAction('p0', { skillId: 'qie-xiao' });
    expect(r3.ok && r3.suspended).toBe(true);
    const ask3 = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(ask3?.kind).toBe('pickTarget');
    engine.resolveAsk('p0', { askId: ask3!.askId!, choice: 'decline' });
    assertConserved(engine);
  });
});
