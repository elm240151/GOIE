import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import doggie from './doggie';
import guoTT from './guo-tt';
import kingNan from './king-nan';
import yyXue from './yy-xue';

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

/** 牌堆顶（handsOverride 后牌堆保持升序，顶 = 最大未用 id；revealTop 从尾部取） */
function deckTopOf(hands: Record<string, Card[]>): Card {
  const used = new Set<number>();
  for (const h of Object.values(hands)) for (const c of h) used.add(c.id);
  let top: Card | undefined;
  for (const c of deck) if (!used.has(c.id)) top = c;
  return top!;
}

/** 用 range 内未被使用的牌把各手牌补到 targets 张（把牌堆顶推到指定牌：顶 = range 之下最大的未用牌） */
function pad(hands: Record<string, Card[]>, targets: Record<string, number>, range: [number, number]): void {
  const used = new Set<number>();
  for (const h of Object.values(hands)) for (const c of h) used.add(c.id);
  const order = Object.keys(targets);
  let i = 0;
  for (let id = range[0]; id <= range[1]; id++) {
    if (used.has(id)) continue;
    // 找下一个还有空位的手牌（跳过已满的）
    for (let k = 0; k < order.length; k++) {
      const pid = order[(i + k) % order.length]!;
      if (hands[pid]!.length >= targets[pid]!) continue;
      hands[pid]!.push(deck[id]!);
      i = (i + k + 1) % order.length;
      break;
    }
  }
}

/** 牌守恒：手牌 + 桌面 + 展示区 + 牌堆 + 弃牌堆 = 162 */
function assertConserved(engine: GameEngine): void {
  const snap = engine.snapshotFor('p0');
  const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
  expect(handCards + (snap.table?.cards.length ?? 0) + snap.revealed.length + snap.deckCount + snap.discardCount + snap.stagedDiscards.reduce((x, e) => x + e.cards.length, 0)).toBe(162);
}

