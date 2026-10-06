import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import zuZhang from './zu-zhang';

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

/** 用 range 内未被使用的牌把各手牌补到 targets 张（已满的手跳过） */
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

/** 牌守恒：手牌（含扣置）+ 桌面 + 展示区 + 边牌 + 牌堆 + 弃牌堆 = 162 */
function assertConserved(engine: GameEngine): void {
  const snap = engine.snapshotFor('p0');
  const handCards = snap.players.reduce((x, p) => x + p.handCount + p.heldCount, 0);
  expect(handCards + (snap.table?.cards.length ?? 0) + snap.revealed.length + snap.tableSide.length + snap.deckCount + snap.discardCount + snap.stagedDiscards.reduce((x, e) => x + e.cards.length, 0)).toBe(162);
}

/** 开局询问（组长温柔 / 硝烟讲题 / 苗条尖叫都在起牌者回合开始问） */
function ask(engine: GameEngine): SkillAsk {
  const a = engine.snapshotFor('p0').pendingAsk;
  expect(a).not.toBeNull();
  return a as unknown as SkillAsk;
}

describe('组长：处分 + 温柔', () => {
  it('温柔全流程：自选 Y=2 → 多摸 2 张 + 标 1 名宝贝（可提前停）→ 宝贝被拒响应组长的牌，非宝贝照常压并触发处分', () => {
    const hands = {
      p0: [deck[2]!, deck[4]!, deck[6]!], // 组长：♠5 ♠7 ♠9
      p1: [deck[3]!, deck[5]!], // ♠6 ♠8
      p2: [deck[57]!, deck[0]!, deck[13]!, deck[27]!, deck[41]!], // ♠6(压牌用) + 低牌
    };
    pad(hands, { p0: 8, p1: 8, p2: 5 }, [109, 159]);
    const engine = mkEngine(hands, { p0: zuZhang });

    // 温柔：确认 → 选 Y → 标宝贝
    const c = ask(engine);
    expect(c.kind).toBe('confirm');
    expect(c.prompt).toContain('温柔');
    const yes = engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' });
    const yAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(yAsk?.kind).toBe('choice');
    expect(yAsk?.options).toEqual(['1', '2']); // Y 上限 = min(20−8, 其他成员 2) = 2
    const y = engine.resolveAsk('p0', { askId: yAsk!.askId!, choice: '2' });
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(10); // 8 + 2
    const t1 = y.ok ? (y.pendingAsk as SkillAsk) : null;
    expect(t1?.kind).toBe('pickTarget');
    const m1 = engine.resolveAsk('p0', { askId: t1!.askId!, targetPlayerId: 'p1' });
    expect(m1.ok && m1.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wen-rou')).toBe(true);
    const t2 = m1.ok ? (m1.pendingAsk as SkillAsk) : null;
    expect(t2?.kind).toBe('pickTarget');
    expect(engine.resolveAsk('p0', { askId: t2!.askId! }).ok).toBe(true); // 提前停：只标了 p1
    expect(engine.snapshotFor('p0').babyIds).toEqual(['p1']);

    engine.playCards('p0', [hands.p0[0]!.id]); // ♠5
    const blocked = engine.playCards('p1', [hands.p1[0]!.id]); // 宝贝压牌被拒
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toContain('宝贝');
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.playCards('p2', [hands.p2[0]!.id]); // 非宝贝照常压 → 处分询问
    expect(r.ok && r.suspended).toBe(true);
    const cf = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(cf?.kind).toBe('choice');
    expect(cf?.prompt).toContain('处分');
    expect(cf?.options).toHaveLength(3); // 检讨/休学/放弃
    expect(cf?.declineAllowed).toBe(false); // 放弃已是显式选项，不可额外弃权（2026-10-06 用户确认）
    expect(engine.resolveAsk('p0', { askId: cf!.askId!, choice: '放弃' }).ok).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p2')!.handCount).toBe(4); // 5 − 1
    assertConserved(engine);
  });

  it('处分检讨：压牌者立即摸 2 张、不限次；放弃不消耗休学次数', () => {
    const hands = {
      p0: [deck[2]!, deck[4]!], // 组长：♠5 ♠7
      p1: [deck[3]!, deck[5]!], // ♠6 ♠8
      p2: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 全程过牌
    };
    pad(hands, { p0: 8, p1: 8, p2: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: zuZhang });
    const c = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c.askId!, choice: 'decline' }).ok).toBe(true); // 温柔弃权不消耗

    engine.playCards('p0', [hands.p0[0]!.id]); // ♠5
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]); // ♠6 压
    const cf1 = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    expect(cf1?.options?.[0]).toBe('检讨：压牌者摸 2 张手牌');
    const a1 = engine.resolveAsk('p0', { askId: cf1!.askId!, choice: '检讨：压牌者摸 2 张手牌' });
    expect(a1.ok && a1.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'chu-fen')).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(9); // 8 − 1 + 2

    engine.pass('p2');
    engine.playCards('p0', [hands.p0[1]!.id]); // ♠7
    const r2 = engine.playCards('p1', [hands.p1[1]!.id]); // ♠8 再压 → 检讨不限次、再次询问
    expect(r2.ok && r2.suspended).toBe(true);
    const cf2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const a2 = engine.resolveAsk('p0', { askId: cf2!.askId!, choice: '放弃' });
    expect(a2.ok).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(8); // 9 − 1，放弃不加
    assertConserved(engine);
  });

  it('处分休学：整轮不得出牌 + 轮末夺权（复用地坛诅咒）；每局 X=人数 次，用尽后选项消失', () => {
    const hands = {
      p0: [deck[2]!, deck[4]!, deck[6]!, deck[8]!, deck[13]!], // 组长：♠5 ♠7 ♠9 ♠J ♥3（轮 2 起 ♥3）
      p1: [deck[3]!, deck[5]!, deck[7]!, deck[9]!], // ♠6 ♠8 ♠10 ♠Q（连续压 + 收尾压）
      p2: [deck[0]!, deck[26]!, deck[27]!, deck[41]!], // 全程过牌（♠3 ♣3 ♣4 ♦5，轮 2 压 ♥3）
    };
    pad(hands, { p0: 8, p1: 8, p2: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: zuZhang });
    expect(engine.resolveAsk('p0', { askId: ask(engine).askId!, choice: 'decline' }).ok).toBe(true);

    // 轮 1：三次休学（X = 3 用尽）→ 第四次只有检讨/放弃
    engine.playCards('p0', [hands.p0[0]!.id]); // ♠5
    for (const [press, opt] of [
      [hands.p1[0]!, '休学：压牌者下回合整轮不得出牌'],
      [hands.p1[1]!, '休学：压牌者下回合整轮不得出牌'],
      [hands.p1[2]!, '休学：压牌者下回合整轮不得出牌'],
    ] as const) {
      const r = engine.playCards('p1', [press.id]);
      const cf = r.ok ? (r.pendingAsk as SkillAsk) : null;
      expect(cf?.kind).toBe('choice');
      expect(engine.resolveAsk('p0', { askId: cf!.askId!, choice: opt }).ok).toBe(true);
      expect(engine.pass('p2').ok).toBe(true);
      engine.playCards('p0', [deck[press.id === 3 ? 4 : press.id === 5 ? 6 : 8]!.id]); // ♠7/♠9/♠J 压回去
    }
    const r4 = engine.playCards('p1', [hands.p1[3]!.id]); // ♠Q 收尾压
    const cf4 = r4.ok ? (r4.pendingAsk as SkillAsk) : null;
    expect(cf4?.options).toEqual(['检讨：压牌者摸 2 张手牌', '放弃']); // 休学次数用尽（X = 人数 3）
    expect(engine.resolveAsk('p0', { askId: cf4!.askId!, choice: '放弃' }).ok).toBe(true);
    engine.pass('p2');
    expect(engine.pass('p0').ok).toBe(true); // 压不了 ♠Q → 轮末 last = p1

    // 轮 2：p1 被休学（诅咒生效）→ 组长夺权起牌、p1 自动过
    const snap = engine.snapshotFor('p0');
    expect(snap.roundLeaderId).toBe('p0'); // 取而代之
    expect(snap.cursedPlayerIds).toContain('p1');
    expect(engine.resolveAsk('p0', { askId: ask(engine).askId!, choice: 'decline' }).ok).toBe(true); // 温柔：每轮都能发动
    const banned = engine.playCards('p1', [hands.p1[0]!.id]); // 休学者整轮不得出牌
    expect(banned.ok).toBe(false);
    engine.playCards('p0', [hands.p0[4]!.id]); // ♥3
    // p1 轮到自动过 → p2 压 ♣4 → 处分再询问（本局第 5 次：休学仍不出现）
    const r5 = engine.playCards('p2', [hands.p2[2]!.id]);
    const cf5 = r5.ok ? (r5.pendingAsk as SkillAsk) : null;
    expect(cf5?.kind).toBe('choice');
    expect(cf5?.options).toEqual(['检讨：压牌者摸 2 张手牌', '放弃']);
    expect(engine.resolveAsk('p0', { askId: cf5!.askId!, choice: '放弃' }).ok).toBe(true);
    assertConserved(engine);
  });

  it('处分非亡语：压牌者打光手牌即获胜，不触发处分（2026-10-06 用户确认）', () => {
    const hands = {
      p0: [deck[2]!], // 组长：♠5
      p1: [deck[3]!], // ♠6（最后一张）
    };
    pad(hands, { p0: 8, p1: 1 }, [109, 159]);
    const engine = mkEngine(hands, { p0: zuZhang });
    expect(engine.resolveAsk('p0', { askId: ask(engine).askId!, choice: 'decline' }).ok).toBe(true);

    engine.playCards('p0', [hands.p0[0]!.id]);
    const r = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(r.ok && !r.suspended).toBe(true); // 非亡语：打光即胜，不询问
    expect(r.ok && r.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'chu-fen')).toBe(false);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1');
  });
});
