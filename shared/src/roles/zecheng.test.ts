import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import zecheng from './zecheng';

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

describe('末席 肖亡（观股）', () => {
  it('拒绝发动：正常摸牌', () => {
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5), p2: byRank(11, 5) };
    const engine = mkEngine(hands, { p0: zecheng });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2'); // 一轮结束
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'round:ended' && e.drew === 1)).toBe(true);
    expect(engine.snapshotFor('p0').players[0]!.handCount).toBe(5);
  });

  it('大涨：每人 1 张依次自选（座位序从自己开始），多出的弃置，抑制摸牌', () => {
    // 牌堆顶 5 张 = ♦K♦A♦2小王大王（4 红 1 黑）→ 大涨
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5), p2: byRank(11, 5) };
    const engine = mkEngine(hands, { p0: zecheng });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'cards:revealed')).toBe(true);
    // 依次自选：先是自己，再按座位序问下家
    const ask1 = a.ok ? (a.pendingAsk as SkillAsk) : null;
    expect(ask1?.kind).toBe('pickCards');
    expect(ask1?.askPlayerId).toBe('p0');
    expect(ask1?.cards).toHaveLength(5);
    expect(engine.pendingAskPlayerId).toBe('p0');
    const pick0 = ask1!.cards![0]!.id;
    const r1 = engine.resolveAsk('p0', { askId: ask1!.askId!, cardIds: [pick0] });
    const ask2 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    expect(ask2?.askPlayerId).toBe('p1');
    expect(ask2?.cards).toHaveLength(4);
    expect(ask2!.cards!.some((c) => c.id === pick0)).toBe(false); // 已选走的不再可选
    expect(engine.pendingAskPlayerId).toBe('p1');
    const pick1 = ask2!.cards![0]!.id;
    const r2 = engine.resolveAsk('p1', { askId: ask2!.askId!, cardIds: [pick1] });
    const ask3 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask3?.askPlayerId).toBe('p2');
    expect(ask3?.cards).toHaveLength(3);
    // 错误回答者被拒
    expect(engine.resolveAsk('p1', { askId: ask3!.askId!, cardIds: [ask3!.cards![0]!.id] }).ok).toBe(false);
    const pick2 = ask3!.cards![0]!.id;
    const r3 = engine.resolveAsk('p2', { askId: ask3!.askId!, cardIds: [pick2] });
    expect(r3.ok).toBe(true);
    const events = r3.ok ? r3.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && /大涨/.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === 'round:ended' && e.drew === 0)).toBe(true);
    expect(engine.pendingAskPlayerId).toBeNull();
    const snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(5); // 4 + 自选 1
    expect(snap.players[1]!.handCount).toBe(6); // 5 + 自选 1
    expect(snap.players[2]!.handCount).toBe(6);
    expect(snap.players[0]!.hand?.some((c) => c.id === pick0)).toBe(true);
    expect(engine.snapshotFor('p1').players[1]!.hand?.some((c) => c.id === pick1)).toBe(true);
    expect(engine.snapshotFor('p2').players[2]!.hand?.some((c) => c.id === pick2)).toBe(true);
    // 剩下 2 张弃置：牌守恒
    const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
    expect(handCards + snap.deckCount + snap.discardCount).toBe(162);
  });

  it('大涨自选弃权（超时同路径）：自动拿剩余最小牌，队列继续，多出的弃置', () => {
    // 牌堆顶 5 张 = ♦K♦A♦2小王大王（4 红 1 黑）→ 大涨
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5), p2: byRank(11, 5) };
    const engine = mkEngine(hands, { p0: zecheng });
    engine.playCards('p0', [hands.p0[0]!.id]);
    engine.pass('p1');
    const r = engine.pass('p2');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const ask1 = a.ok ? (a.pendingAsk as SkillAsk) : null;
    const bySmall = (cs: Card[]) => [...cs].sort((x, y) => (x.rank !== y.rank ? x.rank - y.rank : x.suit - y.suit));
    const min0 = bySmall(ask1!.cards!)[0]!; // ♦K
    const r1 = engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'decline' });
    expect(r1.ok).toBe(true);
    expect(r1.ok && r1.events.some((e) => e.type === 'skill:triggered' && /未选/.test(e.text))).toBe(true);
    const ask2 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    expect(ask2?.askPlayerId).toBe('p1');
    expect(ask2?.cards).toHaveLength(4);
    expect(ask2!.cards!.some((c) => c.id === min0.id)).toBe(false); // 最小牌已被拿走
    const min1 = bySmall(ask2!.cards!)[0]!; // ♦A
    const r2 = engine.resolveAsk('p1', { askId: ask2!.askId!, choice: 'decline' });
    const ask3 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask3?.askPlayerId).toBe('p2');
    expect(ask3?.cards).toHaveLength(3);
    const r3 = engine.resolveAsk('p2', { askId: ask3!.askId!, choice: 'decline' });
    expect(r3.ok).toBe(true);
    const events = r3.ok ? r3.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && /大涨/.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === 'round:ended' && e.drew === 0)).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(5); // 4 + 自动拿最小 1
    expect(snap.players[0]!.hand?.some((c) => c.id === min0.id)).toBe(true);
    expect(engine.snapshotFor('p1').players[1]!.hand?.some((c) => c.id === min1.id)).toBe(true);
    expect(snap.players[1]!.handCount).toBe(6);
    expect(snap.players[2]!.handCount).toBe(6);
    expect(snap.revealed).toHaveLength(0);
    const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
    expect(handCards + snap.deckCount + snap.discardCount).toBe(162);
  });

  it('大跌选牌阶段弃权（超时同路径）：判定牌弃置、正常摸牌、不触发守恒断言', () => {
    // 消耗牌堆最末 15 张（♦3..♦2小王大王）→ 牌堆顶 5 张 = ♣J♣Q♣K♣A♣2（全黑）
    const hands = {
      p0: byRank(3, 5),
      p1: [...byRank(13, 5), ...deck.slice(147, 152)],
      p2: [...byRank(11, 5), ...deck.slice(152, 162)],
    };
    const engine = mkEngine(hands, { p0: zecheng });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('pickCards');
    // 修复前：此弃权让 5 张判定牌留在翻牌池，引擎直接抛「翻牌池未清空」
    const d = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    const events = d.ok ? d.events : [];
    expect(events.some((e) => e.type === 'round:ended' && e.drew === 1)).toBe(true); // 弃权 → 正常摸牌
    const snap = engine.snapshotFor('p0');
    expect(snap.revealed).toHaveLength(0); // 展示池已清空
    expect(snap.players[0]!.handCount).toBe(5); // 4 + 正常摸 1
    const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
    expect(handCards + snap.deckCount + snap.discardCount).toBe(162);
  });

  it('大跌：展示 5 张黑多 → 自己选 2 张拿走，抑制摸牌', () => {
    // 消耗牌堆最末 15 张（♦3..♦2小王大王）→ 牌堆顶 5 张 = ♣J♣Q♣K♣A♣2（全黑）
    const hands = {
      p0: byRank(3, 5),
      p1: [...byRank(13, 5), ...deck.slice(147, 152)],
      p2: [...byRank(11, 5), ...deck.slice(152, 162)],
    };
    const engine = mkEngine(hands, { p0: zecheng });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('pickCards');
    expect(ask2?.min).toBe(2);
    expect(ask2?.cards).toHaveLength(5);
    const pick = ask2!.cards!.slice(0, 2).map((c) => c.id);
    const a = engine.resolveAsk('p0', { askId: ask2!.askId!, cardIds: pick });
    expect(a.ok).toBe(true);
    const events = a.ok ? a.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && /大跌/.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === 'round:ended' && e.drew === 0)).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(6); // 4 + 2
    expect(snap.players[0]!.hand?.some((c) => pick.includes(c.id))).toBe(true);
    const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
    expect(handCards + snap.deckCount + snap.discardCount).toBe(162);
  });
});