describe('楠王：旺旺（亡语）+ 回味', () => {
  it('亡语：压牌者打光手牌 → 旺旺判定成功 → 摸 3 张无法获胜，游戏继续（判定牌弃置、牌守恒）', () => {
    const hands = {
      p0: [deck[6]!, deck[8]!, deck[161]!, deck[160]!], // 楠王：♠9 ♠J 大王 小王（小王补位把牌堆顶推到 159）
      p1: [deck[7]!], // ♠10：最后一张，压楠王的 ♠9
      p2: byRank(13, 4), // 全程过牌
    };
    pad(hands, { p0: 8, p1: 1, p2: 8 }, [109, 158]); // 牌堆顶 = 159 ♦2（非红桃）
    expect(deckTopOf(hands).id).toBe(159);
    const engine = mkEngine(hands, { p0: kingNan });

    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 起单 ♠9
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // ♠10 压之（打光手牌）
    expect(r.ok && r.suspended).toBe(true); // 亡语：获胜判定之前仍询问
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('玩家1');

    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wang-wang' && /成功/.test(e.text))).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'cards:revealed')).toBe(true); // 判定牌公开
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing'); // 没有获胜
    expect(snap.winnerId).toBeNull();
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(3); // 进入成功班 +3
    expect(snap.revealed).toHaveLength(0); // 判定牌一律弃置
    expect(snap.turnPlayerId).toBe('p2'); // 正常轮转
    expect(snap.table?.rank).toBe(10); // 桌面仍是 ♠10
    assertConserved(engine);
  });

  it('旺旺判定失败（翻到大王按 ♥♦ 算红桃）：不加牌；发动即消耗，同轮再被压不再询问', () => {
    const hands = {
      p0: [deck[6]!, deck[8]!, deck[159]!, deck[160]!], // 楠王：♠9 ♠J（♦2 小王补位把牌堆顶推到 161）
      p1: [deck[7]!, deck[9]!], // ♠10 ♠Q
      p2: byRank(13, 4),
    };
    pad(hands, { p0: 8, p1: 8, p2: 8 }, [109, 158]); // 牌堆顶 = 161 大王（红桃）
    expect(deckTopOf(hands).id).toBe(161);
    const engine = mkEngine(hands, { p0: kingNan });

    engine.playCards('p0', [hands.p0[0]!.id]); // ♠9
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]); // ♠10 压（手牌还剩）
    expect(r1.ok && r1.suspended).toBe(true);
    const ask = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wang-wang' && /失败/.test(e.text))).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(7); // 8 − 1，没加牌
    expect(snap.revealed).toHaveLength(0); // 判定牌弃置

    engine.pass('p2');
    engine.playCards('p0', [hands.p0[1]!.id]); // ♠J
    const r2 = engine.playCards('p1', [hands.p1[1]!.id]); // ♠Q 压 → 本回合已消耗，不再询问
    expect(r2.ok && !r2.suspended).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p2');
  });

  it('旺旺判定失败 + 压牌者打光 → 照常获胜（亡语是机会，不是保证）', () => {
    const hands = {
      p0: [deck[6]!, deck[8]!, deck[159]!, deck[160]!], // 楠王（♦2 小王补位把牌堆顶推到 161）
      p1: [deck[7]!], // 打光
      p2: byRank(13, 4),
    };
    pad(hands, { p0: 8, p1: 1, p2: 8 }, [109, 158]); // 牌堆顶 = 161 大王（红桃）
    expect(deckTopOf(hands).id).toBe(161);
    const engine = mkEngine(hands, { p0: kingNan });

    engine.playCards('p0', [hands.p0[0]!.id]);
    const r = engine.playCards('p1', [hands.p1[0]!.id]);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wang-wang' && /失败/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1'); // 判定失败 → 压牌者照常获胜
  });

  it('弃权不消耗：同轮下一次被压仍询问，判定成功 +3', () => {
    const hands = {
      p0: [deck[6]!, deck[8]!, deck[161]!, deck[14]!], // ♠9 ♠J 大王 ♥4
      p1: [deck[7]!, deck[9]!], // ♠10 ♠Q
      p2: byRank(13, 4),
    };
    pad(hands, { p0: 8, p1: 8, p2: 8 }, [109, 159]); // 牌堆顶 = 160 小王（♠♣，非红桃）
    expect(deckTopOf(hands).id).toBe(160);
    const engine = mkEngine(hands, { p0: kingNan });

    engine.playCards('p0', [hands.p0[0]!.id]); // ♠9
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]); // ♠10 压 → 询问
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'decline' }); // 弃权不消耗
    expect(a.ok).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(7);

    engine.pass('p2');
    engine.playCards('p0', [hands.p0[1]!.id]); // ♠J
    const r2 = engine.playCards('p1', [hands.p1[1]!.id]); // ♠Q 压 → 同轮再次询问（弃权未消耗）
    expect(r2.ok && r2.suspended).toBe(true);
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const b = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' }); // 翻到小王（♠♣）→ 成功
    expect(b.ok && b.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wang-wang' && /成功/.test(e.text))).toBe(true);
    // 8 − 2 + 回味 1（楠王 ♠J 压 ♠10 时被压者 p1 +1）+ 旺旺 3 = 10
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(10);
  });

  it('每回合限一次：轮末重置后新回合再被压重新询问', () => {
    const hands = {
      p0: [deck[6]!, deck[8]!, deck[161]!, deck[14]!], // 楠王：♠9 ♠J 大王 ♥4
      p1: [deck[7]!, deck[22]!, deck[23]!], // ♠10 ♥Q ♥K
      p2: [deck[36]!, deck[49]!, deck[35]!, deck[48]!], // ♣K ♦K ♣Q ♦Q 全程过牌
    };
    pad(hands, { p0: 8, p1: 8, p2: 8 }, [109, 159]); // 牌堆顶 = 160 小王（非红桃）
    expect(deckTopOf(hands).id).toBe(160);
    const engine = mkEngine(hands, { p0: kingNan });

    // 回合 1：判定成功（消耗）
    engine.playCards('p0', [hands.p0[0]!.id]); // ♠9
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]); // ♠10 压 → 询问
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'yes' }); // 成功 +3
    engine.pass('p2');
    engine.playCards('p0', [hands.p0[1]!.id]); // ♠J
    const r2 = engine.playCards('p1', [hands.p1[1]!.id]); // ♥Q 压 → 本回合已消耗，不再询问
    expect(r2.ok && !r2.suspended).toBe(true);
    engine.pass('p2');
    // p0 用 ♠K 压 ♥Q（pad 牌 118）→ 之后 p1 用刚摸到的 ♦2（159）压 ♠K：同样触发条件但已消耗 → 不询问
    const snap0 = engine.snapshotFor('p0');
    const p0k = snap0.players.find((p) => p.id === 'p0')!;
    engine.playCards('p0', [p0k.hand!.find((c) => c.rank === 13)!.id]); // ♠K
    engine.pass('p2');
    const r3 = engine.playCards('p1', [engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.hand!.find((c) => c.rank === 15)!.id]); // ♦2 压 ♠K
    expect(r3.ok && !r3.suspended).toBe(true); // 本回合已消耗 → 不再询问
    engine.pass('p2');
    engine.pass('p0'); // 压不了 ♦2 → 轮末 p1 摸 1 起新回合

    // 回合 2：p1 起 ♥3 → p0 压 ♥4 → p1 用 ♠5 压 → 重新询问（重置生效）
    const snap1 = engine.snapshotFor('p1');
    const p1h = snap1.players.find((p) => p.id === 'p1')!;
    engine.playCards('p1', [p1h.hand!.find((c) => c.rank === 3)!.id]); // ♥3
    engine.pass('p2');
    const p0h = engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!;
    engine.playCards('p0', [p0h.hand!.find((c) => c.rank === 4 && c.suit === 1)!.id]); // ♥4 压 ♥3
    const r4 = engine.playCards('p1', [engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.hand!.find((c) => c.rank === 5 && c.suit === 0)!.id]); // ♠5 压 ♥4
    expect(r4.ok && r4.suspended).toBe(true); // 新回合 → 再次询问
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    expect(ask4?.kind).toBe('confirm');
    engine.resolveAsk('p0', { askId: ask4!.askId!, choice: 'decline' });
  });

  it('回味：炸弹 3×8 压对 5 → 点数差 14 封顶 +3（对子恰好大一级，对 8 压不了对 5）', () => {
    const hands = {
      p0: byRank(8, 3), // 楠王：3×8 炸弹
      p1: byRank(5, 2), // ♠5♥5
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: kingNan }, 'p1');

    engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 起对 5
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]); // 炸弹压（对 8 压不了对 5，只有炸弹可跨级）
    expect(r.ok && !r.suspended).toBe(true); // 锁定技不询问
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei' && /摸 3 张/.test(e.text))).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(9); // 8 − 2 + 3
  });

  it('回味：456 压 345 → 点数差 3；单 2 压单 A → 2 记 2、A 记 1，差 1', () => {
    // 两人局：p1 起牌后轮次直接回到 p0（三人局起牌后是下下家，p0 的压牌会出局）
    const h1 = {
      p0: [deck[14]!, deck[15]!, deck[16]!], // 楠王：♥4♥5♥6
      p1: [deck[0]!, deck[1]!, deck[2]!], // ♠345
    };
    pad(h1, { p0: 8, p1: 8 }, [109, 159]);
    const e1 = mkEngine(h1, { p0: kingNan }, 'p1');
    e1.playCards('p1', [h1.p1[0]!.id, h1.p1[1]!.id, h1.p1[2]!.id]); // 345
    const r1 = e1.playCards('p0', [h1.p0[0]!.id, h1.p0[1]!.id, h1.p0[2]!.id]); // 456
    expect(r1.ok && r1.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei' && /摸 3 张/.test(e.text))).toBe(true);

    const h2 = {
      p0: [deck[12]!], // 楠王：♠2
      p1: [deck[11]!], // ♠A
    };
    pad(h2, { p0: 8, p1: 8 }, [109, 159]);
    const e2 = mkEngine(h2, { p0: kingNan }, 'p1');
    e2.playCards('p1', [h2.p1[0]!.id]); // 单 A
    const r2 = e2.playCards('p0', [h2.p0[0]!.id]); // 单 2 压 → |2 − 1| = 1
    expect(r2.ok && r2.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei' && /摸 1 张/.test(e.text))).toBe(true);
    expect(e2.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(8); // 8 − 1 + 1
  });

  it('回味：王当百搭按所当点数（♥4♥5小王 = 456 压 345 → +3）；炸弹压橐驼单王 → 单王视为无穷 +3', () => {
    const h1 = {
      p0: [deck[14]!, deck[15]!, deck[52]!], // 楠王：♥4 ♥5 小王（456，王当 6）
      p1: [deck[0]!, deck[1]!, deck[2]!],
    };
    pad(h1, { p0: 8, p1: 8 }, [109, 159]);
    const e1 = mkEngine(h1, { p0: kingNan }, 'p1');
    e1.playCards('p1', [h1.p1[0]!.id, h1.p1[1]!.id, h1.p1[2]!.id]); // 345
    const r1 = e1.playCards('p0', [h1.p0[0]!.id, h1.p0[1]!.id, h1.p0[2]!.id]); // ♥4♥5王 = 456
    expect(r1.ok && r1.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei' && /摸 3 张/.test(e.text))).toBe(true);

    const h2 = {
      p0: byRank(3, 3), // 楠王：3×3 炸弹
      p1: [deck[52]!], // 橐驼：单王
    };
    pad(h2, { p0: 8, p1: 8 }, [109, 159]);
    const e2 = mkEngine(h2, { p0: kingNan, p1: guoTT }, 'p1');
    e2.playCards('p1', [h2.p1[0]!.id]); // 单王
    const r2 = e2.playCards('p0', [h2.p0[0]!.id, h2.p0[1]!.id, h2.p0[2]!.id]); // 炸弹压王（同时触发橐驼地坛）
    expect(r2.ok && r2.suspended).toBe(true); // 地坛询问挂起（挂起期间的事件随解答结果下发）
    const dtAsk = r2.ok ? (r2.pendingAsk as SkillAsk | null) : null; // 地坛询问（橐驼）收尾弃权
    expect(dtAsk?.kind).toBe('confirm');
    const d = e2.resolveAsk('p1', { askId: dtAsk!.askId!, choice: 'decline' });
    expect(d.ok && d.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei' && /摸 3 张/.test(e.text))).toBe(true); // 单王无穷 → 差必封顶 3
    expect(e2.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(10); // 8 − 1 + 3
  });

  it('回味：起牌不触发；压牌获胜时回味（非亡语）不触发——打完牌那一刻游戏就结束了（2026-10-05 亡语定稿）', () => {
    const h1 = {
      p0: [deck[6]!, deck[8]!, deck[161]!], // 楠王
      p1: [deck[7]!, deck[22]!],
      p2: byRank(13, 4),
    };
    pad(h1, { p0: 8, p1: 8, p2: 8 }, [109, 159]);
    const e1 = mkEngine(h1, { p0: kingNan });
    const lead = e1.playCards('p0', [h1.p0[0]!.id]); // 起单 ♠9
    expect(lead.ok).toBe(true);
    expect(lead.ok && lead.events.some((e) => e.type === 'skill:triggered' && (e.skillId === 'hui-wei' || e.skillId === 'wang-wang'))).toBe(false); // 起牌不触发

    const h2 = {
      p0: [deck[14]!], // 楠王：♥4（最后一张）
      p1: [deck[13]!], // ♥3
    };
    pad(h2, { p0: 1, p1: 8 }, [109, 159]);
    const e2 = mkEngine(h2, { p0: kingNan }, 'p1');
    e2.playCards('p1', [h2.p1[0]!.id]); // ♥3
    const r = e2.playCards('p0', [h2.p0[0]!.id]); // ♥4 压（打光）
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei')).toBe(false); // 非亡语：打光不再触发
    const snap = e2.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0'); // 楠王照常获胜
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(7); // 8 − 1，没有被回味摸牌
  });

  it('回味只对楠王压牌生效：修勾狂吠压自己的牌不触发（2026-10-05 用户实机 bug：每手狂吠都触发回味）', () => {
    const hands = {
      p0: [deck[2]!], // 楠王：♠5 起牌
      p1: [deck[3]!, deck[4]!], // 修勾：♠6 压楠王的牌、♠7 狂吠压自己的 ♠6
    };
    pad(hands, { p0: 8, p1: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: kingNan, p1: doggie });

    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 起 ♠5（起牌不触发）
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // ♠6 压楠王的牌 → 旺旺询问（压的是楠王，正常）
    expect(r.ok && r.suspended).toBe(true);
    const ww = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ww?.kind).toBe('confirm');
    const d = engine.resolveAsk('p0', { askId: ww!.askId!, choice: 'decline' }); // 旺旺弃权
    expect(d.ok && d.suspended).toBe(true); // 修勾狂吠询问
    const kf = d.ok ? (d.pendingAsk as SkillAsk) : null;
    expect(kf?.kind).toBe('selfFollow');
    const a = engine.resolveAsk('p1', { askId: kf!.askId!, choice: 'yes', cardIds: [hands.p1[1]!.id] }); // ♠7 压自己的 ♠6
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei')).toBe(false); // 自己压自己不触发回味
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.rank).toBe(7); // 桌面是狂吠的 ♠7
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(6); // 8 − 2，没有被回味摸牌
    assertConserved(engine);
  });

  it('回味只对楠王压牌生效：其他玩家压牌不触发被压者摸牌（afterPlay 对全场每个角色都跑）', () => {
    const hands = {
      p0: byRank(9, 1), // 楠王：♠9（可压但选择过）
      p1: byRank(6, 1), // ♠6 压 p2 的 ♠5
      p2: byRank(5, 1), // ♠5 起牌
    };
    pad(hands, { p0: 8, p1: 8, p2: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: kingNan }, 'p2');

    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true); // p2 起 ♠5
    engine.pass('p0'); // 楠王过牌
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // ♠6 压 ♠5（压牌者不是楠王）
    expect(r.ok && !r.suspended).toBe(true); // 楠王的牌没被压：旺旺不询问
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei')).toBe(false); // 压牌者不是楠王：回味不触发
    const snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p2')!.handCount).toBe(7); // 8 − 1，没有被回味摸牌
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(7); // 8 − 1
    assertConserved(engine);
  });

  it('亡语同场顺序：旺旺先判成功 +3 → 巨石后判命中驱逐（压牌者淘汰、无人获胜、雪灾夺权）', () => {
    const hands = {
      p0: [deck[6]!, deck[8]!, deck[161]!], // 楠王：♠9 ♠J 大王
      p1: byRank(5, 3), // 炸弹 3×5（打光；炸弹触发巨石）
      p2: byRank(13, 4), // 雪灾
    };
    pad(hands, { p0: 8, p1: 3, p2: 8 }, [109, 158]); // 牌堆顶 = 160 小王
    expect(deckTopOf(hands).id).toBe(160);
    const engine = mkEngine(hands, { p0: kingNan, p2: yyXue });

    engine.playCards('p0', [hands.p0[0]!.id]); // ♠9
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]); // 炸弹（打光）
    expect(r.ok && r.suspended).toBe(true);
    const ask1 = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask1?.kind).toBe('confirm'); // 先问楠王（旺旺 priority 100）
    const a = engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'yes' });
    expect(a.ok && a.suspended).toBe(true); // 旺旺判定成功 +3 后，巨石接着问
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wang-wang' && /成功/.test(e.text))).toBe(true);
    const ask2 = a.ok ? (a.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('confirm'); // 2026-10-07：巨石先问是否发动
    const y = engine.resolveAsk('p2', { askId: ask2!.askId!, choice: 'yes' });
    expect(y.ok).toBe(true);
    const suit = y.ok ? (y.pendingAsk as SkillAsk) : null;
    expect(suit?.kind).toBe('suit');
    const d = engine.resolveAsk('p2', { askId: suit!.askId!, choice: '♦' }); // 旺旺翻走 160 后顶 = 156 ♦Q
    expect(d.ok).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'ju-shi')).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'player:eliminated' && e.playerId === 'p1')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing');
    expect(snap.winnerId).toBeNull(); // 亡语：谁都没赢
    expect(snap.players.find((p) => p.id === 'p1')!.eliminated).toBe(true); // 刚摸的 3 张一并进弃牌堆
    expect(snap.turnPlayerId).toBe('p2'); // 雪灾夺权
    expect(snap.revealed).toHaveLength(0);
    assertConserved(engine);
  });

  it('亡语同场顺序：旺旺弃权不阻断巨石（照常判定命中驱逐）', () => {
    const hands = {
      p0: [deck[6]!, deck[8]!, deck[161]!],
      p1: byRank(5, 3),
      p2: byRank(13, 4),
    };
    pad(hands, { p0: 8, p1: 3, p2: 8 }, [109, 158]); // 牌堆顶 = 160 小王
    const engine = mkEngine(hands, { p0: kingNan, p2: yyXue });

    engine.playCards('p0', [hands.p0[0]!.id]);
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]);
    const ask1 = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'decline' }); // 旺旺弃权
    expect(a.ok && a.suspended).toBe(true); // 巨石照常询问
    const ask2 = a.ok ? (a.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('confirm'); // 2026-10-07：巨石先问是否发动
    const y = engine.resolveAsk('p2', { askId: ask2!.askId!, choice: 'yes' });
    expect(y.ok).toBe(true);
    const suit = y.ok ? (y.pendingAsk as SkillAsk) : null;
    expect(suit?.kind).toBe('suit');
    const d = engine.resolveAsk('p2', { askId: suit!.askId!, choice: '♠' }); // 160 小王 ♠♣ → 命中
    expect(d.ok && d.events.some((e) => e.type === 'player:eliminated' && e.playerId === 'p1')).toBe(true);
    expect(engine.snapshotFor('p0').winnerId).toBeNull();
  });
});
