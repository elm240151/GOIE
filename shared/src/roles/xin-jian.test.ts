// 角色测试：辛歼 —— 技能【神秘】（锁定技）+【障目】（锁定技）。
// 【神秘】①独立牌堆 54 张（id 162..215、deck:3），摸空洗回自己的独立弃牌堆继续自己用
//   ②初始手牌自选（先手 5-7、非先手 4-6，超时默认 6/5）③轮末摸牌阶段自选摸 1 或 2（默认 1）
//   ④手牌数对别人隐藏（快照 -1，客户端显示 ??）⑤留 2 禁止收尾豁免（单 2/对 2 可收尾获胜）。
// 【障目】别人的指向性技能以辛歼为目标时先猜他的手牌数（1-20、超时算猜错）：
//   猜错 = 该次技能失效、不消耗次数、本回合不能再对其他人发动（对辛歼重试可再猜）；
//   猜中 = 技能照常生效 + 辛歼自选摸 1-3 张。
// 守恒口径 216：公共三副 162 + 辛歼独立牌堆/弃牌 54（辛歼从独立牌堆摸的牌会进入其手牌）。
import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import xinJian from './xin-jian';
import zuZhang from './zu-zhang';

const deck = buildDeck(3);

function mkEngine(
  hands: Record<string, Card[]>,
  roles: Record<string, RoleDef>,
  startPlayerId = 'p0',
  withOverride = true
) {
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
    handsOverride: withOverride ? hands : undefined,
  });
  engine.start();
  return engine;
}

/** 取当前挂起的完整询问（快照里的 pendingAsk 是精简版，完整 SkillAsk 用 currentAsk） */
function ask(engine: GameEngine): SkillAsk {
  const a = engine.snapshotFor('p0').pendingAsk;
  expect(a).not.toBeNull();
  const full = engine.currentAsk(a!.playerId);
  expect(full).not.toBeNull();
  return full!;
}

/** 守恒 216：公共三副 162 + 辛歼独立牌堆/弃牌 54（手牌用白盒真实张数，辛歼快照 handCount 对他人才是 -1） */
function assertConserved216(engine: GameEngine): void {
  const e = engine as unknown as {
    hands: Map<string, Card[]>;
    held: Map<string, { cards: Card[] }[]>;
    pancakes: Map<string, Card[]>;
    deck: Card[];
    discarded: Card[];
    privateDeck: Card[];
    privateDiscard: Card[];
  };
  const snap = engine.snapshotFor('p0');
  const hands = [...e.hands.values()].reduce((s, h) => s + h.length, 0);
  const held = [...e.held.values()].reduce((s, gs) => s + gs.reduce((x, g) => x + g.cards.length, 0), 0);
  const pancakes = [...e.pancakes.values()].reduce((s, cs) => s + cs.length, 0);
  expect(
    hands +
      held +
      pancakes +
      (snap.table?.cards.length ?? 0) +
      snap.revealed.length +
      snap.tableSide.length +
      e.deck.length +
      e.discarded.length +
      snap.stagedDiscards.reduce((x, se) => x + se.cards.length, 0) +
      e.privateDeck.length +
      e.privateDiscard.length
  ).toBe(216);
}

