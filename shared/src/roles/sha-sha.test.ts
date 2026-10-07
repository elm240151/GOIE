// 角色测试：煞蔱 Sharry —— 技能【约等】+【直播】（均非亡语，2026-10-06 用户裁定）。
// 【约等】每回合一次：压别人的手牌时（触发 A），或拥有牌权时（触发 B，本回合相当于出了 0 张牌、
//   不用摸牌），可收回刚打的那一手牌（桌面退回被压的一手），与一名随机角色均分手牌
//   （她拿 ⌊X/2⌋、对方拿其余），从她下家继续接牌（桌面空则她重新起牌）。弃权不消耗。
// 【直播】每当她打出大于一张的牌后有人压她的牌：交给对方一张牌（不能给出最后一张），或令对方摸两张牌。
//   障目（辛歼）：指向性技能以辛歼为目标先猜手牌数——猜中照常 + 摸 1-3；猜错直播失效。
import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import shaSha from './sha-sha';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import xinJian from './xin-jian';

const deck = buildDeck(3);

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

/** 取当前挂起的完整询问（快照里的 pendingAsk 是精简版，完整 SkillAsk 用 currentAsk） */
function ask(engine: GameEngine): SkillAsk {
  const a = engine.snapshotFor('p0').pendingAsk;
  expect(a).not.toBeNull();
  const full = engine.currentAsk(a!.playerId);
  expect(full).not.toBeNull();
  return full!;
}

/** 守恒 162（公共三副；辛歼在场时改用 216 口径的用例自行跳过） */
function assertConserved(engine: GameEngine): void {
  const snap = engine.snapshotFor('p0');
  const handCards = snap.players.reduce((x, p) => x + p.handCount + p.heldCount, 0);
  expect(
    handCards +
      (snap.table?.cards.length ?? 0) +
      snap.revealed.length +
      snap.tableSide.length +
      snap.deckCount +
      snap.discardCount +
      snap.stagedDiscards.reduce((x, e) => x + e.cards.length, 0)
  ).toBe(162);
}

