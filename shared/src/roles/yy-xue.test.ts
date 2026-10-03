import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import fishy from './fishy';
import guoTT from './guo-tt';
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

  it('橐驼单王（带"2 性质"）也触发：判定成功驱逐橐驼 + 巨石夺牌权', () => {
    // 把牌堆最末 15 张（♦3..♦2小王大王，id 147-161）塞进 p2 → 牌堆顶变为 ♣2（id 146，♣）
    const hands = {
      p0: [deck[52]!, ...byRank(9, 4)], // 橐驼：小王 + 四张 9
      p1: byRank(13, 5), // 巨石
      p2: [...deck.slice(147, 162)],
    };
    const engine = mkEngine(hands, { p0: guoTT, p1: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 橐驼起单王
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('suit'); // 巨石判定
    const a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: '♣' }); // 判定 ♣2 命中
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'player:eliminated' && e.playerId === 'p0')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players.find((p) => p.id === 'p0')!.eliminated).toBe(true);
    expect(snap.table).toBeNull();
    expect(snap.turnPlayerId).toBe('p1'); // 巨石起牌
  });

  it('橐驼单王也触发：判定失败不驱逐，判定牌摸回，桌面保留单王', () => {
    const hands = {
      p0: [deck[52]!, ...byRank(9, 4)], // 橐驼：小王 + 四张 9
      p1: byRank(13, 5), // 巨石
      p2: [...deck.slice(157, 162)], // 牌堆顶 = ♦Q（156）
    };
    const engine = mkEngine(hands, { p0: guoTT, p1: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 起单王
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: '♥' }); // ♦Q ≠ ♥
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && /失败/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players.find((p) => p.id === 'p0')!.eliminated).toBe(false);
    expect(snap.turnPlayerId).toBe('p1');
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(6); // 判定牌 ♦Q 摸回
    expect(snap.revealed).toHaveLength(0); // 判定牌已收走
    expect(snap.table?.type).toBe('singleJoker'); // 桌面保留橐驼的单王
  });

  it('倒序镜像（2026-10-03 用户确认）：他人出单 3 触发、翻到小王按 ♠♣ 算命中 → 驱逐夺牌权', () => {
    // p0 海棠起 ♠5 → 切倒序；p1 出 ♠3（倒序 3 压一切）触发巨石；判定翻到小王（♠♣），猜 ♠ 命中
    const hands = {
      p0: [deck[2]!, deck[4]!], // 海棠：♠5、♠7（留一张，起牌不获胜）
      p1: [deck[0]!, deck[13]!], // ♠3、♥3
      p2: [...byRank(13, 5), deck[161]!], // 巨石：五张 K + 大王（把牌堆顶推到 160 小王）
    };
    const engine = mkEngine(hands, { p0: fishy, p2: yyXue });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 起 ♠5 → 倒序（单 5 不触发）
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // 出 ♠3（倒序压一切）
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('suit'); // 倒序下 3 触发
    const a = engine.resolveAsk('p2', { askId: ask!.askId!, choice: '♠' }); // 翻到小王 = ♠♣ → 命中
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'player:eliminated' && e.playerId === 'p1')).toBe(true);
    const snap = engine.snapshotFor('p2');
    expect(snap.table).toBeNull();
    expect(snap.turnPlayerId).toBe('p2'); // 巨石夺牌权
  });

  it('倒序镜像（先判后切）：海棠在倒序出单 3 → 切回正序后巨石仍按切换前牌序判定（3 触发）', () => {
    // 洄游只有海棠出牌才切换（引擎按物理出牌者计）：起 ♠6 → 倒序；♥5 应（倒序恰好小一级，不切换）；
    // p2 过；海棠出 ♠3（倒序压一切，切换前 = 倒序）→ 3 触发巨石 → 切回正序
    const hands = {
      p0: [deck[3]!, deck[0]!, deck[1]!], // 海棠：♠6、♠3、♠4（留一张，出完不获胜）
      p1: [deck[15]!, deck[13]!], // ♥5、♥3
      p2: byRank(13, 5), // 巨石
    };
    const engine = mkEngine(hands, { p0: fishy, p2: yyXue });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 起 ♠6 → 倒序（单 6 不触发）
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]); // ♥5 压 ♠6（倒序恰好小一级），不触发
    expect(r1.ok && !r1.suspended).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    const r2 = engine.playCards('p0', [hands.p0[1]!.id]); // 海棠出 ♠3（倒序压一切，切换前 = 倒序）→ 切回正序
    expect(r2.ok && r2.suspended).toBe(true); // 按切换前（倒序）判定：3 触发巨石
    const snap = engine.snapshotFor('p2');
    expect(snap.orderReversed).toBe(false); // 已切回正序
    const ask = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('suit');
    expect(engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.snapshotFor('p2').table?.rank).toBe(3); // 桌面保留海棠的 3
  });

  it('倒序镜像（先判后切）：海棠在正序出单 2 → 切到倒序后巨石仍按切换前牌序判定（2 触发）', () => {
    const hands = {
      p0: [deck[12]!, deck[2]!], // 海棠：♠2、♠5
      p1: [deck[13]!, deck[14]!], // ♥3、♥4
      p2: byRank(13, 5), // 巨石
    };
    const engine = mkEngine(hands, { p0: fishy, p2: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 起 ♠2（正序）→ 切倒序
    expect(r.ok && r.suspended).toBe(true); // 按切换前（正序）判定：2 触发巨石
    const snap = engine.snapshotFor('p2');
    expect(snap.orderReversed).toBe(true); // 已切到倒序
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('suit');
    expect(engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
  });

  it('翻出的判定牌是王 → 按颜色双花色：猜 ♦ 对小王（♠♣）失败，判定牌摸回', () => {
    // p2 拿 大王（161）→ 牌堆顶 = 小王（160，♠♣）；猜 ♦ 不在 ♠♣ 中 → 失败
    const hands = {
      p0: [deck[12]!, ...byRank(9, 4)], // ♠2 + 四张 9
      p1: byRank(13, 5), // 巨石
      p2: [deck[161]!],
    };
    const engine = mkEngine(hands, { p1: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 出单 2
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: '♦' }); // 小王 = ♠♣，♦ 不命中
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && /失败/.test(e.text))).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players.find((p) => p.id === 'p0')!.eliminated).toBe(false);
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(6); // 判定牌小王摸回
    expect(snap.revealed).toHaveLength(0);
    expect(snap.table?.rank).toBe(15); // 桌面仍是 2
    expect(snap.turnPlayerId).toBe('p1');
    expect(engine.pass('p1').ok).toBe(true);
  });

  it('橐驼对王（2026-10-03 用户确认：一对王也要判定）：判定成功驱逐橐驼 + 夺牌权', () => {
    // 橐驼拿高位小王+大王（160、161）→ 牌堆顶 = ♦2（159）；对王触发巨石，猜 ♦ 命中
    const hands = {
      p0: [deck[160]!, deck[161]!], // 橐驼：对王
      p1: byRank(13, 5), // 巨石
      p2: deck.slice(147, 159), // ♦3..♦A（把牌堆顶推到 159 ♦2）
    };
    const engine = mkEngine(hands, { p0: guoTT, p1: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 打出对王
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('suit'); // 对王触发巨石
    const a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: '♦' }); // 翻到 ♦2 命中
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'player:eliminated' && e.playerId === 'p0')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.players.find((p) => p.id === 'p0')!.eliminated).toBe(true);
    expect(snap.table).toBeNull();
    expect(snap.turnPlayerId).toBe('p1'); // 巨石起牌
  });

  it('普通出牌不触发；判定次数用尽（玩家人数+2）后不再询问', () => {
    // 2 人局：上限 = 2+2 = 4 次。p0 依次出 2 触发 4 次判定。
    // 牌堆尾：大王(161) 在轮末先被 p0 摸走 → 判定依次翻 小王/♦A/♦Q/♦10；
    // 王按颜色双花色：小王=♠♣ 选 ♥ 失败，♦A/♦Q/♦10 选 ♠ 失败），第 5 张不再询问
    const hands = {
      p0: [...byRank(15, 5), ...byRank(9, 1)], // 5 张 2 + 1 张 9
      p1: byRank(13, 5), // 巨石
    };
    const engine = mkEngine(hands, { p1: yyXue });
    // 普通出牌不触发
    expect(engine.playCards('p0', [hands.p0[5]!.id]).ok).toBe(true); // 出单9，无询问
    expect(engine.pass('p1').ok).toBe(true);
    // 4 次判定（全部失败：第一次避开小王 ♠♣，其余避开 ♦）
    const guesses = ['♥', '♠', '♠', '♠'];
    for (let i = 0; i < 4; i++) {
      const r = engine.playCards('p0', [hands.p0[i]!.id]); // 出单2
      expect(r.ok && r.suspended).toBe(true);
      const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
      const a = engine.resolveAsk('p1', { askId: ask!.askId!, choice: guesses[i]! });
      expect(a.ok).toBe(true);
      expect(engine.pass('p1').ok).toBe(true); // 让 p1 过，回到 p0 起牌
    }
    // 第 5 张 2：次数用尽，不再询问（直接正常流程）
    const r5 = engine.playCards('p0', [hands.p0[4]!.id]);
    expect(r5.ok).toBe(true);
    expect(r5.ok && r5.suspended).toBe(false);
  });
});
