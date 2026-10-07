import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import captain from './captain';
import doggie from './doggie';
import duoGe from './duo-ge';
import fishy from './fishy';
import miaoTiao from './miao-tiao';
import guoTT from './guo-tt';
import patrick from './patrick';
import yyXue from './yy-xue';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const pick = (r: number, s: number) => deck.find((c) => c.rank === r && c.suit === s)!;
const jokerSmall = deck.find((c) => c.rank === 16)!;
const jokerBig = deck.find((c) => c.rank === 17)!;

/** 同花色对子（副牌花色块状排列：byRank 第 0 与第 4 张同点数同花色、不同实体牌） */
const pairSameSuit = (r: number): [Card, Card] => {
  const c = byRank(r, 5);
  return [c[0]!, c[4]!];
};

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

const askOf = (r: { ok: boolean; pendingAsk?: SkillAsk }): SkillAsk | null => (r.ok ? (r.pendingAsk ?? null) : null);
const attributed = (r: { ok: boolean; events?: { type: string }[] }) =>
  r.ok && (r.events ?? []).some((e) => e.type === 'table:attributed');
const decline = (engine: GameEngine, by: string, ask: SkillAsk | null) => {
  expect(engine.resolveAsk(by, { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
};

describe('惰戈（亢奋/法音）', () => {
  it('亢奋：对K（26）打出那一刻归属惰戈，轮转从惰戈下家（原出牌者）继续，轮末牌权归惰戈', () => {
    const hands = {
      p0: byRank(7, 5),
      p1: [...pairSameSuit(13), pick(5, 0), pick(6, 0)], // 对K 同花色（不触发法音）
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe }, 'p1');
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r.ok).toBe(true);
    // 归属事件：从 p1 改写到惰戈 p0
    const ev = (
      r as { events: { type: string; fromPlayerId?: string; playerId?: string; combo?: { label?: string } }[] }
    ).events.find((e) => e.type === 'table:attributed')!;
    expect(ev.fromPlayerId).toBe('p1');
    expect(ev.playerId).toBe('p0');
    expect(ev.combo?.label).toBe('对K');
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1'); // 轮转从惰戈下家 = 原出牌者 p1
    // 原出牌者 p1 仍可接：p1、p2 过 → 轮转回 roundLastPlayerId（惰戈）时轮自动结束 → 牌权归惰戈
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.snapshotFor('p0').roundLeaderId).toBe('p0');
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
  });

  it('亢奋：对9（18）不触发，轮转照常从出牌者下家继续', () => {
    const hands = {
      p0: byRank(7, 5),
      p1: [...pairSameSuit(9), pick(5, 0)],
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe }, 'p1');
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r.ok).toBe(true);
    expect(attributed(r)).toBe(false);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p2'); // 出牌者 p1 的下家
  });

  it('亢奋阈值与牌面点数：对A（2）与对2（4）不触发，对10（20）触发（2 记 2、A 记 1）', () => {
    const cases: { hand: Card[]; expectAttr: boolean; label: string }[] = [
      { hand: pairSameSuit(14), expectAttr: false, label: '对A=2' },
      { hand: pairSameSuit(15), expectAttr: false, label: '对2=4' },
      { hand: pairSameSuit(10), expectAttr: true, label: '对10=20' },
    ];
    for (const c of cases) {
      const engine = mkEngine(
        { p0: byRank(7, 5), p1: [...c.hand, pick(5, 0)], p2: byRank(4, 5) },
        { p0: duoGe },
        'p1'
      );
      const r = engine.playCards('p1', [c.hand[0]!.id, c.hand[1]!.id]);
      expect(r.ok, c.label).toBe(true);
      expect(attributed(r), c.label).toBe(c.expectAttr);
    }
  });

  it('亢奋：王按所当点数计入（王+K=26 触发，王+9=18 不触发）；含王的牌型同时联动法音', () => {
    // 王+K：13+13=26 触发，且花色 {K♠, 王♠♣} ≥2 → 法音联动
    const hK = [pick(13, 0), jokerSmall, pick(5, 0)];
    const eK = mkEngine({ p0: byRank(7, 5), p1: hK, p2: byRank(4, 5) }, { p0: duoGe }, 'p1');
    const rK = eK.playCards('p1', [hK[0]!.id, hK[1]!.id]);
    expect(rK.ok).toBe(true);
    const askK = askOf(rK);
    expect(askK?.kind).toBe('confirm');
    expect(askK?.prompt).toContain('法音');
    // 挂起时事件缓冲，恢复后随最终结果一起返回：弃权法音后断言归属事件
    const a1K = eK.resolveAsk('p0', { askId: askK!.askId!, choice: 'decline' });
    expect(attributed(a1K)).toBe(true);
    expect(eK.snapshotFor('p0').turnPlayerId).toBe('p1'); // 轮转从惰戈下家
    // 王+9：9+9=18 不触发
    const h9 = [pick(9, 0), jokerSmall, pick(5, 0)];
    const e9 = mkEngine({ p0: byRank(7, 5), p1: h9, p2: byRank(4, 5) }, { p0: duoGe }, 'p1');
    const r9 = e9.playCards('p1', [h9[0]!.id, h9[1]!.id]);
    expect(r9.ok).toBe(true);
    expect(attributed(r9)).toBe(false);
    expect(askOf(r9)).toBeNull(); // roundLastPlayerId = p1 ≠ 惰戈，法音不触发
  });

  it('亢奋：橐驼单王/对王视为无穷，必触发（且王双花色联动法音）', () => {
    // 单王
    const hS = [jokerSmall, pick(5, 0)];
    const eS = mkEngine({ p0: byRank(7, 5), p1: hS, p2: byRank(4, 5) }, { p0: duoGe, p1: guoTT }, 'p1');
    const rS = eS.playCards('p1', [hS[0]!.id]);
    expect(rS.ok).toBe(true);
    const askS = askOf(rS);
    expect(askS?.prompt).toContain('法音'); // 单王 ♠♣ 双花色 → 法音联动
    const a1S = eS.resolveAsk('p0', { askId: askS!.askId!, choice: 'decline' });
    expect(attributed(a1S)).toBe(true);
    expect(eS.snapshotFor('p0').turnPlayerId).toBe('p1');
    // 对王
    const hP = [jokerSmall, jokerBig, pick(5, 0)];
    const eP = mkEngine({ p0: byRank(7, 5), p1: hP, p2: byRank(4, 5) }, { p0: duoGe, p1: guoTT }, 'p1');
    const rP = eP.playCards('p1', [hP[0]!.id, hP[1]!.id]);
    expect(rP.ok).toBe(true);
    const askP = askOf(rP);
    expect(askP?.prompt).toContain('法音');
    const a1P = eP.resolveAsk('p0', { askId: askP!.askId!, choice: 'decline' });
    expect(attributed(a1P)).toBe(true);
    expect(eP.snapshotFor('p0').turnPlayerId).toBe('p1');
  });

  it('亢奋：海棠出 ≥20 不切倒序（视为惰戈打出）；海棠自己 <20 的出牌照常切换', () => {
    const hands = {
      p0: byRank(7, 5),
      p1: [...pairSameSuit(13), ...pairSameSuit(14), pick(5, 0)], // 对K(26) + 对A(2)
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe, p1: fishy }, 'p1');
    const r1 = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r1.ok).toBe(true);
    expect(attributed(r1)).toBe(true);
    expect(engine.snapshotFor('p0').orderReversed).toBe(false); // 归属惰戈：海棠不切换
    // 轮转从惰戈下家 = p1（原出牌者）继续 → 海棠出对A（<20）→ 照常切换倒序
    const r2 = engine.playCards('p1', [hands.p1[2]!.id, hands.p1[3]!.id]);
    expect(r2.ok).toBe(true);
    expect(attributed(r2)).toBe(false);
    expect(engine.snapshotFor('p0').orderReversed).toBe(true);
  });

  it('亢奋：炸弹判定对惰戈生效——巨石询问驱逐对象是惰戈（法音先于巨石）', () => {
    const hands = {
      p0: byRank(7, 5),
      p1: [...byRank(6, 4), pick(5, 0)], // 炸 6666（24）
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe, p2: yyXue }, 'p1');
    const r = engine.playCards('p1', hands.p1.slice(0, 4).map((c) => c.id));
    expect(r.ok).toBe(true);
    const faYin = askOf(r);
    expect(faYin?.prompt).toContain('法音');
    const a1 = engine.resolveAsk('p0', { askId: faYin!.askId!, choice: 'decline' });
    expect(attributed(a1)).toBe(true); // 缓冲事件随第一次恢复一起返回（挂起期间 events 为空）
    const juShi = askOf(a1);
    expect(juShi?.kind).toBe('confirm'); // 2026-10-07：巨石先问是否发动
    expect(juShi?.prompt).toContain('驱逐 玩家0'); // 判定对象 = 惰戈（prompt 用玩家名，不用原始 id）
    const y = engine.resolveAsk('p2', { askId: juShi!.askId!, choice: 'yes' });
    const suit = askOf(y);
    expect(suit?.kind).toBe('suit');
    const a2 = engine.resolveAsk('p2', { askId: suit!.askId!, choice: 'decline' });
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1'); // 轮转从惰戈下家
  });

  it('亢奋：顺子判定对惰戈生效——地坛询问对象是惰戈', () => {
    const hands = {
      p0: byRank(7, 5),
      p1: [pick(3, 0), pick(4, 1), pick(5, 2), pick(6, 3), pick(7, 0), pick(8, 0)], // 34567（25）
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe, p2: guoTT }, 'p1');
    const r = engine.playCards('p1', hands.p1.slice(0, 5).map((c) => c.id));
    expect(r.ok).toBe(true);
    const faYin = askOf(r);
    const a1 = engine.resolveAsk('p0', { askId: faYin!.askId!, choice: 'decline' });
    expect(attributed(a1)).toBe(true); // 缓冲事件随第一次恢复一起返回（挂起期间 events 为空）
    const diTan = askOf(a1);
    expect(diTan?.prompt).toContain('玩家0'); // 惰戈名字
    expect(diTan?.prompt).toContain('地坛');
    const a2 = engine.resolveAsk('p2', { askId: diTan!.askId!, choice: 'decline' });
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1');
  });

  it('亢奋：打完手牌仍按实际出牌者获胜（对K 归属惰戈但 p1 获胜）', () => {
    const hands = {
      p0: byRank(7, 5),
      p1: pairSameSuit(13), // 整手 = 对K
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe }, 'p1');
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r.ok).toBe(true);
    expect(attributed(r)).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1'); // 谁打完谁赢：物理出牌者
  });

  it('亡语定稿（2026-10-05）：法音非亡语——惰戈打光最后手牌不询问，打完那一刻游戏就结束了', () => {
    const hands = {
      p0: [pick(4, 0), pick(5, 1), pick(6, 2)], // 惰戈：♠4♥5♦6 = 456（3 花色）= 全部手牌
      p1: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]); // 打光
    expect(r.ok && !r.suspended).toBe(true); // 法音不再询问
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
  });

  it('亢奋：惰戈被淘汰（手牌超 20）后失效', () => {
    const hands = {
      p0: [...byRank(3, 4), ...byRank(4, 4), ...byRank(5, 4), ...byRank(6, 4), ...byRank(7, 4), ...byRank(8, 1)], // 21 张
      p1: [...pairSameSuit(13), pick(5, 0)],
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe }, 'p1');
    expect(engine.snapshotFor('p0').players[0]!.eliminated).toBe(true); // 上限淘汰
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r.ok).toBe(true);
    expect(attributed(r)).toBe(false);
  });

  it('法音：完整流——确认 → 选目标（含自己）→ 被弃者自选弃一张（进弃牌堆，牌守恒）', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 1), pick(5, 2), pick(6, 3), pick(7, 0), pick(8, 1), pick(9, 2), pick(10, 3), pick(11, 0)],
      p1: byRank(5, 3),
      p2: byRank(4, 3),
    };
    const engine = mkEngine(hands, { p0: duoGe });
    const before = total(engine);
    const r = engine.playCards('p0', hands.p0.slice(0, 5).map((c) => c.id)); // 34567 四花色（25）
    expect(r.ok).toBe(true);
    expect(attributed(r)).toBe(false); // 惰戈自己出牌，不重复改写
    const confirm = askOf(r);
    expect(confirm?.prompt).toContain('法音');
    // 确认 → 选目标：自己手牌 4 > 3，候选含自己
    const a1 = engine.resolveAsk('p0', { askId: confirm!.askId!, choice: 'yes' });
    const pickT = askOf(a1);
    expect(pickT?.kind).toBe('pickTarget');
    expect(pickT?.targetCandidates).toEqual(['p0', 'p1', 'p2']);
    // 选 p1 → 问 p1 自选弃一张
    const a2 = engine.resolveAsk('p0', { askId: pickT!.askId!, targetPlayerId: 'p1' });
    const pickC = askOf(a2);
    expect(pickC?.kind).toBe('pickCards');
    expect(pickC?.askPlayerId).toBe('p1');
    expect(pickC?.cards).toHaveLength(3);
    // p1 弃一张 → 手牌 −1、弃牌堆 +1、播报、牌守恒
    const p1Hand = engine.snapshotFor('p1').players[1]!.hand!;
    const done = engine.resolveAsk('p1', { askId: pickC!.askId!, cardIds: [p1Hand[0]!.id] });
    expect(done.ok).toBe(true);
    expect(
      (done as { events: { type: string; text: string }[] }).events.some(
        (e) => e.type === 'skill:triggered' && /玩家1 弃置一张牌/.test(e.text)
      )
    ).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.players[1]!.handCount).toBe(2);
    // 弃牌暂存区（2026-10-06 用户规则）：p1 弃的牌本回合公开展示，轮末才进弃牌堆
    expect(snap.stagedDiscards).toEqual([{ playerId: 'p1', cards: [p1Hand[0]!] }]);
    expect(snap.discardCount).toBe(0);
    expect(askOf(done)).toBeNull(); // 流水线继续，无残留询问
    expect(total(engine)).toBe(before);
  });

  it('法音弃牌不可弃权（2026-10-06 用户确认）：declineAllowed=false，弃权/超时自动弃第一张', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 1), pick(5, 2), pick(6, 3), pick(7, 0), pick(8, 1), pick(9, 2), pick(10, 3), pick(11, 0)],
      p1: byRank(5, 3),
      p2: byRank(4, 3),
    };
    const engine = mkEngine(hands, { p0: duoGe });
    const r = engine.playCards('p0', hands.p0.slice(0, 5).map((c) => c.id)); // 34567 四花色（25）
    expect(r.ok).toBe(true);
    const confirm = askOf(r);
    const a1 = engine.resolveAsk('p0', { askId: confirm!.askId!, choice: 'yes' });
    const pickT = askOf(a1);
    const a2 = engine.resolveAsk('p0', { askId: pickT!.askId!, targetPlayerId: 'p1' });
    const pickC = askOf(a2);
    expect(pickC?.kind).toBe('pickCards');
    expect(pickC?.askPlayerId).toBe('p1');
    expect(pickC?.declineAllowed).toBe(false);
    // p1 弃权（模拟超时自动弃权）→ 引擎按默认作答：自动弃其第一张
    const done = engine.resolveAsk('p1', { askId: pickC!.askId!, choice: 'decline' });
    expect(done.ok).toBe(true);
    expect(
      (done as { events: { type: string; text: string }[] }).events.some(
        (e) => e.type === 'skill:triggered' && /玩家1 弃置一张牌/.test(e.text)
      )
    ).toBe(true);
    expect(engine.snapshotFor('p0').players[1]!.handCount).toBe(2); // 3 − 1
    expect(askOf(done)).toBeNull(); // 流水线继续，无残留询问
  });

  it('空手判胜（2026-10-06 用户定稿）：法音弃置目标最后一张牌 → 目标立即获胜（不看来因）', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 1), pick(5, 2), pick(6, 3), pick(7, 0), pick(8, 1)], // 惰戈：34567 四花色 + 闲牌
      p1: [pick(9, 0)], // 目标：唯一手牌
      p2: byRank(5, 3),
    };
    const engine = mkEngine(hands, { p0: duoGe });
    const r = engine.playCards('p0', hands.p0.slice(0, 5).map((c) => c.id)); // 34567 四花色（25）→ 法音
    const confirm = askOf(r);
    expect(confirm?.prompt).toContain('法音');
    const a1 = engine.resolveAsk('p0', { askId: confirm!.askId!, choice: 'yes' });
    const pickT = askOf(a1);
    const a2 = engine.resolveAsk('p0', { askId: pickT!.askId!, targetPlayerId: 'p1' });
    const pickC = askOf(a2);
    expect(pickC?.kind).toBe('pickCards');
    expect(pickC?.askPlayerId).toBe('p1');
    const done = engine.resolveAsk('p1', { askId: pickC!.askId!, cardIds: [hands.p1[0]!.id] });
    expect(done.ok).toBe(true);
    // 被弃者手牌归零 → 空手判胜（同吐饼「不看来因」口径）：立即终局
    const snap = engine.snapshotFor('p0');
    expect(snap.players[1]!.handCount).toBe(0);
    expect(snap.stagedDiscards).toEqual([{ playerId: 'p1', cards: [hands.p1[0]!] }]); // 终局也保留在暂存区公开可见
    expect(snap.discardCount).toBe(0);
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1');
  });

  it('空手判胜：苗条手牌被法音弃光但有扣置 → 不判胜（扣置牌也算手牌），可主动收回', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 1), pick(5, 2), pick(6, 3), pick(7, 0), pick(8, 1)], // 惰戈：34567 四花色
      p1: [pick(8, 0), pick(9, 0), pick(12, 0)], // 苗条：♠9 手牌 + 扣置 ♠8 ♠2（点数不在 34567，不摸回）
      p2: byRank(6, 3),
    };
    const engine = mkEngine(hands, { p0: duoGe, p1: miaoTiao });
    // 开局尖叫询问：苗条（p1）扣置 ♠8 ♠2（尖叫鸡：同花色）
    const c = engine.snapshotFor('p0').pendingAsk as SkillAsk | null;
    expect(c?.prompt).toContain('尖叫');
    const yes = engine.resolveAsk('p1', { askId: c!.askId!, choice: 'yes' });
    const kindAsk = askOf(yes);
    const k = engine.resolveAsk('p1', { askId: kindAsk!.askId!, choice: '尖叫鸡（至多 3 张花色相同）' });
    const pickH = askOf(k);
    expect(engine.resolveAsk('p1', { askId: pickH!.askId!, cardIds: [hands.p1[1]!.id, hands.p1[2]!.id] }).ok).toBe(true);
    expect(engine.snapshotFor('p0').players[1]!.heldCount).toBe(2);
    // 法音：弃置苗条唯一手牌 ♠9
    const r = engine.playCards('p0', hands.p0.slice(0, 5).map((c) => c.id));
    const confirm = askOf(r);
    const a1 = engine.resolveAsk('p0', { askId: confirm!.askId!, choice: 'yes' });
    const pickT = askOf(a1);
    const a2 = engine.resolveAsk('p0', { askId: pickT!.askId!, targetPlayerId: 'p1' });
    const pickC = askOf(a2);
    const done = engine.resolveAsk('p1', { askId: pickC!.askId!, cardIds: [hands.p1[0]!.id] });
    expect(done.ok).toBe(true);
    // 手牌 0 但扣置 2 → 空手判胜不成立（扣置牌也算手牌）；游戏继续
    let snap = engine.snapshotFor('p0');
    expect(snap.players[1]!.handCount).toBe(0);
    expect(snap.players[1]!.heldCount).toBe(2);
    expect(snap.phase).toBe('playing');
    expect(snap.winnerId).toBeNull();
    // 主动收回全部扣置牌 → 手牌 2，牌守恒
    expect(engine.useSkillAction('p1', { skillId: 'jian-jiao' }).ok).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.players[1]!.handCount).toBe(2);
    expect(snap.players[1]!.heldCount).toBe(0);
    expect(total(engine)).toBe(162);
  });

  it('法音：惰戈手牌 ≤3 时不能选自己（别人照常）', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 1), pick(5, 2), pick(6, 3), pick(7, 0)],
      p1: byRank(5, 3),
      p2: byRank(4, 3),
    };
    const engine = mkEngine(hands, { p0: duoGe });
    const r = engine.playCards('p0', hands.p0.slice(0, 4).map((c) => c.id)); // 3456（18）→ 剩 1 张 ≤3
    const confirm = askOf(r);
    expect(confirm?.prompt).toContain('法音');
    const a1 = engine.resolveAsk('p0', { askId: confirm!.askId!, choice: 'yes' });
    const pickT = askOf(a1);
    expect(pickT?.targetCandidates).toEqual(['p1', 'p2']); // 不含自己
    decline(engine, 'p0', pickT);
  });

  it('法音：单一花色不触发', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 0), pick(5, 0), pick(7, 0)], // 345 同花色（12）
      p1: byRank(5, 3),
      p2: byRank(4, 3),
    };
    const engine = mkEngine(hands, { p0: duoGe });
    const r = engine.playCards('p0', hands.p0.slice(0, 3).map((c) => c.id));
    expect(r.ok).toBe(true);
    expect(askOf(r)).toBeNull(); // 1 种花色：不询问
  });

  it('法音：无次数限制——每手符合条件的出牌都触发（两轮两次）', () => {
    const hands = {
      p0: [
        pick(3, 0), pick(4, 1), pick(5, 2), pick(6, 3), pick(7, 0),
        pick(4, 0), pick(5, 1), pick(6, 2), pick(7, 3), pick(8, 0),
      ],
      p1: byRank(5, 3),
      p2: byRank(4, 3),
    };
    const engine = mkEngine(hands, { p0: duoGe });
    const r1 = engine.playCards('p0', hands.p0.slice(0, 5).map((c) => c.id)); // 34567
    const ask1 = askOf(r1);
    expect(ask1?.prompt).toContain('法音');
    decline(engine, 'p0', ask1);
    // 全员过 → 轮转回 roundLastPlayerId（惰戈）时轮自动结束，牌权回惰戈 → 新一轮再出 45678
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.snapshotFor('p0').roundLeaderId).toBe('p0');
    const r2 = engine.playCards('p0', hands.p0.slice(5, 10).map((c) => c.id)); // 45678（30）
    const ask2 = askOf(r2);
    expect(ask2?.prompt).toContain('法音'); // 第二次仍触发
    decline(engine, 'p0', ask2);
  });

  it('亢奋：修勾出 ≥20 归属惰戈后无狂吠（狂吠看归属者），答疑照常可答', () => {
    const hands = {
      p0: byRank(7, 5),
      p1: [...pairSameSuit(13), pick(9, 0)], // 对K（26）
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe, p1: doggie }, 'p1');
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r.ok).toBe(true);
    // 修勾答疑（≥2 张牌型）会先问；无论如何狂吠 selfFollow 都不该出现（归属者惰戈无狂吠）
    let cur = r;
    for (let i = 0; i < 2; i++) {
      const ask = askOf(cur);
      expect(ask?.kind).not.toBe('selfFollow');
      if (!ask) break;
      cur = engine.resolveAsk('p1', { askId: ask.askId!, choice: 'decline' });
    }
    expect(askOf(cur)).toBeNull();
    expect(attributed(cur)).toBe(true); // 归属事件随最终恢复结果一起返回
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1'); // 轮转从惰戈下家（=原出牌者修勾）继续
  });

  it('亢奋：插队（无名）压归属惰戈的手——受害者是惰戈（摸 X 张），插队手点数和 <20 不归属', () => {
    const hands = {
      p0: [pick(7, 0), pick(7, 1)],
      p1: [...pairSameSuit(13), pick(9, 0)], // 对K（26）→ 归属惰戈
      p2: [pick(14, 0), pick(14, 1), pick(8, 0)], // 对A♠♥（恰好大一级压对K；A+A=2 <20 不触发亢奋）插队
    };
    const engine = mkEngine(hands, { p0: duoGe, p2: patrick }, 'p1');
    const r1 = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r1.ok).toBe(true);
    // 归属后挂起于插队询问（事件缓冲中）：attributeTable 已把轮转置为惰戈 p0
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
    const cut = askOf(r1);
    expect(cut?.kind).toBe('cutIn');
    const p0Before = engine.snapshotFor('p0').players[0]!.handCount;
    const r2 = engine.resolveAsk('p2', { askId: cut!.askId!, choice: 'yes', cardIds: hands.p2.slice(0, 2).map((c) => c.id) });
    expect(r2.ok).toBe(true);
    // 插队受害者 = 被压手归属者 = 惰戈：摸 X = 响应牌中与被压牌同花色（♠）的真牌点数总和
    // （A 记 1，2026-10-06 用户确认；A♠ = 1，A♥ 花色不符不计）
    expect(engine.snapshotFor('p0').players[0]!.handCount).toBe(p0Before + 1);
    // 轮转从插队者（无名）的下家继续——若插队手也归属惰戈则应为惰戈下家 p1
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
  });

  it('亢奋：插队打出对10（20）同样归属惰戈，且联动法音', () => {
    const hands = {
      p0: [...pairSameSuit(9), pick(7, 0), pick(7, 1), pick(8, 0)], // 惰戈起对9（18，不触发；单一花色不触发法音）
      p1: byRank(4, 5),
      p2: [pick(10, 0), pick(10, 1), pick(8, 0)], // 对10♠♥（20 → 归属惰戈）插队
    };
    const engine = mkEngine(hands, { p0: duoGe, p2: patrick });
    const r1 = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    expect(r1.ok).toBe(true);
    const cut = askOf(r1);
    expect(cut?.kind).toBe('cutIn');
    const r2 = engine.resolveAsk('p2', { askId: cut!.askId!, choice: 'yes', cardIds: hands.p2.slice(0, 2).map((c) => c.id) });
    expect(r2.ok).toBe(true);
    expect(attributed(r2)).toBe(true); // 插队手归属事件随插队提交结果一起返回（含此前挂起缓冲的事件）
    const faYin = askOf(r2);
    expect(faYin?.prompt).toContain('法音'); // 插队归属同样联动二技能
    const a2 = engine.resolveAsk('p0', { askId: faYin!.askId!, choice: 'decline' });
    // 插队手（对10 = 20）归属惰戈 → 视作惰戈打出，无名加牌不触发（2026-10-06 用户确认：不摸牌）
    expect(engine.snapshotFor('p0').players[0]!.handCount).toBe(3);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1'); // 轮转从惰戈下家（p1）继续
  });

  it('法音先于阿色再问（惰戈 950 > 阿色 900）：同一手牌先问法音，弃权后仍触发再问', () => {
    const hands = {
      p0: [pick(4, 0), pick(4, 1), pick(9, 0)], // 对4♠♥（双花色触发法音；管牌须恰好大一级压对3）
      p1: [pick(3, 0), pick(3, 1), pick(5, 0)], // 阿色起牌对3
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: duoGe, p1: captain }, 'p1');
    // 阿色开局整备抽你询问：弃权
    const startAsk = engine.snapshotFor('p1').pendingAsk;
    expect(startAsk?.prompt).toContain('抽你');
    expect(engine.resolveAsk('p1', { askId: startAsk!.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]).ok).toBe(true); // 对3（6）
    expect(engine.pass('p2').ok).toBe(true);
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 对4 压对3
    expect(r.ok).toBe(true);
    const first = askOf(r);
    expect(first?.prompt).toContain('法音'); // 先问惰戈的法音
    const a1 = engine.resolveAsk('p0', { askId: first!.askId!, choice: 'decline' });
    const second = askOf(a1);
    expect(second?.prompt).toContain('再问'); // 阿色再问照常触发
    decline(engine, 'p1', second);
  });
});
