import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import type { GameEvent } from '../engine/events';
import { mulberry32 } from '../engine/rng';
import amo from './amo';
import captain from './captain';
import csChampion from './cs-champion';
import duoGe from './duo-ge';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const pick = (r: number, s: number) => deck.find((c) => c.rank === r && c.suit === s)!;
const jokerSmall = deck.find((c) => c.rank === 16)!;
const jokerBig = deck.find((c) => c.rank === 17)!;
const plain = (): RoleDef => ({ id: 'plain', name: '路人', skills: [] });

function mkEngine(hands: Record<string, Card[]>, roles: Record<string, RoleDef>, startPlayerId = 'p0', deckCount = 3) {
  const players: EnginePlayer[] = Object.keys(hands).map((id, i) => ({
    id,
    name: `玩家${i}`,
    roleId: roles[id]?.id ?? '',
  }));
  const registry: RoleRegistry = new Map(Object.values(roles).map((r) => [r.id, r]));
  const engine = new GameEngine(
    deckCount === 3 ? defaultRules : { ...defaultRules, deck: { count: deckCount } },
    players,
    {
      rng: mulberry32(1),
      startPlayerId,
      roles: registry,
      handsOverride: hands,
    }
  );
  engine.start();
  return engine;
}

/** 真实发牌（不指定手牌）：验证贪婪 2X 初始手牌 */
function mkDeal(seats: { id: string; role: RoleDef }[], startPlayerId: string) {
  const players: EnginePlayer[] = seats.map((s, i) => ({ id: s.id, name: `玩家${i}`, roleId: s.role.id }));
  const registry: RoleRegistry = new Map(seats.map((s) => [s.role.id, s.role]));
  const engine = new GameEngine(defaultRules, players, { rng: mulberry32(11), startPlayerId, roles: registry });
  engine.start();
  return engine;
}

const handOf = (engine: GameEngine, pid: string): number =>
  engine.snapshotFor('p0').players.find((p) => p.id === pid)!.handCount;
const deckOf = (engine: GameEngine): number => engine.snapshotFor('p0').deckCount;
const discardOf = (engine: GameEngine): number => engine.snapshotFor('p0').discardCount;
const totalCards = (engine: GameEngine): number => {
  const snap = engine.snapshotFor('p0');
  return (
    snap.players.reduce((s, p) => s + p.handCount + p.pancakeCount, 0) +
    (snap.table ? snap.table.cards.length : 0) +
    (snap.tableSide ? snap.tableSide.length : 0) +
    (snap.revealed ? snap.revealed.length : 0) +
    snap.deckCount +
    snap.discardCount
  );
};
const eventsOf = (r: { ok: boolean; events?: GameEvent[] }): GameEvent[] => (r.ok ? (r.events ?? []) : []);

