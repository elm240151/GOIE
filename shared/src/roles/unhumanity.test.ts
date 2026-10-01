import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import unhumanity from './unhumanity';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const bigJoker = deck.filter((c) => c.rank === 17)[2]!; // id 161 = 牌堆最末（第3副大王，红）

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

describe('第三席 儒艮（黑脸）', () => {
  it('拒绝发动：正常摸牌', () => {
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5) };
    const engine = mkEngine(hands, { p0: unhumanity });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 出单3
    const r = engine.pass('p1'); // 一轮结束，儒艮有牌权
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'round:ended' && e.drew === 1)).toBe(true);
    expect(engine.snapshotFor('p0').players[0]!.handCount).toBe(5); // 4 + 1 正常摸
  });

  it('接受发动：牌堆顶是红王 → 立即停止，未获得黑牌，抑制摸牌', () => {
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5) };
    const engine = mkEngine(hands, { p0: unhumanity });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.pass('p1');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hei-lian')).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'round:ended' && e.drew === 0)).toBe(true);
    expect(engine.snapshotFor('p0').players[0]!.handCount).toBe(4); // 未摸牌未得牌
  });

  it('接受发动：连续翻到黑牌获得之（小王后接红♦2），判定牌豁免', () => {
    // 把牌堆最末的大王塞进 p2 手牌 → 牌堆顶变成小王（黑），下一张 ♦2（红）
    const hands = {
      p0: byRank(3, 5),
      p1: byRank(13, 5),
      p2: [bigJoker, ...byRank(12, 4)],
    };
    const engine = mkEngine(hands, { p0: unhumanity });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2'); // 一轮结束
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && /获得 1 张黑/.test(e.text))).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'round:ended' && e.drew === 0)).toBe(true);
    const snap = engine.snapshotFor('p0');
    const p0 = snap.players[0]!;
    expect(p0.handCount).toBe(5); // 4 + 1 张黑色判定牌（小王）
    expect(p0.hand?.some((c) => c.rank === 16)).toBe(true);
  });

  it('连续翻到多张黑牌：全部摸回（13 黑后 1 红止），判定牌豁免上限', () => {
    // p0 黑脸拿 deck2 的 ♦3..♦10，p1 拿 ♦J..大王 → 牌堆顶依次为 13 张黑（♣2..♣3）然后 ♥2（红）
    const hands = {
      p0: [...deck.slice(147, 155)], // ♦3..♦10
      p1: [...deck.slice(155, 162)], // ♦J..大王
    };
    const engine = mkEngine(hands, { p0: unhumanity });
    expect(engine.playCards('p0', [hands.p0[5]!.id]).ok).toBe(true); // 出 ♦8
    const r = engine.pass('p1');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'round:ended' && e.drew === 0)).toBe(true);
    const snap = engine.snapshotFor('p0');
    const p0 = snap.players[0]!;
    expect(p0.handCount).toBe(20); // 7 + 13 张黑牌全部摸回
    const clubs = p0.hand!.filter((c) => c.suit === 2);
    expect(clubs).toHaveLength(13); // ♣2..♣3 一张不落
    expect(p0.hand!.some((c) => c.id === 133)).toBe(false); // 红 ♥2 未摸回（进弃牌堆）
    expect(snap.revealed).toHaveLength(0); // 展示区清空
    // 牌守恒
    const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
    expect(handCards + snap.deckCount + snap.discardCount).toBe(162);
  });
});
