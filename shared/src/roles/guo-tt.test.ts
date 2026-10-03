import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import guoTT from './guo-tt';

const deck = buildDeck(3);
const byId = (from: number, to: number) => deck.slice(from, to + 1); // 含两端
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

describe('橐驼：地坛（红楼梦）+ 诅咒（单王）', () => {
  it('地坛判定成功：目标下轮禁出（自动过），轮末获得牌权时橐驼取而代之（含摸牌），一轮后解除', () => {
    const hands = {
      p0: [byRank(6, 1)[0]!, ...byRank(9, 4)], // 橐驼：♠6 + 四张 9
      p1: [byRank(3, 1)[0]!, byRank(4, 1)[0]!, byRank(5, 1)[0]!, ...byRank(10, 2)], // ♠3♠4♠5 + 两张 10
      p2: [...byRank(11, 4)], // 四张 J（全程只过牌）
    };
    // 把第三副牌的高位全塞进手牌 → 牌堆顶 = ♠K（118，与顺子同花色）；43 槽填满 119..161
    pad(hands, { p0: 18, p1: 20, p2: 20 }, [119, 161]);
    expect(deckTopOf(hands).id).toBe(118); // ♠K
    const engine = mkEngine(hands, { p0: guoTT }, 'p1');

    // p1 起牌顺子 345 → 地坛询问（confirm，问 p0）
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]);
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('玩家1');

    // 判定成功（♠K 与顺子同花色 ♠）
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan' && /成功/.test(e.text))).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.cursedPlayerIds).toContain('p1');
    expect(snap.revealed).toHaveLength(0); // 判定牌已弃置

    // p2、p0 都过 → 轮末 p1 获得牌权 → 橐驼取而代之（摸牌 + 起牌）
    expect(engine.pass('p2').ok).toBe(true);
    const pr = engine.pass('p0');
    expect(pr.ok).toBe(true);
    expect(pr.ok && pr.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p1' && e.ledBy === 'p0' && e.drew === 1)).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p0'); // 橐驼起牌
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(19); // 18 + 摸 1
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(17); // 没摸（20 − 3 打出）

    // 新回合：p1 被禁 → 轮到自动过，无法出牌
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true); // 出单 ♠9
    snap = engine.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p2'); // p1 已自动过
    expect(snap.cursedPlayerIds).toContain('p1');

    // p2 过 → 轮末 p0 摸牌起牌，诅咒解除
    const p2r = engine.pass('p2');
    expect(p2r.ok && p2r.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p0')).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.cursedPlayerIds).toEqual([]);
    expect(snap.turnPlayerId).toBe('p0');

    // p1 恢复正常出牌（♥10 压 ♥9）
    expect(engine.playCards('p0', [hands.p0[2]!.id]).ok).toBe(true); // ♥9
    expect(engine.playCards('p1', [hands.p1[4]!.id]).ok).toBe(true); // ♥10
    // 牌守恒：手牌 + 牌堆 + 弃牌堆 + 桌面 = 162
    snap = engine.snapshotFor('p0');
    const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
    expect(handCards + snap.deckCount + snap.discardCount + (snap.table?.cards.length ?? 0)).toBe(162);
  });

  it('弃权不消耗：同轮下一次 ≥3 张仍询问；判定失败消耗 + 判定牌弃置', () => {
    const hands = {
      p0: [byRank(6, 1)[0]!, ...byRank(9, 4)], // 橐驼
      p1: [byRank(3, 2)[0]!, byRank(4, 2)[0]!, byRank(5, 2)[0]!, byRank(3, 2)[1]!, byRank(4, 2)[1]!, byRank(5, 2)[1]!], // ♠345 + ♥345
      p2: [...byRank(11, 4)], // 四张 J
    };
    // 高位全进手牌：初始顶 = ♠K（118，p1 轮末摸走）→ 次顶 = ♠Q（117，判定牌，♠ ≠ ♥ → 失败）
    pad(hands, { p0: 19, p1: 20, p2: 19 }, [119, 161]);
    expect(deckTopOf(hands).id).toBe(118); // ♠K
    const engine = mkEngine(hands, { p0: guoTT }, 'p1');

    // 第一手顺子：弃权
    let r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(r.ok && r.suspended).toBe(true);
    expect(engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    const pr = engine.pass('p0');
    expect(pr.ok && pr.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p1')).toBe(true); // p1 摸 ♠K 起牌

    // 第二手顺子：弃权未消耗 → 仍询问；yes → ♠Q ≠ ♥ → 失败消耗
    r = engine.playCards('p1', [hands.p1[3]!.id, hands.p1[4]!.id, hands.p1[5]!.id]);
    expect(r.ok && r.suspended).toBe(true);
    const ask2 = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' });
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan' && /失败/.test(e.text))).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.revealed).toHaveLength(0);
    expect(snap.discardCount).toBe(4); // 上一轮桌面 ♠345（3 张）+ 判定牌 ♠Q
    expect(snap.cursedPlayerIds).toEqual([]);

    expect(engine.pass('p2').ok).toBe(true);
    const pr2 = engine.pass('p0');
    expect(pr2.ok && pr2.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p1')).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p1');
    expect(snap.cursedPlayerIds).toEqual([]); // 失败不诅咒
  });

  it('判定牌是王 → 按颜色双花色判定（♣ 顺子对大王 ♥♦ 不匹配 → 失败且消耗）；自己出 ≥3 张不触发', () => {
    // 手牌只用低 id → 牌堆顶 = 大王（161）。大王按颜色 = ♥♦，p1 打全 ♣ 顺子 → 不匹配 → 失败
    const hands = {
      p0: byId(0, 18), // 橐驼：♠3..♠2 + ♥3..♥8（19 张，轮末摸 1 后 20 不超上限）
      p1: byId(19, 38), // ♥9..♥2 + ♣3..♣2（20 张）
      p2: byId(39, 51), // ♦3..♦2（13 张）
    };
    expect(deckTopOf(hands).id).toBe(161); // 大王
    const engine = mkEngine(hands, { p0: guoTT }, 'p1');

    // p1 起牌 ♣10JQ → 判定翻到大王（♥♦，与全 ♣ 不匹配）→ 失败
    let r = engine.playCards('p1', [33, 34, 35]);
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan' && /失败/.test(e.text))).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.discardCount).toBe(1); // 大王弃置
    expect(snap.cursedPlayerIds).toEqual([]);

    // p2 响应 JQK：次数已消耗 → 不再询问
    r = engine.playCards('p2', [47, 48, 49]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(false);
    // p0 响应 QKA：自己出的 → 不触发
    r = engine.playCards('p0', [9, 10, 11]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(false);
    // p1 压不了 QKA → 过；p2 也过 → 轮末 p0 摸牌起牌
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p0');
    expect(snap.cursedPlayerIds).toEqual([]);
  });

  it('别人出单张/对子不触发', () => {
    const hands = {
      p0: byId(0, 6), // 橐驼：♠3..♠9
      p1: byId(13, 19), // ♥3..♥9
      p2: byId(26, 32), // ♣3..♣9
    };
    const engine = mkEngine(hands, { p0: guoTT }, 'p0');
    // p0 自己起牌顺子 345：不触发
    let r = engine.playCards('p0', [0, 1, 2]);
    expect(r.ok && !r.suspended).toBe(true);
    // p1 响应 456：触发（他人 ≥3 张）→ 弃权
    r = engine.playCards('p1', [14, 15, 16]);
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
    // p2 响应 567：触发 → 弃权
    r = engine.playCards('p2', [28, 29, 30]);
    expect(r.ok && r.suspended).toBe(true);
    const ask2 = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'decline' }).ok).toBe(true);
    // p0、p1 无响应 → 过；轮末 p2 摸牌起牌
    expect(engine.pass('p0').ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    // 单张不触发：p2 起单 ♣8（第一轮已出掉 ♣567），p0 用 ♠9 恰好大一级响应，都无询问
    r = engine.playCards('p2', [31]);
    expect(r.ok && !r.suspended).toBe(true);
    r = engine.playCards('p0', [6]);
    expect(r.ok && !r.suspended).toBe(true);
    // p1、p2 压不了 → 过，轮末 p0 摸牌起牌
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
  });

  it('诅咒单王：压单 2；对方只能用炸弹压；被压后照常轮转', () => {
    const hands = {
      p0: [deck[52]!, ...byId(2, 5)], // 橐驼：小王 + ♠5..♠8
      p1: [...byRank(15, 4), byRank(9, 1)[0]!], // 四张 2 + ♠9
    };
    const engine = mkEngine(hands, { p0: guoTT }, 'p1');
    // p1 起单 2 → p0 单王压之
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true);
    const r = engine.playCards('p0', [deck[52]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'cards:played' && e.combo.type === 'singleJoker')).toBe(true);
    expect(engine.snapshotFor('p0').table?.type).toBe('singleJoker');
    // p1 用炸弹 3×2 压单王 → 触发地坛询问（炸弹 ≥3 张）→ 弃权
    const b = engine.playCards('p1', [hands.p1[1]!.id, hands.p1[2]!.id, hands.p1[3]!.id]);
    expect(b.ok && b.suspended).toBe(true);
    const ask = b.ok ? (b.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.snapshotFor('p0').table?.type).toBe('bomb');
    expect(engine.snapshotFor('p0').cursedPlayerIds).toEqual([]);
    // p0 压不了 → 过；轮末 p1 摸牌起牌
    const pr = engine.pass('p0');
    expect(pr.ok && pr.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p1')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p1');
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(2); // 剩 ♠9 + 摸 1
  });

  it('单王可以收尾获胜；非橐驼单王被拒', () => {
    const hands = {
      p0: [deck[52]!], // 橐驼：只剩小王
      p1: byId(0, 1), // ♠3♥3
    };
    const engine = mkEngine(hands, { p0: guoTT }, 'p0');
    const r = engine.playCards('p0', [deck[52]!.id]);
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');

    // 非橐驼：单王非法
    const engine2 = mkEngine({ p0: [deck[52]!, byId(0, 0)[0]!], p1: byId(13, 13) }, {}, 'p0');
    expect(engine2.playCards('p0', [deck[52]!.id]).ok).toBe(false);
  });

  it('打出的顺子含小王（百搭）→ 王按颜色双花色参与判定：翻 ♣2 判中', () => {
    // 手牌覆盖 147..161 → 牌堆顶 = ♣2（146）；p1 出 ♥4♥5+小王（=456 顺子）
    // 小王按颜色算 ♠♣：翻 ♣2 → ♣ 在 {♥,♠,♣} 中 → 判中
    const hands = {
      p0: [deck[0]!, deck[1]!, deck[2]!, ...byId(16, 29)], // 橐驼：♠345 + ♥6..♥2 + ♣3..♣6（17 张）
      p1: [deck[14]!, deck[15]!, deck[52]!, deck[6]!], // ♥4、♥5、小王、♠9
      p2: byId(147, 161), // ♦3..♦2 + 小王 + 大王（15 张）
    };
    expect(deckTopOf(hands).id).toBe(146); // ♣2
    const engine = mkEngine(hands, { p0: guoTT }, 'p0');
    expect(engine.playCards('p0', [0, 1, 2]).ok).toBe(true); // 自己出 ♠345 不触发
    const r = engine.playCards('p1', [14, 15, 52]); // 456 顺子（含小王百搭）→ 地坛询问
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' }); // 翻 ♣2
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan' && /成功/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.cursedPlayerIds).toContain('p1');
    expect(snap.revealed).toHaveLength(0); // 判定牌已弃置
  });

  it('翻出的判定牌是小王 → 按颜色双花色判中（打 ♠ 顺子，小王 = ♠♣）', () => {
    // 手牌只留大王（161）在 p2 → 牌堆顶 = 小王（160，♠♣）
    const hands = {
      p0: [deck[13]!, deck[14]!, deck[15]!, ...byId(16, 32)], // 橐驼：♥345 + ♥6..♥2 + ♣3..♣9（20 张）
      p1: [deck[1]!, deck[2]!, deck[3]!], // ♠456
      p2: [deck[161]!], // 大王（顶到 160 小王）
    };
    expect(deckTopOf(hands).id).toBe(160); // 小王
    const engine = mkEngine(hands, { p0: guoTT }, 'p0');
    expect(engine.playCards('p0', [13, 14, 15]).ok).toBe(true); // 自己出 ♥345 不触发
    const r = engine.playCards('p1', [1, 2, 3]); // ♠456 → 地坛询问
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' }); // 翻小王：♠♣ 含 ♠ → 判中
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan' && /成功/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.cursedPlayerIds).toContain('p1');
    expect(snap.revealed).toHaveLength(0);
  });

  it('诅咒对王（2026-10-03 用户确认）：一对王可收尾获胜', () => {
    const hands = {
      p0: [deck[52]!, deck[53]!], // 橐驼：只剩一对王
      p1: [deck[12]!, deck[25]!], // 对 2
    };
    const engine = mkEngine(hands, { p0: guoTT }, 'p0');
    const r = engine.playCards('p0', [deck[52]!.id, deck[53]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'cards:played' && e.combo.type === 'jokerPair')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
  });

  it('诅咒对王：对方只能用炸弹压', () => {
    const hands = {
      p0: [deck[52]!, deck[53]!, deck[0]!], // 橐驼：对王 + ♠3
      p1: [deck[13]!, deck[26]!, deck[39]!], // 三张 3（炸弹）
      p2: byRank(11, 5), // 五张 J
    };
    const engine = mkEngine(hands, { p0: guoTT }, 'p0');
    const r = engine.playCards('p0', [deck[52]!.id, deck[53]!.id]); // 起对王
    expect(r.ok).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'cards:played' && e.combo.type === 'jokerPair')).toBe(true);
    expect(engine.snapshotFor('p0').table?.type).toBe('jokerPair');
    // p1 炸弹压对王 → 触发地坛询问（他人 ≥3 张）→ 弃权
    const b = engine.playCards('p1', [13, 26, 39]);
    expect(b.ok && b.suspended).toBe(true);
    const ask = b.ok ? (b.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.type).toBe('bomb'); // 对王被炸弹压下
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(1); // 剩 ♠3
  });
});
