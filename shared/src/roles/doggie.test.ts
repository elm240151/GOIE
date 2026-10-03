import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import doggie from './doggie';
import fishy from './fishy';
import yyXue from './yy-xue';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const smallJoker = deck.find((c) => c.rank === 16)!;

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

describe('修勾（答疑）', () => {
  it('有人出对子 → 询问 3~A；改点后按新点判定（旧点压不过、新点压得过），牌面实体不变', () => {
    const hands = {
      p0: [...byRank(3, 2), ...byRank(11, 2)], // 修勾：对3 + 对J
      p1: [...byRank(4, 2), ...byRank(10, 2), ...byRank(9, 1)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 对3
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('choice');
    expect(ask?.options).toEqual(['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '放弃']);
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: '9' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'da-yi')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.table?.type).toBe('pair');
    expect(snap.table?.rank).toBe(9); // 判定点数改为 9
    expect(snap.tableRankNote).toEqual({ rank: 9 });
    expect(snap.table?.cards.map((c) => c.id).sort()).toEqual([hands.p0[0]!.id, hands.p0[1]!.id]); // 牌面不变
    // 旧点压不过（对4），新点压得过（对10 = 9+1）
    expect(engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]).ok).toBe(false);
    const b = engine.playCards('p1', [hands.p1[2]!.id, hands.p1[3]!.id]);
    expect(b.ok).toBe(true);
    expect(b.ok && b.suspended).toBe(false); // 本回合已答疑过，不再询问
    expect(engine.snapshotFor('p0').tableRankNote).toBeNull(); // 换桌后改点清除
  });

  it('顺子改起点：345 改按 9 → 旧窗口 456 压不过、新窗口 10JQ 压得过', () => {
    const hands = {
      p0: [...byRank(3, 1), ...byRank(4, 1), ...byRank(5, 1), ...byRank(13, 2)], // 修勾
      p1: [...byRank(10, 1), ...byRank(11, 1), ...byRank(12, 1), ...byRank(4, 1), ...byRank(5, 1), ...byRank(6, 1)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]); // 345
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('choice');
    engine.resolveAsk('p0', { askId: ask!.askId!, choice: '9' });
    expect(engine.snapshotFor('p1').table?.rank).toBe(9);
    expect(engine.playCards('p1', [hands.p1[3]!.id, hands.p1[4]!.id, hands.p1[5]!.id]).ok).toBe(false); // 456 压不过
    expect(engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]).ok).toBe(true); // 10JQ 压得过
  });

  it('单张不触发；弃权不消耗（同回合再问）；轮末重置后新回合可再问', () => {
    const hands = {
      p0: [...byRank(3, 2), ...byRank(5, 2), ...byRank(7, 1)], // 修勾
      p1: [...byRank(4, 2), ...byRank(6, 2), ...byRank(8, 2)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    // 单张不触发
    const r0 = engine.playCards('p0', [hands.p0[4]!.id]); // 单7
    expect(r0.ok && r0.suspended).toBe(false);
    expect(engine.playCards('p1', [hands.p1[4]!.id]).ok).toBe(true); // 单8
    engine.pass('p0'); // 轮末：p1 摸 1 起新轮
    // 对4 → 询问 → 放弃（不消耗次数）
    const r1 = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]);
    expect(r1.ok && r1.suspended).toBe(true);
    const ask1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    engine.resolveAsk('p0', { askId: ask1!.askId!, choice: '放弃' });
    expect(engine.snapshotFor('p1').table?.rank).toBe(4); // 未改点
    // 同回合再来一手 ≥2 张 → 仍询问
    const r2 = engine.playCards('p0', [hands.p0[2]!.id, hands.p0[3]!.id]); // 对5
    expect(r2.ok && r2.suspended).toBe(true);
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    engine.resolveAsk('p0', { askId: ask2!.askId!, choice: '9' });
    engine.pass('p1'); // p1 压不了改点后的对9 → 过 → 轮末
    // 新回合（轮末已重置）：起对3 再询问 → 弃权（手牌剩上轮抽到的小王，未打完）
    const r3 = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    expect(r3.ok && r3.suspended).toBe(true);
    expect(r3.ok ? (r3.pendingAsk as SkillAsk)?.kind : null).toBe('choice');
    engine.resolveAsk('p0', { askId: (r3.ok ? (r3.pendingAsk as SkillAsk) : null)!.askId!, choice: '放弃' });
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing'); // 手牌剩上轮抽到的小王，单张也打不完
    expect(snap.players.find((p) => p.id === 'p0')?.handCount).toBe(1);
  });

  it('自己打出的 ≥2 张也触发（2+鬼 补对2 改按 K）', () => {
    const hands = {
      p0: [...byRank(15, 1), ...byRank(9, 2), smallJoker], // 修勾：2 + 小王 + 对9
      p1: [...byRank(13, 5)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[3]!.id]); // 2+鬼 = 对2
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('choice');
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'K' });
    expect(a.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.table?.type).toBe('pair');
    expect(snap.table?.rank).toBe(13);
    expect(snap.tableRankNote).toEqual({ rank: 13 });
  });

  it('与巨石同场：对2 被答疑改点后巨石仍按实体牌触发（不因钩子顺序漏判）', () => {
    const hands = {
      p0: [...byRank(15, 2), ...byRank(9, 3)],
      p1: [...byRank(13, 5)], // 修勾（座位在巨石前）
      p2: [...byRank(11, 5)], // 巨石
    };
    const engine = mkEngine(hands, { p1: doggie, p2: yyXue });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 对2
    expect(r.ok && r.suspended).toBe(true);
    const ask1 = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask1?.kind).toBe('choice'); // 先问修勾
    const a = engine.resolveAsk('p1', { askId: ask1!.askId!, choice: '9' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.suspended).toBe(true); // 改点后巨石接着问
    const ask2 = a.ok ? (a.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('suit');
    const d = engine.resolveAsk('p2', { askId: ask2!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    const snap = engine.snapshotFor('p2');
    expect(snap.table?.rank).toBe(9); // 改点生效
    expect(snap.tableRankNote).toEqual({ rank: 9 });
  });

  it('倒序（与海棠同场）：顺子改的是起点 = 最高点数，后续按新起点接（KQJ 压 Q 起点）', () => {
    const hands = {
      p0: [...byRank(4, 1), ...byRank(5, 1), ...byRank(6, 1), ...byRank(10, 1), ...byRank(9, 1), ...byRank(8, 1), ...byRank(13, 2)], // 修勾
      p1: [...byRank(6, 1), ...byRank(7, 1), ...byRank(8, 1), ...byRank(13, 1), ...byRank(12, 1), ...byRank(11, 1)], // 海棠
    };
    const engine = mkEngine(hands, { p0: doggie, p1: fishy });
    // 修勾起 456 → 弃权 → 海棠 678 压（切换倒序：876 起点 8）→ 弃权
    const r0 = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]);
    expect(r0.ok && r0.suspended).toBe(true);
    engine.resolveAsk('p0', { askId: (r0.ok ? (r0.pendingAsk as SkillAsk) : null)!.askId!, choice: '放弃' });
    const r1 = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id]);
    expect(r1.ok && r1.suspended).toBe(true);
    engine.resolveAsk('p0', { askId: (r1.ok ? (r1.pendingAsk as SkillAsk) : null)!.askId!, choice: '放弃' });
    expect(engine.snapshotFor('p1').orderReversed).toBe(true);
    expect(engine.snapshotFor('p1').table?.rank).toBe(8);
    // 修勾倒序压 T98（起点 10）→ 答疑改起点为 Q
    const r2 = engine.playCards('p0', [hands.p0[3]!.id, hands.p0[4]!.id, hands.p0[5]!.id]);
    expect(r2.ok && r2.suspended).toBe(true);
    const ask = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'Q' });
    const snap2 = engine.snapshotFor('p1');
    expect(snap2.table?.rank).toBe(12);
    expect(snap2.tableRankNote).toEqual({ rank: 12 });
    // 倒序下只有起点 13/14 能压：KQJ 起点 13 压得过（未改点则起点 11 压不过起点 10）
    const r3 = engine.playCards('p1', [hands.p1[3]!.id, hands.p1[4]!.id, hands.p1[5]!.id]);
    expect(r3.ok).toBe(true);
    expect(r3.ok && r3.suspended).toBe(false); // 本回合已答疑过
    const snap3 = engine.snapshotFor('p0');
    expect(snap3.tableRankNote).toBeNull(); // 换桌清除
  });
});