describe('辛歼：神秘 + 障目', () => {
  it('初始手牌自选（先手 6/5/7）：开局先问辛歼，按所选发牌', () => {
    const engine = mkEngine({ p0: [], p1: [], p2: [] }, { p0: xinJian }, 'p0', false);
    const a = ask(engine);
    expect(a.kind).toBe('choice');
    expect(a.options).toEqual(['6 张', '5 张', '7 张']);
    expect(engine.resolveAsk('p0', { askId: a.askId!, choice: '5 张' }).ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing');
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(5);
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(5); // 非先手 5 张
  });

  it('初始手牌自选（非先手 5/4/6）：按所选发牌，先手不受影响', () => {
    const engine = mkEngine({ p0: [], p1: [] }, { p1: xinJian }, 'p0', false);
    const a = ask(engine);
    expect(a.options).toEqual(['5 张', '4 张', '6 张']);
    expect(engine.resolveAsk('p1', { askId: a.askId!, choice: '4 张' }).ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(4);
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(6); // 先手 6 张
  });

  it('轮末摸牌阶段自选 1 或 2 张', () => {
    const hands = {
      p0: [deck[1]!, deck[11]!], // 辛歼：♠4 领出、♠A（防打光即胜）
      p1: [deck[2]!], // ♠5（自愿过）
      p2: [deck[0]!], // ♠3
    };
    const engine = mkEngine(hands, { p0: xinJian });
    expect(engine.playCards('p0', [deck[1]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    // 轮末：辛歼获得牌权 → 摸牌阶段引擎级询问
    const a = ask(engine);
    expect(a.kind).toBe('choice');
    expect(a.options).toEqual(['摸 1 张', '摸 2 张']);
    expect(engine.resolveAsk('p0', { askId: a.askId!, choice: '摸 2 张' }).ok).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(3); // 1 + 2
    assertConserved216(engine);
  });

  it('手牌数隐藏：别人看 -1、自己看实际值', () => {
    const hands = { p0: [deck[0]!], p1: [deck[1]!, deck[2]!] }; // p1 辛歼 2 张
    const engine = mkEngine(hands, { p1: xinJian });
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(-1);
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(2);
  });

  it('留 2 豁免：单 2 打完手牌正常获胜', () => {
    const hands = {
      p0: [deck[12]!], // 辛歼：♠2 一张
      p1: [deck[0]!, deck[1]!], // ♠3♠4
    };
    const engine = mkEngine(hands, { p0: xinJian });
    const r = engine.playCards('p0', [deck[12]!.id]);
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').phase).toBe('finished');
    expect(r.ok && r.events.some((e) => e.type === 'game:ended' && (e as { winnerId?: string }).winnerId === 'p0')).toBe(true);
  });

  it('留 2 豁免：对 2 打完手牌正常获胜', () => {
    const hands = {
      p0: [deck[12]!, deck[25]!], // 辛歼：♠2♥2
      p1: [deck[0]!, deck[1]!],
    };
    const engine = mkEngine(hands, { p0: xinJian });
    const r = engine.playCards('p0', [deck[12]!.id, deck[25]!.id]);
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').phase).toBe('finished');
    expect(r.ok && r.events.some((e) => e.type === 'game:ended' && (e as { winnerId?: string }).winnerId === 'p0')).toBe(true);
  });

  it('障目猜中：处分检讨照常生效 + 辛歼自选摸 2 张', () => {
    // 3 人局：p0 组长、p1 辛歼（压牌后手牌 1 张）、p2 路人
    const hands = {
      p0: [deck[0]!, deck[6]!], // 组长：♠3 领出、♠9 不用
      p1: [deck[1]!, deck[5]!], // 辛歼：♠4 压 ♠3、♠8 不用
      p2: [deck[2]!], // ♠5
    };
    const engine = mkEngine(hands, { p0: zuZhang, p1: xinJian });
    // 组长每轮开始的温柔询问先弃权
    const w = ask(engine);
    expect(w.prompt).toContain('温柔');
    expect(engine.resolveAsk('p0', { askId: w.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.playCards('p0', [deck[0]!.id]).ok).toBe(true); // 组长领出 ♠3
    expect(engine.playCards('p1', [deck[1]!.id]).ok).toBe(true); // 辛歼压 ♠4 → 处分询问
    const c = ask(engine);
    expect(c.prompt).toContain('处分');
    expect(engine.resolveAsk('p0', { askId: c.askId!, choice: '检讨：压牌者摸 2 张手牌' }).ok).toBe(true);
    // 障目：猜辛歼手牌数（压 ♠4 后剩 1 张）
    const g = ask(engine);
    expect(g.kind).toBe('guess');
    expect(engine.resolveAsk('p0', { askId: g.askId!, guess: 1 }).ok).toBe(true);
    // 猜中 → 辛歼自选摸 1-3
    const d = ask(engine);
    expect(d.kind).toBe('choice');
    expect(d.askPlayerId).toBe('p1');
    expect(engine.resolveAsk('p1', { askId: d.askId!, choice: '摸 2 张' }).ok).toBe(true);
    // 检讨效果照常：辛歼再摸 2 → 1 + 2 + 2 = 5
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(5);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(-1); // 对别人仍隐藏
    assertConserved216(engine);
  });

  it('障目猜错：技能失效不消耗 + 本回合再对其他人发动被封锁（4 人局）', () => {
    // p0 组长 [♠3,♠5,♠9]、p1 辛歼 [♠4,♠8]、p2 [♠6,♠J]、p3 [♠Q]
    const hands = {
      p0: [deck[0]!, deck[2]!, deck[6]!], // ♠3 ♠5 ♠9
      p1: [deck[1]!, deck[5]!], // ♠4 ♠8
      p2: [deck[3]!, deck[8]!], // ♠6 ♠J
      p3: [deck[9]!], // ♠Q
    };
    const engine = mkEngine(hands, { p0: zuZhang, p1: xinJian });
    // 温柔弃权 → 组长领出 ♠3
    const w1 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: w1.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.playCards('p0', [deck[0]!.id]).ok).toBe(true);
    // 辛歼压 ♠4 → 处分 → 检讨 → 障目猜 3（错，实际 1）→ 技能失效、无新询问
    expect(engine.playCards('p1', [deck[1]!.id]).ok).toBe(true);
    const c1 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c1.askId!, choice: '检讨：压牌者摸 2 张手牌' }).ok).toBe(true);
    const g1 = ask(engine);
    expect(g1.kind).toBe('guess');
    expect(engine.resolveAsk('p0', { askId: g1.askId!, guess: 3 }).ok).toBe(true);
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull(); // 猜错：无摸牌询问、无效果
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(1); // 没摸检讨的 2 张
    // p2 p3 过 → 组长压 ♠5 → p2 压 ♠6 压的是组长的牌 → 处分再触发：
    // 障目已封锁（本回合猜错后不能再对其他人发动）→ 无猜牌询问、检讨失效
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.pass('p3').ok).toBe(true);
    expect(engine.playCards('p0', [deck[2]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true); // 辛歼剩 ♠8 不能恰好大一级 → 过
    expect(engine.playCards('p2', [deck[3]!.id]).ok).toBe(true);
    const c2 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c2.askId!, choice: '检讨：压牌者摸 2 张手牌' }).ok).toBe(true);
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull(); // 封锁：无猜牌询问
    expect(engine.snapshotFor('p2').players.find((p) => p.id === 'p2')!.handCount).toBe(1); // p2 没摸检讨的 2 张
    assertConserved216(engine);
  });

  it('障目猜错后对辛歼重试可再猜：猜中则技能照常 + 自选摸 1-3（4 人局）', () => {
    // p0 组长 [♠3,♠5,♥K]、p1 辛歼 [♠4,♠6,♠K]、p2 [♠10]、p3 [♠9]（p0 留 ♥K 防打光即胜）
    const hands = {
      p0: [deck[0]!, deck[2]!, deck[23]!], // ♠3 ♠5 ♥K
      p1: [deck[1]!, deck[3]!, deck[10]!], // ♠4 ♠6 ♠K
      p2: [deck[7]!], // ♠10
      p3: [deck[6]!], // ♠9
    };
    const engine = mkEngine(hands, { p0: zuZhang, p1: xinJian });
    const w1 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: w1.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.playCards('p0', [deck[0]!.id]).ok).toBe(true);
    // 辛歼压 ♠4 → 处分 → 检讨 → 猜 3（错，实际 2）
    expect(engine.playCards('p1', [deck[1]!.id]).ok).toBe(true);
    const c1 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c1.askId!, choice: '检讨：压牌者摸 2 张手牌' }).ok).toBe(true);
    const g1 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: g1.askId!, guess: 3 }).ok).toBe(true);
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(2); // 没摸
    // p2 p3 过 → 组长压 ♠5 → 辛歼压 ♠6（手牌剩 1）→ 处分再触发：
    // 目标是辛歼 → 重试可再猜 → 猜 1 猜中 → 摸 2（障目）+ 检讨摸 2 = 5
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.pass('p3').ok).toBe(true);
    expect(engine.playCards('p0', [deck[2]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [deck[3]!.id]).ok).toBe(true);
    const c2 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c2.askId!, choice: '检讨：压牌者摸 2 张手牌' }).ok).toBe(true);
    const g2 = ask(engine);
    expect(g2.kind).toBe('guess'); // 重试可再猜
    expect(engine.resolveAsk('p0', { askId: g2.askId!, guess: 1 }).ok).toBe(true); // 猜中（♠6 打出后剩 1）
    const d2 = ask(engine);
    expect(d2.askPlayerId).toBe('p1');
    expect(engine.resolveAsk('p1', { askId: d2.askId!, choice: '摸 2 张' }).ok).toBe(true);
    // 1 + 2（障目）+ 2（检讨）= 5
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(5);
    assertConserved216(engine);
  });

  it('障目超时（答案无 guess）算猜错：技能失效、无摸牌询问', () => {
    const hands = {
      p0: [deck[0]!, deck[6]!], // 组长：♠3、♠9（防打光即胜）
      p1: [deck[1]!, deck[5]!], // 辛歼：♠4 压、♠8 不用
      p2: [deck[2]!],
    };
    const engine = mkEngine(hands, { p0: zuZhang, p1: xinJian });
    const w = ask(engine);
    expect(engine.resolveAsk('p0', { askId: w.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.playCards('p0', [deck[0]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [deck[1]!.id]).ok).toBe(true);
    const c = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c.askId!, choice: '检讨：压牌者摸 2 张手牌' }).ok).toBe(true);
    const g = ask(engine);
    // 模拟超时：engine 默认作答（无 guess）→ 按猜错处理
    expect(engine.resolveAsk('p0', { askId: g.askId!, guess: undefined }).ok).toBe(true);
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(1); // 未摸检讨的 2 张
  });

  it('独立弃牌：打出的私有牌进独立弃牌堆，公共弃牌堆不动', () => {
    // 白盒：把一张私有牌（id 162、deck:3）放进辛歼手牌（applyHandsOverride 会从独立牌堆扣除该 id，守恒 216）
    const privateCard: Card = { ...deck[0]!, id: 162, deck: 3 };
    const hands = {
      p0: [privateCard, deck[3]!], // 辛歼：领出私有 ♠3、♠6 留手
      p1: [deck[0]!, deck[1]!],
    };
    const engine = mkEngine(hands, { p0: xinJian });
    expect(engine.playCards('p0', [162]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true); // 自愿过
    const d = ask(engine);
    expect(engine.resolveAsk('p0', { askId: d.askId!, choice: '摸 1 张' }).ok).toBe(true); // 轮末收尾：桌面进弃牌堆
    const snap = engine.snapshotFor('p0');
    expect(snap.privateDiscardCount).toBe(1); // 私有牌进独立弃牌堆
    expect(snap.discardCount).toBe(0); // 公共弃牌堆不动
    assertConserved216(engine);
  });

  it('独立牌堆摸空洗回继续自己用（deck:recycled）', () => {
    const hands = {
      p0: [deck[1]!, deck[11]!], // 辛歼：♠4 领出、♠A 留手
      p1: [deck[0]!],
      p2: [deck[2]!],
    };
    const engine = mkEngine(hands, { p0: xinJian });
    const e = engine as unknown as { privateDeck: Card[]; privateDiscard: Card[] };
    // 白盒：把私有牌堆全部移到私有弃牌堆（模拟摸空）
    e.privateDiscard.push(...e.privateDeck);
    e.privateDeck = [];
    expect(engine.playCards('p0', [deck[1]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    const a = ask(engine);
    const r = engine.resolveAsk('p0', { askId: a.askId!, choice: '摸 1 张' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((ev) => ev.type === 'deck:recycled')).toBe(true); // 独立弃牌堆洗回
    const snap = engine.snapshotFor('p0');
    expect(snap.privateDeckCount).toBe(53); // 54 洗回摸 1
    expect(snap.privateDiscardCount).toBe(0);
    assertConserved216(engine);
  });
});
