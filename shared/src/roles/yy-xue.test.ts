import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
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

describe('第五席 雪灾天使（巨石）', () => {
  it('有人出单 2：弹出花色判定；放弃则无事发生', () => {
    const hands = {
      p0: [byRank(15, 1)[0]!, ...byRank(9, 4)],
      p1: byRank(13, 5), // 巨石
      p2: byRank(11, 5),
    };
    const engine = mkEngine(hands, { p1: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 出单2
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('suit');
    expect(ask?.options).toEqual(['♠', '♥', '♣', '♦']);
    const d = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players.find((p) => p.id === 'p0')!.eliminated).toBe(false);
    expect(snap.table?.rank).toBe(15); // 桌面仍是 2
    expect(snap.turnPlayerId).toBe('p1'); // 正常轮转（p0 的下家先接）
  });

  it('判定成功：驱逐出牌者 + 巨石获得牌权（桌面作废、牌守恒）', () => {
    // 把牌堆最末 15 张（♦3..♦2小王大王，id 147-161）塞进 p2 → 牌堆顶变为 ♣2（id 146，♣）
    const hands = {
      p0: [byRank(15, 1)[0]!, ...byRank(9, 4)],
      p1: byRank(13, 5), // 巨石
      p2: [...deck.slice(147, 162)],
    };
    const engine = mkEngine(hands, { p1: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 出单2
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: '♣' }); // 判定 ♣2 命中
    expect(a.ok).toBe(true);
    const events = a.ok ? a.events : [];
    expect(events.some((e) => e.type === 'skill:triggered' && e.skillId === 'ju-shi')).toBe(true);
    expect(events.some((e) => e.type === 'player:eliminated' && e.playerId === 'p0')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.phase).toBe('playing');
    expect(snap.players.find((p) => p.id === 'p0')!.eliminated).toBe(true);
    expect(snap.table).toBeNull();
    expect(snap.turnPlayerId).toBe('p1'); // 巨石起牌
    // 牌守恒：手牌 + 桌面 + 牌堆 + 弃牌堆 = 162
    const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
    expect(handCards + snap.deckCount + snap.discardCount).toBe(162);
  });

  it('判定失败：不驱逐，判定牌摸回，正常轮转', () => {
    const hands = {
      p0: [byRank(15, 1)[0]!, ...byRank(9, 4)],
      p1: byRank(13, 5),
      p2: [...deck.slice(157, 162)],
    };
    const engine = mkEngine(hands, { p1: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: '♥' }); // 牌堆顶 ♦10 ≠ ♥
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && /失败/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players.find((p) => p.id === 'p0')!.eliminated).toBe(false);
    expect(snap.turnPlayerId).toBe('p1');
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(6); // 判定牌 ♦10 摸回
    expect(snap.revealed).toHaveLength(0); // 判定牌已收走，不留在展示区
  });

  it('普通出牌不触发；判定次数用尽（玩家人数+1）后不再询问', () => {
    // 2 人局：上限 = 2+1 = 3 次。p0 依次出 2 触发 3 次判定（牌堆顶是王必失败），第 4 张不再询问
    const hands = {
      p0: [...byRank(15, 4), ...byRank(9, 2)], // 4 张 2 + 2 张 9
      p1: byRank(13, 5), // 巨石
    };
    const engine = mkEngine(hands, { p1: yyXue });
    // 普通出牌不触发
    expect(engine.playCards('p0', [hands.p0[4]!.id]).ok).toBe(true); // 出单9，无询问
    expect(engine.pass('p1').ok).toBe(true);
    // 3 次判定（全部失败：牌堆顶依次为王/♦2/♦A）
    for (let i = 0; i < 3; i++) {
      const r = engine.playCards('p0', [hands.p0[i]!.id]); // 出单2
      expect(r.ok && r.suspended).toBe(true);
      const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
      const a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: '♠' });
      expect(a.ok).toBe(true);
      expect(engine.pass('p1').ok).toBe(true); // 让 p1 过，回到 p0 起牌
    }
    // 第 4 张 2：次数用尽，不再询问（直接正常流程）
    const r4 = engine.playCards('p0', [hands.p0[3]!.id]);
    expect(r4.ok).toBe(true);
    expect(r4.ok && r4.suspended).toBe(false);
  });
});
