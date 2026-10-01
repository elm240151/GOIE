import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import flashpoint from './flashpoint';
import type { RoleDef, RoleRegistry } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const bySuit = (suit: number, r: number) => deck.find((c) => c.suit === suit && c.rank === r)!;
const smallJoker = deck.find((c) => c.rank === 16)!;
const bigJoker = deck.find((c) => c.rank === 17)!;

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

describe('第四席 阿毛（茄汤）', () => {
  it('红色 ≥ 一半：黑牌成炸打出（点数 = 最大黑牌），红色留在手中', () => {
    // 3 红（♥3♥4♥5）+ 3 黑（♠8♣9♠K）：红色正好一半
    const hands = {
      p0: [bySuit(1, 3), bySuit(1, 4), bySuit(1, 5), bySuit(0, 8), bySuit(2, 9), bySuit(0, 13)],
      p1: [byRank(3, 1)[0]!, ...byRank(10, 4)],
    };
    const engine = mkEngine(hands, { p0: flashpoint }, 'p1');
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true); // p1 起单3
    const r = engine.useSkillAction('p0', { skillId: 'qie-tang' });
    expect(r.ok).toBe(true);
    const events = r.ok ? r.events : [];
    expect(events.some((e) => e.type === 'cards:revealed')).toBe(true); // 展示全部手牌
    expect(events.some((e) => e.type === 'skill:triggered' && e.skillId === 'qie-tang')).toBe(true);
    const played = events.find((e) => e.type === 'cards:played') as { combo: { type: string; rank: number; cards: Card[] } } | undefined;
    expect(played?.combo.type).toBe('bomb');
    expect(played?.combo.rank).toBe(13); // 最大黑牌 ♠K
    expect(played?.combo.cards).toHaveLength(3);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.rank).toBe(13);
    expect(snap.players[0]!.handCount).toBe(3); // 只剩 3 张红牌
    expect(snap.turnPlayerId).toBe('p1'); // 打完轮到下家
  });

  it('红色不足一半：仅展示，不打出，轮次不变', () => {
    const hands = {
      p0: [bySuit(1, 3), bySuit(1, 4), bySuit(0, 8), bySuit(0, 9), bySuit(0, 13), bySuit(0, 14)],
      p1: [byRank(3, 1)[0]!, ...byRank(10, 4)],
    };
    const engine = mkEngine(hands, { p0: flashpoint }, 'p1');
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.useSkillAction('p0', { skillId: 'qie-tang' });
    expect(r.ok).toBe(true);
    const events = r.ok ? r.events : [];
    expect(events.some((e) => e.type === 'cards:played')).toBe(false);
    expect(events.some((e) => e.type === 'skill:triggered' && /未能成汤/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.rank).toBe(3); // 桌面仍是单3
    expect(snap.turnPlayerId).toBe('p0'); // 轮次不变
  });

  it('小王计入黑牌：炸弹点数为 16，压过单牌', () => {
    // 3 红（♥3♥4♥5）+ 黑（小王+♠8+♣9）
    const hands = {
      p0: [bySuit(1, 3), bySuit(1, 4), bySuit(1, 5), smallJoker, bySuit(0, 8), bySuit(0, 9)],
      p1: [byRank(3, 1)[0]!, ...byRank(10, 4)],
    };
    const engine = mkEngine(hands, { p0: flashpoint }, 'p1');
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.useSkillAction('p0', { skillId: 'qie-tang' });
    expect(r.ok).toBe(true);
    const events = r.ok ? r.events : [];
    const played = events.find((e) => e.type === 'cards:played') as { combo: { rank: number } } | undefined;
    expect(played?.combo.rank).toBe(16); // 最大黑牌 = 小王
    expect(engine.snapshotFor('p0').table?.rank).toBe(16);
  });

  it('一元炸：仅 1 张黑牌也成炸打出', () => {
    // 4 红 + 1 黑（♠8）：红色 > 一半 → 一元炸
    const hands = {
      p0: [bySuit(1, 3), bySuit(1, 4), bySuit(1, 5), bySuit(1, 6), bySuit(0, 8)],
      p1: [byRank(3, 1)[0]!, ...byRank(10, 4)],
    };
    const engine = mkEngine(hands, { p0: flashpoint }, 'p1');
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.useSkillAction('p0', { skillId: 'qie-tang' });
    expect(r.ok).toBe(true);
    const events = r.ok ? r.events : [];
    const played = events.find((e) => e.type === 'cards:played') as
      | { combo: { type: string; rank: number; label: string; cards: Card[] } }
      | undefined;
    expect(played?.combo.type).toBe('bomb');
    expect(played?.combo.rank).toBe(8);
    expect(played?.combo.cards).toHaveLength(1);
    expect(played?.combo.label).toContain('一元炸');
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.rank).toBe(8);
    expect(snap.players[0]!.handCount).toBe(4); // 只剩 4 张红牌
  });

  it('二元炸压一元炸，三元炸弹压二元炸（炸弹张数优先）', () => {
    // p2 起单J → p0 茄汤一元炸(8) → p1 茄汤二元炸(9) → p2 三元炸弹(10)压过
    const hands = {
      p0: [bySuit(1, 3), bySuit(1, 4), bySuit(1, 5), bySuit(1, 6), bySuit(0, 8)],
      p1: [bySuit(1, 3), bySuit(1, 4), bySuit(3, 5), bySuit(0, 9), bySuit(2, 9)],
      p2: [byRank(11, 1)[0]!, ...byRank(10, 3), byRank(12, 1)[0]!],
    };
    const engine = mkEngine(hands, { p0: flashpoint, p1: flashpoint }, 'p2');
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true); // 单J
    expect(engine.useSkillAction('p0', { skillId: 'qie-tang' }).ok).toBe(true); // 一元炸(8)
    expect(engine.snapshotFor('p0').table?.rank).toBe(8);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1');
    expect(engine.useSkillAction('p1', { skillId: 'qie-tang' }).ok).toBe(true); // 二元炸(9) 压一元
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.rank).toBe(9);
    expect(snap.turnPlayerId).toBe('p2');
    expect(engine.playCards('p2', hands.p2.slice(1, 4).map((c) => c.id)).ok).toBe(true); // 3×10 压二元
    expect(engine.snapshotFor('p0').table?.rank).toBe(10);
  });

  it('没有黑牌：仅展示，不打出，轮次不变', () => {
    // 全红（含大王）：红色 ≥ 一半但无黑牌
    const hands = {
      p0: [bySuit(1, 3), bySuit(1, 4), bySuit(1, 5), bySuit(1, 6), bigJoker],
      p1: [byRank(3, 1)[0]!, ...byRank(10, 4)],
    };
    const engine = mkEngine(hands, { p0: flashpoint }, 'p1');
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.useSkillAction('p0', { skillId: 'qie-tang' });
    expect(r.ok).toBe(true);
    const events = r.ok ? r.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && /没有黑牌/.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === 'cards:played')).toBe(false);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
  });

  it('桌面有更大的炸弹时：成炸但压不过，不打出', () => {
    const hands = {
      p0: [bySuit(1, 3), bySuit(1, 4), bySuit(1, 5), bySuit(0, 8), bySuit(0, 9), bySuit(0, 10)],
      p1: [...byRank(6, 4), byRank(11, 1)[0]!], // 4×6 炸弹 + 1 张（打完不获胜）
    };
    const engine = mkEngine(hands, { p0: flashpoint }, 'p1');
    expect(engine.playCards('p1', hands.p1.slice(0, 4).map((c) => c.id)).ok).toBe(true); // 4×6 炸弹
    const r = engine.useSkillAction('p0', { skillId: 'qie-tang' });
    expect(r.ok).toBe(true);
    const events = r.ok ? r.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && /压不过/.test(e.text))).toBe(true);
    expect(events.some((e) => e.type === 'cards:played')).toBe(false);
    expect(engine.snapshotFor('p0').table?.rank).toBe(6);
  });
});
