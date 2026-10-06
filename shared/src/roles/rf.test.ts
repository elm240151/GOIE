import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import type { GameEvent } from '../engine/events';
import { mulberry32 } from '../engine/rng';
import captain from './captain';
import doggie from './doggie';
import duoGe from './duo-ge';
import fishy from './fishy';
import kingNan from './king-nan';
import rf from './rf';
import skywalker from './skywalker';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const pick = (r: number, s: number) => deck.find((c) => c.rank === r && c.suit === s)!;
const jokerSmall = deck.find((c) => c.rank === 16)!;

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

/** 用 range 内未被使用的牌把各手牌补到 targets 张（保持各手互斥、不碰已有牌） */
function pad(hands: Record<string, Card[]>, targets: Record<string, number>, range: [number, number]): void {
  const used = new Set<number>();
  for (const h of Object.values(hands)) for (const c of h) used.add(c.id);
  const order = Object.keys(targets);
  let i = 0;
  for (let id = range[0]; id <= range[1]; id++) {
    if (used.has(id)) continue;
    for (let k = 0; k < order.length; k++) {
      const pid = order[(i + k) % order.length]!;
      if (hands[pid]!.length >= targets[pid]!) continue;
      hands[pid]!.push(deck[id]!);
      i = (i + k + 1) % order.length;
      break;
    }
  }
}