describe('修勾（狂吠）', () => {
  it('出牌后询问压自己的牌；可连压，压不了/主动停才轮到下家', () => {
    const hands = {
      p0: [...byRank(5, 1), ...byRank(6, 1), ...byRank(7, 1), ...byRank(9, 1), ...byRank(11, 1)], // 修勾
      p1: [...byRank(13, 5)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r0 = engine.playCards('p0', [hands.p0[0]!.id]); // 单5
    expect(r0.ok && r0.suspended).toBe(true);
    const ask1 = r0.ok ? (r0.pendingAsk as SkillAsk) : null;
    expect(ask1?.kind).toBe('selfFollow');
    const a1 = engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'yes', cardIds: [hands.p0[1]!.id] }); // 压单6
    expect(a1.ok).toBe(true);
    expect(a1.ok && a1.events.some((e) => e.type === 'cards:played' && e.playerId === 'p0')).toBe(true);
    // 连压：还能再压单7
    expect(a1.ok && a1.suspended).toBe(true);
    const ask2 = a1.ok ? (a1.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('selfFollow');
    expect(ask2?.askId).not.toBe(ask1?.askId);
    const a2 = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes', cardIds: [hands.p0[2]!.id] }); // 压单7
    expect(a2.ok && a2.suspended).toBe(false); // 单9/J 压不了单7 → 轮到下家
    const snap = engine.snapshotFor('p1');
    expect(snap.table?.rank).toBe(7);
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(2);
    expect(snap.turnPlayerId).toBe('p1');
  });

  it('放弃 → 桌面不变，轮到下家', () => {
    const hands = {
      p0: [...byRank(5, 1), ...byRank(6, 1), ...byRank(9, 1)], // 修勾
      p1: [...byRank(13, 5)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r0 = engine.playCards('p0', [hands.p0[0]!.id]); // 单5
    const ask1 = r0.ok ? (r0.pendingAsk as SkillAsk) : null;
    engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'decline' });
    const snap = engine.snapshotFor('p0');
    expect(snap.table?.rank).toBe(5);
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(2); // 牌没出
    expect(snap.turnPlayerId).toBe('p1');
  });

  it('压完手牌直接获胜', () => {
    const hands = {
      p0: [...byRank(5, 1), ...byRank(6, 1)], // 修勾
      p1: [...byRank(13, 5)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r0 = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask1 = r0.ok ? (r0.pendingAsk as SkillAsk) : null;
    const a = engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'yes', cardIds: [hands.p0[1]!.id] });
    expect(a.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
  });

  it('压不了不询问，直接轮到下家', () => {
    const hands = {
      p0: [...byRank(5, 1), ...byRank(3, 1)], // 修勾
      p1: [...byRank(13, 5)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r0 = engine.playCards('p0', [hands.p0[0]!.id]); // 单5：3 压不了
    expect(r0.ok && r0.suspended).toBe(false);
    expect(engine.snapshotFor('p1').turnPlayerId).toBe('p1');
  });

  it('非法选牌（压不过）→ 报错并重新询问；重新选对后照常压', () => {
    const hands = {
      p0: [...byRank(5, 1), ...byRank(6, 1), ...byRank(8, 1)], // 修勾
      p1: [...byRank(13, 5)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r0 = engine.playCards('p0', [hands.p0[0]!.id]); // 单5
    const ask1 = r0.ok ? (r0.pendingAsk as SkillAsk) : null;
    const a1 = engine.resolveAsk('p0', { askId: ask1!.askId!, choice: 'yes', cardIds: [hands.p0[2]!.id] }); // 单8 压不过 5
    expect(a1.ok).toBe(true);
    expect(
      a1.ok && a1.events.some((e) => e.type === 'game:error' && (e as { reason?: string }).reason?.includes('压不过'))
    ).toBe(true);
    expect(a1.ok && a1.suspended).toBe(true); // 重新询问，不消耗机会
    const ask2 = a1.ok ? (a1.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('selfFollow');
    const a2 = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes', cardIds: [hands.p0[1]!.id] }); // 单6
    expect(a2.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.table?.rank).toBe(6);
    expect(snap.turnPlayerId).toBe('p1'); // 单8 压不了单6 → 轮到下家
  });

  it('留 2 禁止收尾在狂吠中生效：只剩单 2 时不询问', () => {
    const hands = {
      p0: [...byRank(5, 1), ...byRank(15, 1)], // 修勾
      p1: [...byRank(13, 5)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r0 = engine.playCards('p0', [hands.p0[0]!.id]); // 单5 → 只剩单2（压了会收尾）
    expect(r0.ok && r0.suspended).toBe(false);
    expect(engine.snapshotFor('p1').turnPlayerId).toBe('p1');
  });

  it('倒序（与海棠同场）：狂吠按倒序规则压；只剩单 3（倒序禁止收尾）不询问', () => {
    const hands = {
      p0: [...byRank(8, 2), ...byRank(7, 1), ...byRank(3, 1)], // 修勾：两张 8、7、3
      p1: [...byRank(9, 1), ...byRank(5, 1), ...byRank(4, 1)], // 海棠
    };
    const engine = mkEngine(hands, { p0: doggie, p1: fishy });
    // 修勾起 8 → 狂吠压不了（没有 9）→ 海棠 9 压 → 切倒序
    const r0 = engine.playCards('p0', [hands.p0[0]!.id]);
    expect(r0.ok && r0.suspended).toBe(false);
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true); // 海棠压 9 → 倒序
    // 修勾倒序压 8（恰好小一级）→ 狂吠再压 7
    const r2 = engine.playCards('p0', [hands.p0[1]!.id]);
    expect(r2.ok && r2.suspended).toBe(true);
    const ask = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('selfFollow');
    const a = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes', cardIds: [hands.p0[2]!.id] });
    expect(a.ok).toBe(true);
    // 只剩单3：倒序 3 压一切但会收尾 → 不询问，轮到海棠
    expect(a.ok && a.suspended).toBe(false);
    const snap = engine.snapshotFor('p1');
    expect(snap.table?.rank).toBe(7);
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(1);
    expect(snap.turnPlayerId).toBe('p1');
  });

  it('答疑与狂吠同手衔接：改点后立刻按新点询问狂吠', () => {
    const hands = {
      p0: [...byRank(3, 2), ...byRank(10, 2), ...byRank(9, 1)], // 修勾
      p1: [...byRank(13, 5)],
    };
    const engine = mkEngine(hands, { p0: doggie });
    const r0 = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 对3
    expect(r0.ok && r0.suspended).toBe(true);
    const ask1 = r0.ok ? (r0.pendingAsk as SkillAsk) : null;
    expect(ask1?.kind).toBe('choice');
    const a1 = engine.resolveAsk('p0', { askId: ask1!.askId!, choice: '9' }); // 对3 改按对9
    expect(a1.ok && a1.suspended).toBe(true);
    const ask2 = a1.ok ? (a1.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('selfFollow'); // 改点后狂吠接着问
    const a2 = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes', cardIds: [hands.p0[2]!.id, hands.p0[3]!.id] }); // 对10 压对9
    expect(a2.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.table?.rank).toBe(10);
    expect(snap.tableRankNote).toBeNull(); // 换桌清除改点
    expect(snap.turnPlayerId).toBe('p1'); // 单9 压不了对10
  });
});