describe('煞蔱：约等 + 直播', () => {
  it('约等触发 A：弃权不消耗，可再次触发；收回刚压的一手并均分，桌面回退、从下家继续接牌', () => {
    const hands = {
      p0: [deck[1]!, deck[3]!, deck[4]!], // 煞蔱：♠4 压、♠6 压（收回）、♠7 陪洗
      p1: [deck[0]!, deck[2]!, deck[28]!], // ♠3 起牌、♠5 压、♣5 陪洗
    };
    const engine = mkEngine(hands, { p0: shaSha }, 'p1');
    expect(engine.playCards('p1', [deck[0]!.id]).ok).toBe(true); // p1 起牌 ♠3
    expect(engine.playCards('p0', [deck[1]!.id]).ok).toBe(true); // 煞蔱压 ♠4 → 约等询问
    const c1 = ask(engine);
    expect(c1.prompt).toContain('约等');
    expect(engine.resolveAsk('p0', { askId: c1.askId!, choice: 'decline' }).ok).toBe(true);
    // 弃权不消耗：约等仍可再次触发
    expect((engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.roleState as { yueDengUsed: boolean }).yueDengUsed).toBe(false);
    expect(engine.playCards('p1', [deck[2]!.id]).ok).toBe(true); // p1 压 ♠5
    expect(engine.playCards('p0', [deck[3]!.id]).ok).toBe(true); // 煞蔱压 ♠6 → 约等再次询问
    const c2 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c2.askId!, choice: 'yes' }).ok).toBe(true);
    // 收回 ♠6（手牌 ♠7♠6 共 2 张）与 p1（♣5 共 1 张）均分：X = 3 → 煞蔱 1、p1 2
    const snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(1);
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(2);
    expect(snap.tableOwnerId).toBe('p1'); // 桌面回退到被压的一手 ♠5
    expect(snap.table?.rank).toBe(5);
    expect(snap.turnPlayerId).toBe('p1'); // 从她下家继续接牌（2 人局下家 = p1）
    expect((snap.players.find((p) => p.id === 'p0')!.roleState as { yueDengUsed: boolean }).yueDengUsed).toBe(true); // 生效才消耗
    assertConserved(engine);
  });

  it('约等回退后牌权归煞蔱（2026-10-07 用户反馈）：对面接不上 → 煞蔱起牌', () => {
    const hands = {
      p0: [deck[4]!, deck[17]!, deck[30]!, deck[43]!, deck[1]!], // 煞蔱：4×7 炸弹压对2、♠4 留手（留手才会问约等）
      p1: [deck[12]!, deck[25]!, deck[0]!], // 对面：对 2 领出、♠3 留手（均分后拿 3 张也组不出对2/炸弹）
    };
    const engine = mkEngine(hands, { p0: shaSha }, 'p1');
    expect(engine.playCards('p1', [deck[12]!.id, deck[25]!.id]).ok).toBe(true); // 对面领出对 2
    const r = engine.playCards('p0', [deck[4]!.id, deck[17]!.id, deck[30]!.id, deck[43]!.id]); // 煞蔱炸弹压
    expect(r.ok).toBe(true);
    const a = ask(engine);
    expect(a.prompt).toContain('约等');
    expect(engine.resolveAsk('p0', { askId: a.askId!, choice: 'yes' }).ok).toBe(true);
    // 回退后：桌面 = 对 2、轮到对面接牌
    let s = engine.snapshotFor('p0');
    expect(s.turnPlayerId).toBe('p1');
    expect(s.table?.cards.length).toBe(2);
    // 对面接不上（3 张无对 2/炸弹）→ 过 → 牌权回煞蔱：她重新起牌
    expect(engine.pass('p1').ok).toBe(true);
    s = engine.snapshotFor('p0');
    expect(s.table).toBeNull();
    expect(s.turnPlayerId).toBe('p0');
    assertConserved(engine);
  });

  it('约等触发 B：拥有牌权时收回起牌手、不用摸牌，桌面空则重新起牌', () => {
    const hands = {
      p0: [deck[2]!, deck[11]!], // 煞蔱：♠5 领出（收回）、♠A 陪洗
      p1: [deck[0]!, deck[1]!], // ♠3♠4 陪洗
    };
    const engine = mkEngine(hands, { p0: shaSha });
    expect(engine.playCards('p0', [deck[2]!.id]).ok).toBe(true); // 领出 ♠5
    expect(engine.pass('p1').ok).toBe(true);
    // 轮末：煞蔱拥有牌权 → 约等询问（触发 B）
    const c = ask(engine);
    expect(c.prompt).toContain('牌权');
    expect(engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' }).ok).toBe(true);
    // 收回 ♠5（2 张：♠A♠5）与 p1（2 张）均分：X = 4 → 煞蔱 2、p1 2；不用摸牌
    const snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(2);
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(2);
    expect(snap.table).toBeNull(); // 收回的是起牌手：桌面空
    expect(snap.turnPlayerId).toBe('p0'); // 桌面空 → 她重新起牌
    expect(snap.pendingAsk).toBeNull();
    assertConserved(engine);
  });

  it('直播：交给对方一张牌（不能给出最后一张）', () => {
    const hands = {
      p0: [deck[1]!, deck[27]!, deck[3]!, deck[29]!], // 煞蔱：对 4 领出、♠6♣6 待选
      p1: [deck[2]!, deck[28]!, deck[4]!], // 对 5 压（♠7 留下，压完不打光 → 直播可触发）
    };
    const engine = mkEngine(hands, { p0: shaSha });
    expect(engine.playCards('p0', [deck[1]!.id, deck[27]!.id]).ok).toBe(true); // 领出对 4
    expect(engine.playCards('p1', [deck[2]!.id, deck[28]!.id]).ok).toBe(true); // 压对 5 → 直播询问
    const c = ask(engine);
    expect(c.prompt).toContain('直播');
    expect(engine.resolveAsk('p0', { askId: c.askId!, choice: '交给对方一张牌' }).ok).toBe(true);
    const g = ask(engine);
    expect(g.kind).toBe('pickCards');
    expect(engine.snapshotFor('p0').pendingAsk!.playerId).toBe('p0'); // 选牌询问问的是煞蔱自己
    expect(engine.resolveAsk('p0', { askId: g.askId!, cardIds: [deck[3]!.id] }).ok).toBe(true); // 给 ♠6
    const snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(1); // 剩 ♣6
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(2); // ♠7 + 收了 ♠6
    assertConserved(engine);
  });

  it('直播：令对方摸两张牌', () => {
    const hands = {
      p0: [deck[1]!, deck[27]!, deck[3]!, deck[29]!], // 煞蔱：对 4 领出
      p1: [deck[2]!, deck[28]!, deck[4]!], // 对 5 压（压后剩 ♠7）
    };
    const engine = mkEngine(hands, { p0: shaSha });
    expect(engine.playCards('p0', [deck[1]!.id, deck[27]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [deck[2]!.id, deck[28]!.id]).ok).toBe(true);
    const c = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c.askId!, choice: '令对方摸两张牌' }).ok).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(3); // 1 + 2
    assertConserved(engine);
  });

  it('直播 + 障目猜中：辛歼摸 1-3 后直播照常（令对方摸两张）', () => {
    const hands = {
      p0: [deck[1]!, deck[27]!, deck[3]!, deck[29]!], // 煞蔱：对 4 领出
      p1: [deck[2]!, deck[28]!, deck[4]!], // 辛歼：对 5 压（压后剩 ♠7）
    };
    const engine = mkEngine(hands, { p0: shaSha, p1: xinJian });
    expect(engine.playCards('p0', [deck[1]!.id, deck[27]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [deck[2]!.id, deck[28]!.id]).ok).toBe(true);
    // 障目：猜辛歼手牌数（压对 5 后 1 张）
    const g = ask(engine);
    expect(g.kind).toBe('guess');
    expect(engine.resolveAsk('p0', { askId: g.askId!, guess: 1 }).ok).toBe(true);
    // 猜中 → 辛歼自选摸 1-3
    const d = ask(engine);
    expect(d.askPlayerId).toBe('p1');
    expect(engine.resolveAsk('p1', { askId: d.askId!, choice: '摸 2 张' }).ok).toBe(true);
    // 摸牌延后（2026-10-07 用户反馈）：直播选择询问挂起时辛歼尚未摸——技能先生效再摸
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(1);
    // 直播选择照常弹出
    const c = ask(engine);
    expect(c.prompt).toContain('直播');
    expect(engine.resolveAsk('p0', { askId: c.askId!, choice: '令对方摸两张牌' }).ok).toBe(true);
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(5); // 1 + 2 + 2
  });

  it('直播 + 障目猜错：直播失效；辛歼随后打光手牌照常获胜', () => {
    const hands = {
      p0: [deck[1]!, deck[27]!, deck[4]!, deck[17]!, deck[23]!], // 煞蔱：对 4 领出、对 7 压、♥K 留手
      p1: [deck[2]!, deck[28]!, deck[5]!, deck[18]!], // 辛歼：对 5 压（压后剩对 8）
      p2: [deck[3]!, deck[16]!, deck[7]!], // 对 6 压、♠10 留手
    };
    const engine = mkEngine(hands, { p0: shaSha, p1: xinJian });
    expect(engine.playCards('p0', [deck[1]!.id, deck[27]!.id]).ok).toBe(true);
    expect(engine.playCards('p1', [deck[2]!.id, deck[28]!.id]).ok).toBe(true);
    const g = ask(engine);
    expect(engine.resolveAsk('p0', { askId: g.askId!, guess: 3 }).ok).toBe(true); // 猜 3（错，实际 2）
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull(); // 直播失效：无选择询问
    // 牌局照常继续：p2 压对 6 → 煞蔱压对 7（约等触发 A 询问，弃权）→ 辛歼压对 8 打光手牌
    expect(engine.playCards('p2', [deck[3]!.id, deck[16]!.id]).ok).toBe(true);
    expect(engine.playCards('p0', [deck[4]!.id, deck[17]!.id]).ok).toBe(true);
    const y = ask(engine);
    expect(y.prompt).toContain('约等');
    expect(engine.resolveAsk('p0', { askId: y.askId!, choice: 'decline' }).ok).toBe(true);
    const r = engine.playCards('p1', [deck[5]!.id, deck[18]!.id]);
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').phase).toBe('finished');
    // 障目只拦技能、不拦获胜判定：辛歼照常获胜（打光即胜时非亡语打断不再询问）
    expect(r.ok && r.events.some((e) => e.type === 'game:ended' && (e as { winnerId?: string }).winnerId === 'p1')).toBe(true);
  });

  it('约等 + 障目猜中：均分先结算、辛歼摸 1-3 延后到技能完成（2026-10-07 用户反馈：技能先生效再摸）', () => {
    const hands = {
      p0: [deck[1]!, deck[3]!, deck[4]!], // 煞蔱：♠4 压（收回）、♠6♠7 陪洗
      p1: [deck[0]!, deck[2]!, deck[28]!], // 辛歼：♠3 起牌、♠5♣5 陪洗
    };
    const engine = mkEngine(hands, { p0: shaSha, p1: xinJian }, 'p1');
    expect(engine.playCards('p1', [deck[0]!.id]).ok).toBe(true); // 辛歼起牌 ♠3
    expect(engine.playCards('p0', [deck[1]!.id]).ok).toBe(true); // 煞蔱压 ♠4 → 约等询问
    const c1 = ask(engine);
    expect(c1.prompt).toContain('约等');
    expect(engine.resolveAsk('p0', { askId: c1.askId!, choice: 'yes' }).ok).toBe(true);
    // 障目：猜辛歼手牌数（♠5♣5 共 2 张）
    const g = ask(engine);
    expect(g.kind).toBe('guess');
    expect(engine.resolveAsk('p0', { askId: g.askId!, guess: 2 }).ok).toBe(true);
    // 猜中 → 辛歼自选摸 3 张 → 均分完成（X = 3 + 2 = 5 → 煞蔱 ⌊5/2⌋ = 2、辛歼 3）后才摸 3 → 辛歼 6
    const d = ask(engine);
    expect(d.askPlayerId).toBe('p1');
    expect(engine.resolveAsk('p1', { askId: d.askId!, choice: '摸 3 张' }).ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(2); // 均分没把新摸的牌算进去
    expect(snap.table?.rank).toBe(3); // 桌面回退到 ♠3
    expect(snap.turnPlayerId).toBe('p1'); // 从煞蔱下家继续接牌
    // 神秘对别人隐藏手牌数：用辛歼自己的视角看
    expect(engine.snapshotFor('p1').players.find((p) => p.id === 'p1')!.handCount).toBe(6); // 均分 3 + 障目摸 3
  });

  it('约等非亡语（2026-10-06 用户裁定）：打光压出最后一手直接获胜、不再询问', () => {
    const hands = {
      p0: [deck[3]!], // 煞蔱：♠6 最后一手压牌
      p1: [deck[2]!, deck[6]!], // ♠5 领出、♠9 留手（单张领出即打光会直接获胜）
    };
    const engine = mkEngine(hands, { p0: shaSha }, 'p1');
    expect(engine.playCards('p1', [deck[2]!.id]).ok).toBe(true);
    const r = engine.playCards('p0', [deck[3]!.id]);
    expect(r.ok).toBe(true);
    const s = engine.snapshotFor('p0');
    expect(s.phase).toBe('finished');
    expect(s.pendingAsk).toBeNull(); // 约等不再询问
    expect(r.ok && r.events.some((e) => e.type === 'game:ended' && (e as { winnerId?: string }).winnerId === 'p0')).toBe(true);
  });
});