const askOf = (r: { ok: boolean; pendingAsk?: SkillAsk }): SkillAsk | null => (r.ok ? (r.pendingAsk ?? null) : null);
const decline = (engine: GameEngine, by: string, ask: SkillAsk | null) => {
  expect(engine.resolveAsk(by, { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
};
const handOf = (engine: GameEngine, pid: string): number =>
  engine.snapshotFor('p0').players.find((p) => p.id === pid)!.handCount;
const pancakeOf = (engine: GameEngine, pid: string): number =>
  engine.snapshotFor('p0').players.find((p) => p.id === pid)!.pancakeCount;
/** 牌守恒：手牌 + 桌面 + 牌堆 + 弃牌堆 + 饼 */
const totalCards = (engine: GameEngine): number => {
  const snap = engine.snapshotFor('p0');
  return (
    snap.players.reduce((s, p) => s + p.handCount + p.pancakeCount, 0) +
    (snap.table ? snap.table.cards.length : 0) +
    snap.deckCount +
    snap.discardCount +
    snap.stagedDiscards.reduce((x, e) => x + e.cards.length, 0)
  );
};
const eventsOf = (r: { ok: boolean; events?: { type: string }[] }): string[] =>
  (r.ok ? (r.events ?? []) : []).map((e) => e.type);

/** 无技能路人角色 */
function plain(): RoleDef {
  return { id: 'plain', name: '路人', skills: [] };
}

/** 测试用窃牌角色：主动技从目标手中拿 1 张牌（模拟换牌/拼点类主动技的收牌路径） */
function thief(): RoleDef {
  return {
    id: 'thief',
    name: '窃贼',
    skills: [{ id: 'steal', name: '窃取', description: '测试用：从目标手中拿 1 张牌' }],
    skillActions: [{ skillId: 'steal', when: 'myTurn', label: '窃取' }],
    hooks: {
      onSkillAction(ctx, req) {
        if (req.skillId !== 'steal') return;
        const a = ctx.answer;
        if (!a) {
          const others = ctx.game
            .players()
            .filter((p) => p.id !== ctx.self.id && p.handCount > 0)
            .map((p) => p.id);
          return { ok: true, ask: { kind: 'pickTarget', prompt: '选择窃取目标', targetCandidates: others } };
        }
        if (a.targetPlayerId) {
          const card = ctx.game.handOf(a.targetPlayerId)[0];
          if (!card) return;
          ctx.game.giveFrom(a.targetPlayerId, [card.id]);
          ctx.game.giveTo(ctx.self.id, [card]);
          return { ok: true, modify: { endTurn: true } };
        }
        return;
      },
    },
  };
}

describe('兰登·费夫 R.F：吐饼', () => {
  it('无牌权限制：响应他人只能打 2 或炸弹，普通恰好牌被拒', () => {
    const hands = {
      p0: byRank(5, 5), // 起单5
      p1: [pick(6, 0), pick(15, 0), pick(9, 0)], // R.F：单6/单2/单9
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm'); // 单6 恰好 → 先问吃饼
    expect(ask?.prompt).toContain('吐饼');
    decline(engine, 'p1', ask); // 弃权本手
    const blocked = engine.playCards('p1', [hands.p1[0]!.id]); // 单6 接单5（恰好）→ 无牌权被拒
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toContain('吐饼');
    expect(engine.playCards('p1', [hands.p1[1]!.id]).ok).toBe(true); // 单2 压一切 ✓
  });

  it('倒序镜像：响应他人只能打 3 或炸弹', () => {
    const hands = {
      p0: [pick(9, 0), pick(4, 0)], // 海棠：起单9 → 倒序
      p1: [pick(8, 0), pick(3, 0), pick(6, 0)], // R.F：单8（恰好 −1）/单3/单6
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: fishy, p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm'); // 倒序单8 恰好接单9 → 先问吃饼
    decline(engine, 'p1', ask);
    const blocked = engine.playCards('p1', [hands.p1[0]!.id]); // 单8 → 无牌权被拒（倒序恰好也只能吃饼）
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toContain('吐饼');
    expect(engine.playCards('p1', [hands.p1[1]!.id]).ok).toBe(true); // 单3 压一切 ✓
  });

  it('领出（有牌权）不受限制；自己打出的不触发吃饼询问', () => {
    const hands = {
      p0: byRank(5, 5),
      p1: [pick(6, 0), pick(9, 0)], // R.F
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf }, 'p1');
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // 起单6
    expect(r.ok).toBe(true);
    expect(askOf(r)).toBeNull(); // 自己打出的不触发
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p2'); // 正常轮转
  });

  it('吃饼全流程：亮一组恰好牌 → 摸 N → 倒置 N 成饼；归属不变、轮末 R.F 起牌、牌守恒', () => {
    const hands = {
      p0: byRank(5, 5), // 起单5
      p1: [pick(6, 0), pick(9, 0), pick(10, 0), pick(11, 0), pick(12, 0)], // R.F 5 张
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const before = totalCards(engine);
    expect(before).toBe(162);
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    // ① 确认 → 自选一组恰好牌（N = 桌面张数 = 1）
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    expect(pick1?.kind).toBe('pickCards');
    expect(pick1?.min).toBe(1);
    expect(pick1?.max).toBe(1);
    expect(pick1?.cards?.some((c) => c.id === hands.p1[0]!.id)).toBe(true); // 候选含恰好牌
    // ② 亮单6 → 摸 1 张
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id] });
    expect(a2.ok).toBe(true);
    expect(eventsOf(a2)).toContain('cards:revealed'); // 公开亮牌
    expect(eventsOf(a2)).toContain('cards:drawn');
    expect(handOf(engine, 'p1')).toBe(6); // 5 + 1（亮出的牌留在手中）
    const pick2 = askOf(a2);
    expect(pick2?.kind).toBe('pickCards');
    expect(pick2?.min).toBe(1);
    expect(pick2?.max).toBe(1);
    expect(pick2?.cards?.length).toBe(6); // 全手牌可选
    // ③ 倒置 1 张成饼
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![0]!.id] });
    expect(a3.ok).toBe(true);
    expect(eventsOf(a3)).toContain('pancake:flipped');
    expect(eventsOf(a3)).not.toContain('table:attributed'); // 桌面归属不变
    const snap = engine.snapshotFor('p1');
    expect(snap.players.find((p) => p.id === 'p1')!.pancakeCount).toBe(1);
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(5);
    expect(totalCards(engine)).toBe(162); // 饼参与守恒
    expect(snap.turnPlayerId).toBe('p2'); // 轮转正常（R.F 无 2/炸自动过）
    // p2 过（R.F 已自动过，passCount 到 2）→ 轮末：R.F（吃饼者）获得起牌权并摸 1 张
    expect(engine.pass('p2').ok).toBe(true);
    const snap2 = engine.snapshotFor('p1');
    expect(snap2.roundLeaderId).toBe('p1');
    expect(handOf(engine, 'p1')).toBe(6); // 轮末摸 1 张
    expect(totalCards(engine)).toBe(162);
  });

  it('饼数 ≥ 手牌数立即获胜', () => {
    const hands = {
      p0: byRank(5, 5),
      p1: [pick(6, 0)], // R.F 仅 1 张
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id] });
    const pick2 = askOf(a2);
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![0]!.id] });
    expect(a3.ok).toBe(true);
    // 摸 1 倒 1 → 饼 1 ≥ 手牌 1 → 立即获胜
    const ended = (a3 as { events?: GameEvent[] }).events?.find((e) => e.type === 'game:ended');
    expect(ended && (ended as { winnerId: string | null }).winnerId).toBe('p1');
    expect(engine.snapshotFor('p0').phase).toBe('finished');
    expect(engine.snapshotFor('p0').winnerId).toBe('p1');
  });

  it('主动出牌后饼数 ≥ 手牌数 → 立即获胜（2026-10-06 用户实机 bug：获胜只在吃饼结算处检查）', () => {
    const hands = {
      p0: byRank(5, 5), // 起对5（留 3 张兜底，避免出完即胜抢跑）
      p1: [pick(6, 0), pick(6, 1), pick(9, 0)], // R.F：对6 恰好接对5 + 单9
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    // 亮对6 → 摸 2 → 倒置摸到的 2 张成饼（对6 留手中）→ 饼 2、手牌 3：吃饼时 2 < 3 不获胜
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] });
    const pick2 = askOf(a2);
    expect(pick2?.cards?.length).toBe(5); // 3 + 摸 2
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![3]!.id, pick2!.cards![4]!.id] });
    expect(a3.ok).toBe(true);
    expect(pancakeOf(engine, 'p1')).toBe(2);
    expect(handOf(engine, 'p1')).toBe(3);
    expect(engine.snapshotFor('p1').phase).toBe('playing'); // 吃饼时未获胜
    // 轮末：p1 自动过（无 2/炸）、p2 过 → R.F 获得起牌权摸 1 → 主动出对6 → 手牌 2 = 饼 2 → 立即获胜
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.snapshotFor('p1').roundLeaderId).toBe('p1');
    expect(handOf(engine, 'p1')).toBe(4);
    const r2 = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 主动出对6
    expect(r2.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1');
    expect(totalCards(engine)).toBe(162); // 饼参与守恒
  });

  it('出牌后已满足饼 ≥ 手牌 → 直接宣判获胜，不再触发非亡语技能（答疑被触发是 bug，2026-10-06 用户实机发现）', () => {
    const hands = {
      p0: byRank(5, 5), // 起对5（留 3 张兜底，避免出完即胜抢跑）
      p1: [pick(6, 0), pick(6, 1), pick(9, 0)], // R.F：对6 恰好接对5 + 单9
      p2: byRank(3, 5), // 修勾：压不了对5 的杂牌
    };
    const engine = mkEngine(hands, { p1: rf, p2: doggie });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    const da = askOf(r);
    expect(da?.kind).toBe('choice'); // 对子是答疑可改判牌型 → 修勾先被问（此时 R.F 饼 0 < 手牌 3，未满足获胜条件）
    const d = engine.resolveAsk('p2', { askId: da!.askId!, choice: 'decline' }); // 修勾弃权答疑
    const ask = askOf(d); // 弃权答疑后轮到吃饼询问
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] });
    const pick2 = askOf(a2);
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![3]!.id, pick2!.cards![4]!.id] });
    expect(a3.ok).toBe(true);
    expect(pancakeOf(engine, 'p1')).toBe(2);
    expect(handOf(engine, 'p1')).toBe(3);
    // R.F 自动过（无 2/炸弹）→ 修勾过 → 轮末 R.F 起牌摸 1 → 主动出对6 → 手牌 2 = 饼 2
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.snapshotFor('p1').roundLeaderId).toBe('p1');
    const r2 = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 对子：答疑本会询问
    expect(r2.ok).toBe(true);
    expect(askOf(r2)).toBeNull(); // 已满足获胜条件 → 修勾答疑（非亡语）不再触发
    const snap = engine.snapshotFor('p1');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1');
    expect(totalCards(engine)).toBe(162);
  });

  it('已满足饼 ≥ 手牌时亡语（旺旺）照常先结算：弃权判定后获胜', () => {
    const hands = {
      p0: [pick(5, 0), pick(5, 1), ...byRank(7, 3)], // 楠王：起对5 + 3 张兜底
      p1: byRank(3, 5), // 修勾：杂牌（压不了对5，答疑在对2 时本会询问）
      p2: [pick(6, 0), pick(6, 1), pick(15, 0), pick(15, 1)], // R.F：对6 恰好 + 对2（2 的编码是 15）
    };
    const engine = mkEngine(hands, { p0: kingNan, p1: doggie, p2: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 楠王起对5
    const da = askOf(r);
    expect(da?.kind).toBe('choice'); // 对子是答疑可改判牌型 → 修勾先被问（此时 R.F 饼 0 < 手牌 4，未满足获胜条件）
    const d = engine.resolveAsk('p1', { askId: da!.askId!, choice: 'decline' }); // 修勾弃权答疑
    const ask = askOf(d);
    expect(ask?.kind).toBe('confirm'); // R.F 对6 恰好 → 吃饼
    const a1 = engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p2', { askId: pick1!.askId!, cardIds: [hands.p2[0]!.id, hands.p2[1]!.id] });
    const pick2 = askOf(a2);
    expect(pick2?.cards?.length).toBe(6); // 4 + 摸 2
    const a3 = engine.resolveAsk('p2', { askId: pick2!.askId!, cardIds: [pick2!.cards![4]!.id, pick2!.cards![5]!.id] });
    expect(a3.ok).toBe(true);
    expect(pancakeOf(engine, 'p2')).toBe(2);
    expect(handOf(engine, 'p2')).toBe(4);
    // 楠王（桌面 owner）自动过 → 修勾过 → R.F 吃过饼不能过、有对2 必须打 → 压楠王对5
    expect(engine.snapshotFor('p2').turnPlayerId).toBe('p1');
    expect(engine.pass('p1').ok).toBe(true);
    const r2 = engine.playCards('p2', [hands.p2[2]!.id, hands.p2[3]!.id]); // 对2：手牌 2 = 饼 2
    expect(r2.ok).toBe(true);
    const ww = askOf(r2);
    expect(ww?.kind).toBe('confirm'); // 亡语旺旺照常询问（压的是楠王的牌）
    expect(ww?.prompt).toContain('旺旺');
    expect(ww?.prompt).not.toContain('答疑'); // 非亡语的答疑不询问
    // 弃权判定 → 手牌不变 → 条件仍满足 → 宣判获胜
    const done = engine.resolveAsk('p0', { askId: ww!.askId!, choice: 'decline' });
    expect(done.ok).toBe(true);
    const snap = engine.snapshotFor('p2');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p2');
    expect(totalCards(engine)).toBe(162);
  });

  it('他人技能致手牌减少也触发获胜：法音弃牌（2026-10-06 用户定稿：不看来因，除非有亡语）', () => {
    const hands = {
      p0: byRank(5, 5), // 起对5
      p1: [pick(6, 0), pick(6, 1), pick(9, 0)], // R.F：对6 恰好接对5 + 单9
      p2: [pick(6, 2), pick(6, 3), ...byRank(4, 3)], // 惰戈：对6（♣♦ 两花色触发法音）压对5 + 3 张杂牌
    };
    const engine = mkEngine(hands, { p1: rf, p2: duoGe });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    // 亮对6 → 摸 2 → 倒置摸到的 2 张成饼 → 饼 2、手牌 3：吃饼时 2 < 3 不获胜
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] });
    const pick2 = askOf(a2);
    expect(pick2?.cards?.length).toBe(5); // 3 + 摸 2
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![3]!.id, pick2!.cards![4]!.id] });
    expect(a3.ok).toBe(true);
    expect(pancakeOf(engine, 'p1')).toBe(2);
    expect(handOf(engine, 'p1')).toBe(3);
    expect(engine.snapshotFor('p0').phase).toBe('playing'); // 吃饼时未获胜
    // p1 自动过（无 2/炸弹）→ p2（惰戈）出对6♣♦ 压对5 → 法音选 R.F 弃 1 张 → 手牌 2 = 饼 2 → 立即获胜
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p2');
    const r2 = engine.playCards('p2', [hands.p2[0]!.id, hands.p2[1]!.id]);
    const fask = askOf(r2);
    expect(fask?.prompt).toContain('法音');
    const fy = engine.resolveAsk('p2', { askId: fask!.askId!, choice: 'yes' });
    const tpick = askOf(fy);
    expect(tpick?.kind).toBe('pickTarget');
    const tsel = engine.resolveAsk('p2', { askId: tpick!.askId!, targetPlayerId: 'p1' });
    const dpick = askOf(tsel);
    expect(dpick?.kind).toBe('pickCards');
    const done = engine.resolveAsk('p1', { askId: dpick!.askId!, cardIds: [hands.p1[2]!.id] }); // 弃单9
    expect(done.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1');
    expect(totalCards(engine)).toBe(162);
  });

  it('主动技窃牌致手牌减少也触发获胜（2026-10-06 用户定稿：不看来因）', () => {
    const hands = {
      p0: byRank(5, 5), // 起对5
      p1: [pick(6, 0), pick(6, 1), pick(9, 0)], // R.F：对6 恰好接对5 + 单9
      p2: byRank(4, 5), // 窃贼
    };
    const engine = mkEngine(hands, { p1: rf, p2: thief() });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    const ask = askOf(r);
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] });
    const pick2 = askOf(a2);
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![3]!.id, pick2!.cards![4]!.id] });
    expect(a3.ok).toBe(true);
    expect(pancakeOf(engine, 'p1')).toBe(2);
    expect(handOf(engine, 'p1')).toBe(3);
    // p1 自动过 → p2 发动主动技窃取 R.F 一张牌 → 手牌 2 = 饼 2 → 立即获胜
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p2');
    const u = engine.useSkillAction('p2', { skillId: 'steal' });
    const tpick = askOf(u);
    expect(tpick?.kind).toBe('pickTarget');
    const done = engine.resolveAsk('p2', { askId: tpick!.askId!, targetPlayerId: 'p1' });
    expect(done.ok).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1');
    expect(totalCards(engine)).toBe(162);
  });

  it('吃饼摸牌超手牌上限 → 淘汰（不进入倒置阶段）', () => {
    const hands = {
      p0: byRank(5, 5),
      p1: [pick(6, 0)], // R.F：吃到 21 张
      p2: byRank(4, 5),
    };
    pad(hands, { p1: 20 }, [3, 160]);
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id] });
    expect(a2.ok).toBe(true);
    expect(askOf(a2)).toBeNull(); // 摸到 21 张被淘汰 → 无倒置询问
    const snap = engine.snapshotFor('p0');
    const p1 = snap.players.find((p) => p.id === 'p1')!;
    expect(p1.eliminated).toBe(true);
    expect(p1.handCount).toBe(0);
    expect(totalCards(engine)).toBe(162);
  });

  it('阿色抽你限制适用：非指定响应者不能吃饼；指定 R.F 本人时可吃饼', () => {
    const hands = { p0: byRank(3, 5), p1: [pick(6, 0), pick(4, 0)], p2: [pick(4, 1), pick(10, 0)] };
    const engine = mkEngine(hands, { p0: captain, p1: rf });
    // 开局整备：阿色指定 p2（不是 R.F）
    const startAsk = engine.snapshotFor('p0').pendingAsk;
    expect(startAsk).not.toBeNull();
    const yes = engine.resolveAsk('p0', { askId: startAsk!.askId, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p2' }).ok).toBe(true);
    // 阿色出单3：R.F 非指定响应者 → 不询问
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    expect(r.ok).toBe(true);
    expect(askOf(r)).toBeNull();
    expect(engine.pass('p1').ok).toBe(true); // R.F 只能过
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true); // 指定者 p2 正常响应
  });

  it('阿色指定 R.F 本人时可吃饼（吃饼算响应）', () => {
    const hands = { p0: byRank(3, 5), p1: [pick(6, 0), pick(4, 0)], p2: [pick(4, 1), pick(10, 0)] };
    const engine = mkEngine(hands, { p0: captain, p1: rf });
    const startAsk = engine.snapshotFor('p0').pendingAsk;
    const yes = engine.resolveAsk('p0', { askId: startAsk!.askId, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' }).ok).toBe(true);
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 单3
    expect(askOf(r)?.kind).toBe('confirm'); // R.F 是指定响应者 → 可吃饼
  });

  it('吃饼算特殊响应不算出牌：不触发洄游切换/亢奋归属', () => {
    const hands = {
      p0: byRank(5, 5), // 海棠
      p1: [pick(4, 0), pick(9, 0), pick(10, 0), pick(11, 0), pick(12, 0)], // R.F：倒序恰好单4
      p2: byRank(6, 5), // 惰戈
    };
    const engine = mkEngine(hands, { p0: fishy, p1: rf, p2: duoGe });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    expect(engine.snapshotFor('p0').orderReversed).toBe(true); // 海棠自己打出切换一次
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm'); // 倒序单4 恰好接单5
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id] });
    const pick2 = askOf(a2);
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![0]!.id] });
    expect(a3.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.orderReversed).toBe(true); // 吃饼不切换牌序
    expect(eventsOf(a3)).not.toContain('table:attributed'); // 亢奋未触发
  });

  it('首席 Q 压一切类桌面无恰好（不询问）；Q 压 J 自然接牌则 K 可吃饼', () => {
    // 情况一：蛋神 Q 压单5（压一切）→ R.F 的 K 不算恰好
    const hands1 = {
      p0: [pick(12, 0), pick(4, 0)], // 首席：Q♠
      p1: byRank(5, 5), // 起单5
      p2: [pick(13, 0), pick(9, 0)], // R.F：K/9（都不恰好接单5）
    };
    const e1 = mkEngine(hands1, { p0: skywalker, p2: rf }, 'p1');
    expect(e1.playCards('p1', [hands1.p1[0]!.id]).ok).toBe(true); // 单5：R.F 无恰好 → 不询问
    expect(e1.pass('p2').ok).toBe(true);
    const rq = e1.playCards('p0', [hands1.p0[0]!.id]); // 蛋神：Q 压一切
    expect(rq.ok).toBe(true);
    expect((rq as { suspended?: boolean }).suspended).toBeFalsy(); // K 不算恰好 → 不询问
    // 情况二：Q 压 J（自然接牌）→ R.F 的 K 恰好 → 询问
    const hands2 = {
      p0: [pick(12, 0), pick(4, 0)], // 首席：Q♠
      p1: byRank(11, 5), // 起单J
      p2: [pick(13, 0), pick(9, 0)], // R.F：K/9
    };
    const e2 = mkEngine(hands2, { p0: skywalker, p2: rf }, 'p1');
    expect(e2.playCards('p1', [hands2.p1[0]!.id]).ok).toBe(true);
    expect(e2.pass('p2').ok).toBe(true);
    const rq2 = e2.playCards('p0', [hands2.p0[0]!.id]); // Q 压 J（自然）
    expect(askOf(rq2)?.kind).toBe('confirm'); // K 恰好 → 询问
  });

  it('倒序恰好吃饼：A 响应 2 算恰好', () => {
    const hands = {
      p0: [pick(15, 0), pick(4, 0)], // 海棠：单2
      p1: [pick(14, 0), pick(9, 0)], // R.F：单A
      p2: byRank(6, 5),
    };
    const engine = mkEngine(hands, { p0: fishy, p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 单2 → 倒序
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm'); // 倒序 A 响应 2 = 恰好
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id] });
    const pick2 = askOf(a2);
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![0]!.id] });
    expect(a3.ok).toBe(true);
    expect(pancakeOf(engine, 'p1')).toBe(1);
  });

  it('每手限问一次（弃权本手不再问）；下一手再问；先于狂吠询问', () => {
    const hands = {
      p0: [pick(5, 0), pick(6, 0)], // 修勾
      p1: [pick(6, 1), pick(7, 1)], // R.F：♥6/♥7
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: doggie, p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 单5
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm'); // R.F 先被问（先于狂吠）
    expect(ask?.prompt).toContain('吐饼');
    const d = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    const self = askOf(d);
    expect(self?.kind).toBe('selfFollow'); // 弃权后狂吠询问照常（本手不再问吃饼）
    decline(engine, 'p0', self); // 修勾放弃连压
    expect(engine.pass('p1').ok).toBe(true); // 弃权吃饼后正常可过
    expect(engine.pass('p2').ok).toBe(true);
    // 轮末修勾摸 1 张起牌 → 出单6 → 下一手再问
    const r2 = engine.playCards('p0', [hands.p0[1]!.id]);
    expect(askOf(r2)?.kind).toBe('confirm'); // ♥7 恰好接单6
  });

  it('修勾狂吠连压的每一手都最先问吃饼；打光手牌先胜（吃饼拦不住）', () => {
    const hands = {
      p0: [pick(5, 0), pick(6, 0), pick(7, 0)], // 修勾
      p1: [pick(7, 1), pick(8, 0)], // R.F：♥7（恰好接单6）、8（恰好接单7）
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p0: doggie, p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 单5：R.F 无恰好
    const self1 = askOf(r);
    expect(self1?.kind).toBe('selfFollow'); // 直接狂吠
    // 修勾连压单6 → 吃饼询问最先（先于下一次狂吠）
    const s2 = engine.resolveAsk('p0', { askId: self1!.askId!, choice: 'yes', cardIds: [hands.p0[1]!.id] });
    expect(s2.ok).toBe(true);
    const pancake = askOf(s2);
    expect(pancake?.kind).toBe('confirm'); // 连压的这一手先问吃饼
    expect(pancake?.prompt).toContain('吐饼');
    const d = engine.resolveAsk('p1', { askId: pancake!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    const self2 = askOf(d);
    expect(self2?.kind).toBe('selfFollow'); // 弃权后第二次狂吠照常
    // 修勾再连压单7 → 打光手牌 → 打出即胜（先于吃饼询问）
    const s3 = engine.resolveAsk('p0', { askId: self2!.askId!, choice: 'yes', cardIds: [hands.p0[2]!.id] });
    expect(s3.ok).toBe(true);
    expect(askOf(s3)).toBeNull(); // 获胜优先：不再问吃饼
    const ended = (s3 as { events?: GameEvent[] }).events?.find((e) => e.type === 'game:ended');
    expect(ended && (ended as { winnerId: string | null }).winnerId).toBe('p0');
  });

  it('吃过饼后轮到自己不能再过：有 2 必须打', () => {
    const hands = {
      p0: byRank(5, 5),
      p1: [pick(6, 0), pick(15, 0)], // R.F：单6 + 单2
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id] });
    const pick2 = askOf(a2);
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, cardIds: [pick2!.cards![0]!.id] });
    expect(a3.ok).toBe(true);
    // 轮转来到 R.F：不能过（手上有 2）
    const blocked = engine.pass('p1');
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toContain('吐饼');
    expect(engine.playCards('p1', [hands.p1[1]!.id]).ok).toBe(true); // 单2 压一切 ✓
  });

  it('2/炸弹响应不触发询问（压一切不算恰好），可直接打出', () => {
    const hands = {
      p0: byRank(4, 5),
      p1: [pick(15, 0), pick(15, 1), pick(9, 0)], // R.F：对2 + 单9
      p2: byRank(5, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 对4
    expect(r.ok).toBe(true);
    expect(askOf(r)).toBeNull(); // 对2 压一切不算恰好、单9 不合法 → 不询问
    expect(engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]).ok).toBe(true); // 对2 直接打 ✓
  });

  it('顺子桌面：起点恰好差一级的接牌可吃饼（N = 桌面张数 = 3）', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 0), pick(5, 0), pick(11, 1), pick(12, 1)], // 顺子345 + 留两张
      p1: [pick(4, 1), pick(5, 1), pick(6, 1), pick(9, 0)], // R.F：♥456 恰好
      p2: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    expect(pick1?.min).toBe(3);
    expect(pick1?.max).toBe(3);
    const a2 = engine.resolveAsk('p1', {
      askId: pick1!.askId!,
      cardIds: [hands.p1[0]!.id, hands.p1[1]!.id, hands.p1[2]!.id],
    });
    expect(a2.ok).toBe(true);
    const pick2 = askOf(a2);
    expect(pick2?.min).toBe(3); // 摸 3 倒 3
    const a3 = engine.resolveAsk('p1', {
      askId: pick2!.askId!,
      cardIds: pick2!.cards!.slice(0, 3).map((c) => c.id),
    });
    expect(a3.ok).toBe(true);
    expect(pancakeOf(engine, 'p1')).toBe(3);
    expect(handOf(engine, 'p1')).toBe(4); // 4 + 3 摸 − 3 倒
    expect(totalCards(engine)).toBe(162);
  });

  it('王当百搭：5+鬼 = 对5 接对4 算恰好可吃饼', () => {
    const hands = {
      p0: [pick(4, 0), pick(4, 1), pick(3, 0)], // 对4
      p1: [pick(5, 0), jokerSmall, pick(9, 0)], // R.F：5+鬼 = 对5
      p2: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    expect(pick1?.cards?.length).toBe(2); // 5 + 鬼
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id, hands.p1[1]!.id] });
    expect(a2.ok).toBe(true);
    const pick2 = askOf(a2);
    expect(pick2?.min).toBe(2); // N = 桌面对子张数
  });

  it('亮牌阶段超时：吃饼作废（无副作用），本手不再问', () => {
    const hands = {
      p0: byRank(5, 5),
      p1: [pick(6, 0), pick(9, 0)], // R.F
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, choice: 'decline' }); // 超时弃选
    expect(a2.ok).toBe(true);
    expect(askOf(a2)).toBeNull(); // 作废：不再问、无倒置阶段
    expect(handOf(engine, 'p1')).toBe(2); // 未摸牌
    expect(pancakeOf(engine, 'p1')).toBe(0);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1'); // 正常轮转
  });

  it('倒置阶段超时：自动倒置手牌前 N 张（确定化兜底）', () => {
    const hands = {
      p0: byRank(5, 5),
      p1: [pick(6, 0), pick(9, 0)], // R.F
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const a2 = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[0]!.id] });
    const pick2 = askOf(a2);
    const a3 = engine.resolveAsk('p1', { askId: pick2!.askId!, choice: 'decline' }); // 超时弃选
    expect(a3.ok).toBe(true);
    expect(pancakeOf(engine, 'p1')).toBe(1); // 自动倒置手牌前 1 张
    expect(handOf(engine, 'p1')).toBe(2); // 摸 1 后 3 张 − 倒 1
    expect(totalCards(engine)).toBe(162);
  });

  it('非法选牌重新询问、不消耗机会', () => {
    const hands = {
      p0: byRank(5, 5),
      p1: [pick(6, 0), pick(9, 0), pick(10, 0)], // R.F：恰好单6
      p2: byRank(4, 5),
    };
    const engine = mkEngine(hands, { p1: rf });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask = askOf(r);
    const a1 = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    const pick1 = askOf(a1);
    const bad = engine.resolveAsk('p1', { askId: pick1!.askId!, cardIds: [hands.p1[1]!.id] }); // 单9 不恰好
    expect(bad.ok).toBe(true);
    expect(eventsOf(bad)).toContain('game:error');
    const again = askOf(bad);
    expect(again?.kind).toBe('pickCards'); // 重新询问
    const ok2 = engine.resolveAsk('p1', { askId: again!.askId!, cardIds: [hands.p1[0]!.id] });
    expect(askOf(ok2)?.kind).toBe('pickCards'); // 进入倒置阶段
  });
});