describe('阿摩（贪婪/耀武）', () => {
  it('贪婪：初始手牌 2X（X=全场人数，先手/后手同）', () => {
    const e3 = mkDeal(
      [
        { id: 'p0', role: plain() },
        { id: 'p1', role: amo },
        { id: 'p2', role: plain() },
      ],
      'p0'
    );
    expect(handOf(e3, 'p1')).toBe(6); // 2×3
    expect(handOf(e3, 'p0')).toBe(6); // 先手 6
    expect(handOf(e3, 'p2')).toBe(5);
    const e4 = mkDeal(
      [
        { id: 'p0', role: amo },
        { id: 'p1', role: plain() },
        { id: 'p2', role: plain() },
        { id: 'p3', role: plain() },
      ],
      'p0'
    );
    expect(handOf(e4, 'p0')).toBe(8); // 2×4：先手也不多 1，恒 2X
    expect(handOf(e4, 'p1')).toBe(5);
  });

  it('贪婪：出单张摸 1 张（手牌数不变），发 cards:drawn', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 0), pick(4, 1), pick(4, 2), pick(4, 3), pick(5, 0)],
      p1: byRank(6, 5),
      p2: byRank(7, 5),
    };
    const engine = mkEngine(hands, { p0: amo });
    expect(handOf(engine, 'p0')).toBe(6);
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 领出单3
    expect(r.ok).toBe(true);
    expect(eventsOf(r).some((e) => e.type === 'cards:drawn' && e.playerId === 'p0' && e.count === 1)).toBe(true);
    expect(handOf(engine, 'p0')).toBe(6); // 6 - 1 + 1
    expect(deckOf(engine)).toBe(162 - 16 - 1);
    expect(totalCards(engine)).toBe(162);
  });

  it('贪婪：出对子净减 1 张（6 - 2 + 1 = 5）', () => {
    const hands = {
      p0: [pick(4, 0), pick(4, 1), pick(5, 0), pick(5, 1), pick(6, 0), pick(6, 1)],
      p1: byRank(8, 5),
      p2: byRank(9, 5),
    };
    const engine = mkEngine(hands, { p0: amo });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 领出对4
    expect(r.ok).toBe(true);
    expect(handOf(engine, 'p0')).toBe(5);
    expect(totalCards(engine)).toBe(162);
  });

  it('贪婪：出完最后一张先判获胜、不摸', () => {
    const hands = { p0: [pick(3, 0)], p1: [pick(3, 1)], p2: [pick(3, 2)] };
    const engine = mkEngine(hands, { p0: amo });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
    expect(handOf(engine, 'p0')).toBe(0); // 没有摸回 1 张
    expect(deckOf(engine)).toBe(159); // 牌堆一张未动
  });

  it('贪婪：被惰戈亢奋归属改写（视作惰戈打出）不摸', () => {
    const hands = {
      p0: [pick(10, 0), pick(10, 1), pick(3, 0)], // 阿摩：对10（点数和 20）+ 单3
      p1: byRank(6, 5),
      p2: byRank(7, 5), // 惰戈
    };
    const engine = mkEngine(hands, { p0: amo, p2: duoGe });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    expect(r.ok).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk | null) : null;
    expect(ask?.kind).toBe('confirm'); // 法音照常询问（对10 两花色）
    expect(handOf(engine, 'p0')).toBe(1); // 归属改写 → 贪婪不摸
    expect(deckOf(engine)).toBe(162 - 13); // 只少了打出的 2 张（进了桌面），没摸
    const declined = engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'decline' });
    // 挂起期间的事件缓冲到询问解决才吐出：table:attributed 在 decline 结果里
    expect(eventsOf(declined).some((e) => e.type === 'table:attributed' && e.playerId === 'p2')).toBe(true);
    expect(handOf(engine, 'p0')).toBe(1); // 询问解决后仍不摸（桌面归惰戈）
    expect(deckOf(engine)).toBe(162 - 13);
    expect(totalCards(engine)).toBe(162);
  });

  it('贪婪：阿色再问补打不算出牌、不摸（响应摸 1、补打不摸）', () => {
    const hands = {
      p0: byRank(3, 5), // 阿色
      p1: [pick(4, 0), pick(4, 1), pick(4, 2)], // 阿摩
      p2: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p0: captain, p1: amo });
    const ask0 = engine.snapshotFor('p0').pendingAsk;
    expect(ask0).not.toBeNull(); // 开局整备（抽你）
    expect(engine.resolveAsk('p0', { askId: ask0!.askId, choice: 'decline' }).ok).toBe(true);
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 阿色出单3
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]); // 阿摩压 ♠4
    const ask = r1.ok ? (r1.pendingAsk as SkillAsk | null) : null;
    expect(ask?.prompt).toContain('再问');
    expect(handOf(engine, 'p1')).toBe(2); // 3 - 压1；再问挂起中：贪婪摸牌尚未发生（管线暂停）
    expect(deckOf(engine)).toBe(162 - 13); // 还没摸
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(pickAsk?.kind).toBe('pickCards');
    expect(pickAsk?.askPlayerId).toBe('p1');
    const done = engine.resolveAsk('p1', { askId: pickAsk!.askId!, cardIds: [hands.p1[1]!.id] }); // 补打 ♥4
    expect(done.ok).toBe(true);
    expect(handOf(engine, 'p1')).toBe(2); // 3 - 压1 - 补打1 + 贪婪摸1（压牌+补打合计只摸 1 次）
    expect(deckOf(engine)).toBe(162 - 13 - 1); // 补打（playSideCard）不触发第二次摸牌
    expect(totalCards(engine)).toBe(162);
  });

  it('贪婪：手牌上限 30（25 张不淘汰、31 张发牌即淘汰；贪婪每手净减 ≤1 不会自己摸爆）', () => {
    const hand25 = [
      ...byRank(3, 4),
      ...byRank(4, 4),
      ...byRank(5, 4),
      ...byRank(6, 4),
      ...byRank(7, 4),
      ...byRank(8, 4),
      ...byRank(9, 1),
    ]; // 25 张、7 个点数（耀武不触发）
    const e1 = mkEngine({ p0: hand25, p1: byRank(10, 5), p2: byRank(11, 5) }, { p0: amo });
    expect(e1.snapshotFor('p0').players[0]!.eliminated).toBe(false); // 25 ≤ 30 不淘汰（路人上限 20 则淘汰）
    expect(handOf(e1, 'p0')).toBe(25);
    const hand31 = [...hand25, byRank(9, 2)[1]!, byRank(9, 4)[2]!, byRank(9, 4)[3]!, ...byRank(10, 3)]; // 31 张、8 个点数（无重复牌）
    const e2 = mkEngine({ p0: hand31, p1: byRank(11, 5), p2: byRank(12, 5) }, { p0: amo });
    const snap = e2.snapshotFor('p0');
    expect(snap.players[0]!.eliminated).toBe(true); // 31 > 30：发牌检查即淘汰
    expect(handOf(e2, 'p0')).toBe(0); // 手牌进弃牌堆
    expect(snap.phase).toBe('playing'); // 还有 2 人，游戏继续
    expect(totalCards(e2)).toBe(162);
  });

  it('耀武：13 个真牌点数（含 2）发牌即胜', () => {
    const hands = {
      p0: byRank(3, 1).concat(byRank(4, 1), byRank(5, 1), byRank(6, 1), byRank(7, 1), byRank(8, 1), byRank(9, 1), byRank(10, 1), byRank(11, 1), byRank(12, 1), byRank(13, 1), byRank(14, 1), byRank(15, 1)), // A~K 全部 13 点（3..15）
      p1: [pick(3, 1)],
      p2: [pick(3, 2)],
    };
    const engine = mkEngine(hands, { p0: amo });
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
    expect(eventsOf(engine.playCards('p1', [])).length).toBe(0); // 终局后动作被拒
    expect(snap.scoreDeltas!['p0']).toBe(2); // 3 人局赢家 +2
  });

  it('耀武：每张王补一个缺的点数（12 点+1 王 胜；11 点+2 王 胜；11 点+1 王 不胜）', () => {
    const real11 = byRank(3, 1).concat(byRank(4, 1), byRank(5, 1), byRank(6, 1), byRank(7, 1), byRank(8, 1), byRank(9, 1), byRank(10, 1), byRank(11, 1), byRank(12, 1), byRank(13, 1)); // 3..13
    const real12 = real11.concat(byRank(14, 1)); // 3..14，缺 2（15）
    // 12 真点 + 小王 → 补上 2 → 胜
    const e1 = mkEngine({ p0: [...real12, jokerSmall], p1: [pick(3, 1)], p2: [pick(3, 2)] }, { p0: amo });
    expect(e1.snapshotFor('p0').winnerId).toBe('p0');
    // 11 真点 + 小王 + 大王 → 补上 2 个缺 → 胜
    const e2 = mkEngine({ p0: [...real11, jokerSmall, jokerBig], p1: [pick(3, 1)], p2: [pick(3, 2)] }, { p0: amo });
    expect(e2.snapshotFor('p0').winnerId).toBe('p0');
    // 11 真点 + 小王 → 缺 2 个只补 1 → 不胜
    const e3 = mkEngine({ p0: [...real11, jokerSmall], p1: [pick(3, 1)], p2: [pick(3, 2)] }, { p0: amo });
    expect(e3.snapshotFor('p0').phase).toBe('playing');
    expect(e3.snapshotFor('p0').winnerId).toBeNull();
  });

  it('耀武：贪婪摸牌凑齐 13 点 → 立即获胜、跳过其余询问', () => {
    const jokers = deck.filter((c) => c.rank >= 16); // 三副牌共 6 张王，id 大的排在牌堆尾部
    const hands = {
      p0: [
        ...byRank(4, 1).concat(byRank(5, 1), byRank(6, 1), byRank(7, 1), byRank(8, 1), byRank(9, 1), byRank(10, 1), byRank(11, 1), byRank(12, 1), byRank(13, 1), byRank(14, 1)), // 4..14 共 11 张
        pick(3, 0),
        pick(3, 1),
        pick(3, 2), // 三张 3：打对3 后手牌仍留一个 3
      ],
      p1: jokers.filter((c) => c.id !== jokerSmall.id), // 惰戈持其余 5 张王：让牌堆顶 = ♦2
      p2: [jokerSmall],
    };
    const engine = mkEngine(hands, { p0: amo, p1: duoGe });
    expect(engine.snapshotFor('p0').phase).toBe('playing'); // 12 个点数、缺 2
    const r = engine.playCards('p0', [pick(3, 0).id, pick(3, 1).id]); // 领出对3 → 贪婪摸 1 → ♦2 → 耀武
    expect(r.ok).toBe(true);
    expect(eventsOf(r).some((e) => e.type === 'skill:triggered' && e.skillId === 'yao-wu')).toBe(true);
    expect(eventsOf(r).some((e) => e.type === 'game:ended' && e.winnerId === 'p0')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
    expect(snap.pendingAsk).toBeNull(); // 终局即停：无任何挂起询问（法音/再问/吃饼均不再问）
    expect(handOf(engine, 'p0')).toBe(13); // 14 - 2 + 1
  });

  it('耀武：别人技能给牌（骚骚换牌）凑齐 13 点 → 立即获胜', () => {
    const hands = {
      p0: [...byRank(3, 1).concat(byRank(4, 1), byRank(5, 1), byRank(6, 1), byRank(7, 1), byRank(8, 1), byRank(9, 1), byRank(10, 1), byRank(11, 1), byRank(12, 1), byRank(13, 1)), pick(3, 1)], // 阿摩：3..13 + ♥3 = 12 张
      p1: [pick(14, 0), pick(15, 0), pick(5, 1), pick(5, 2)], // 企鹅：♠A ♠2（同花色）+ 填充
      p2: [pick(3, 2), pick(3, 3)], // 路人领出单3
    };
    const engine = mkEngine(hands, { p0: amo, p1: csChampion }, 'p2');
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true); // 单3
    expect(engine.pass('p0').ok).toBe(true); // 阿摩过
    const r1 = engine.useSkillAction('p1', { skillId: 'sao-sao' });
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk | null) : null;
    expect(ask1?.kind).toBe('confirm');
    const r2 = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk | null) : null;
    const r3 = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] }); // ♠A♠2 同花色
    const askC = r3.ok ? (r3.pendingAsk as SkillAsk | null) : null;
    expect(askC?.kind).toBe('choice');
    const r3b = engine.resolveAsk('p1', { askId: askC!.askId!, choice: '换 2 张' });
    const ask3 = r3b.ok ? (r3b.pendingAsk as SkillAsk | null) : null;
    expect(ask3?.kind).toBe('pickTarget');
    const r4 = engine.resolveAsk('p1', { askId: ask3!.askId!, targetPlayerId: 'p0' });
    const ask4 = r4.ok ? (r4.pendingAsk as SkillAsk | null) : null;
    expect(ask4?.kind).toBe('pickCards');
    expect(ask4?.min).toBe(2);
    const done = engine.resolveAsk('p1', {
      askId: ask4!.askId!,
      cardIds: [ask4!.cards![0]!.id, ask4!.cards![1]!.id],
      targetPlayerId: 'p0',
    });
    expect(done.ok).toBe(true);
    expect(eventsOf(done).some((e) => e.type === 'skill:triggered' && e.skillId === 'yao-wu')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0'); // 收到 ♠A♠2 凑齐 13 点
  });

  it('贪婪：牌堆空时摸牌走弃牌堆洗回（发 deck:recycled）', () => {
    const amoHand = [
      pick(5, 0), // 压单4 用
      pick(3, 0),
      pick(3, 1), // 重复点：控制点数 ≤ 11，防耀武
      ...byRank(6, 1),
      ...byRank(7, 1),
      ...byRank(8, 1),
      ...byRank(9, 1),
      ...byRank(10, 1),
      ...byRank(11, 1),
      ...byRank(12, 1),
      ...byRank(13, 1),
      ...byRank(14, 1), // 12 张
      byRank(6, 2)[1]!,
      byRank(7, 2)[1]!,
      byRank(8, 2)[1]!,
      byRank(9, 2)[1]!,
      byRank(10, 2)[1]!,
      byRank(11, 2)[1]!, // ♥6..♥J 6 张
    ]; // 18 张、11 个点数（3,5,6..14）
    const used = new Set([...amoHand, pick(3, 2), pick(4, 3)].map((c) => c.id));
    const filler = deck.filter((c) => !used.has(c.id));
    const hands = {
      p0: [pick(3, 2), ...filler.slice(0, 17)], // 18 张（含领出的 ♣3）
      p1: [pick(4, 3), ...filler.slice(17, 34)], // 18 张（含压单4 的 ♦4）
      p2: amoHand,
    }; // 54 张小牌库：18 × 3 = 54 → 牌堆 0、弃牌堆 0（手牌全部 ≤ 上限不淘汰）
    const engine = mkEngine(hands, { p2: amo }, 'p0', 1);
    expect(deckOf(engine)).toBe(0);
    expect(engine.playCards('p0', [pick(3, 2).id]).ok).toBe(true); // 单3
    expect(engine.playCards('p1', [pick(4, 3).id]).ok).toBe(true); // 压单4 → ♣3 进弃牌堆
    const r = engine.playCards('p2', [pick(5, 0).id]); // 阿摩压单5 → 贪婪摸牌：牌堆空 → 弃牌堆 2 张洗回
    expect(r.ok).toBe(true);
    expect(eventsOf(r).some((e) => e.type === 'deck:recycled' && e.count === 2)).toBe(true);
    expect(handOf(engine, 'p2')).toBe(18); // 18 - 1 + 摸 1（洗回的牌）
    expect(deckOf(engine)).toBe(1); // 洗回 2、摸 1
    expect(discardOf(engine)).toBe(0); // 洗回后弃牌堆清空
    expect(totalCards(engine)).toBe(54);
    expect(engine.snapshotFor('p0').phase).toBe('playing'); // 洗回的牌（♣3/♦4）不凑齐 13 点
  });
});
