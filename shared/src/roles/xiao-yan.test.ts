import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import guoTT from './guo-tt';
import kingNan from './king-nan';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';
import xiaoYan from './xiao-yan';
import yyXue from './yy-xue';
import zecheng from './zecheng';
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

function ask(engine: GameEngine): SkillAsk {
  const a = engine.snapshotFor('p0').pendingAsk;
  expect(a).not.toBeNull();
  return a as unknown as SkillAsk;
}

describe('硝烟：讲题 + 血压', () => {
  it('讲题只在接牌时发动（2026-10-06 用户确认）：起牌（领出）不询问；接牌发动成功——摸 1 张、指定代打者压牌 → 视作硝烟打出（归属改写、轮转从硝烟下家）', () => {
    const hands = {
      p0: [], // 硝烟：填充 8 张（轮 1 领出 ♠4、过后牌）
      p1: [deck[2]!, deck[40]!], // 代打者：♠5、♦4（轮 2 压 ♠3）+ 填充
      p2: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // ♠3♥3♣3 + ♦5（轮 1 压 ♠4 收尾、轮 2 领出 ♠3）
    };
    pad(hands, { p0: 8, p1: 8, p2: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: xiaoYan });

    // 轮 1：硝烟起牌——讲题不触发（只在接牌时发动）
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    expect(engine.playCards('p0', [deck[109]!.id]).ok).toBe(true); // 领出 ♠4
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.playCards('p2', [deck[41]!.id]).ok).toBe(true); // ♦5 压 ♠4
    // 轮到硝烟接牌：讲题询问（弃权不消耗）
    const c1 = ask(engine);
    expect(c1.kind).toBe('confirm');
    expect(c1.prompt).toContain('讲题');
    expect(engine.resolveAsk('p0', { askId: c1.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p0').ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true); // 轮末 last = p2

    // 轮 2：p2 领出 ♠3 → 轮到硝烟接牌：讲题发动
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true);
    const c = ask(engine);
    expect(c.kind).toBe('confirm');
    expect(c.prompt).toContain('讲题');
    const yes = engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' });
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(8); // 7 + 1
    const t = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(t?.kind).toBe('pickTarget');
    const r1 = engine.resolveAsk('p0', { askId: t!.askId!, targetPlayerId: 'p1' });
    const proxy = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    expect(proxy?.kind).toBe('proxyPlay');
    expect(proxy?.askPlayerId).toBe('p1'); // 代打请求发给代打者

    const r2 = engine.resolveAsk('p1', { askId: proxy!.askId!, choice: 'yes', cardIds: [hands.p1[1]!.id] }); // ♦4 压 ♠3
    expect(r2.ok).toBe(true);
    expect(r2.ok && r2.events.some((e) => e.type === 'table:attributed' && e.playerId === 'p0' && e.fromPlayerId === 'p1')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.turnPlayerId).toBe('p1'); // 轮转从硝烟下家继续
    expect(snap.tableOwnerId).toBe('p0'); // 桌面归属改写为硝烟（快照公开归属者，客户端宝贝预览门控用）
    expect(snap.players.find((p) => p.id === 'p1')!.handCount).toBe(7); // 8 − 1（代打者出的牌）
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(8); // 硝烟一张未出
    assertConserved(engine);
  });

  it('讲题失败 → 代打者令硝烟弃置一张（硝烟自选）→ 硝烟仍可继续出牌', () => {
    const hands = {
      p0: [deck[2]!], // 硝烟：♠5（之后自选弃掉）+ 填充
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 代打者：低牌（轮 2 无牌可压弃权）
      p2: [deck[1]!, deck[14]!, deck[28]!, deck[42]!], // ♠4♥4♣5 + ♦6（轮 1 压 ♠4 收尾、轮 2 领出 ♠4）
    };
    pad(hands, { p0: 8, p1: 4, p2: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: xiaoYan });

    // 轮 1：硝烟起牌（无讲题询问）→ 领出 ♠4；p1 过；p2 出 ♣5 压；硝烟弃权讲题后过牌
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    expect(engine.playCards('p0', [deck[109]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.playCards('p2', [deck[28]!.id]).ok).toBe(true); // ♣5 压 ♠4
    const c1 = ask(engine); // 硝烟接牌回合：讲题询问 → 弃权
    expect(engine.resolveAsk('p0', { askId: c1.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p0').ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true); // 轮末 last = p2

    // 轮 2：p2 领出 ♠4 → 硝烟讲题发动
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true);
    const c = ask(engine);
    const yes = engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' });
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(8); // 7 + 1
    const t = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    const r1 = engine.resolveAsk('p0', { askId: t!.askId!, targetPlayerId: 'p1' });
    const proxy = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    // 代打者弃权（未能打出）
    const r2 = engine.resolveAsk('p1', { askId: proxy!.askId!, choice: 'decline' });
    const punish = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(punish?.kind).toBe('choice');
    expect(punish?.askPlayerId).toBe('p1');
    expect(punish?.options).toEqual(['令玩家0弃置一张牌（由其自选）', '你从牌堆摸一张牌']);
    // 代打者选「令硝烟弃一张」→ 问硝烟自选
    const r3 = engine.resolveAsk('p1', { askId: punish!.askId!, choice: '令玩家0弃置一张牌（由其自选）' });
    const pick = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(pick?.kind).toBe('pickCards');
    expect(pick?.askPlayerId).toBeUndefined(); // 未指定 → 默认问技能所有者（硝烟）
    expect(pick?.min).toBe(1);
    expect(pick?.max).toBe(1);
    const r4 = engine.resolveAsk('p0', { askId: pick!.askId!, cardIds: [hands.p0[0]!.id] });
    expect(r4.ok && r4.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'jiang-ti')).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(7); // 8 − 1
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0'); // 结算后硝烟仍可出牌
    expect(engine.playCards('p0', [deck[110]!.id]).ok).toBe(true); // 失败后仍可出牌（♠5 压 ♠4）
    assertConserved(engine);
  });

  it('讲题失败 → 代打者从牌堆摸一张；结算后硝烟仍可继续出牌', () => {
    const hands = {
      p0: [deck[2]!], // 硝烟：♠5 + 填充
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 代打者：无牌可打，弃权
      p2: [deck[1]!, deck[14]!, deck[28]!, deck[42]!], // ♠4♥4♣5 + ♦6（轮 1 压、轮 2 领出 ♠4）
    };
    pad(hands, { p0: 8, p1: 4, p2: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: xiaoYan });

    // 轮 1：硝烟起牌（无讲题询问）→ 领出 ♠4；p1 过；p2 出 ♣5 压；硝烟弃权讲题后过牌
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    expect(engine.playCards('p0', [deck[109]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.playCards('p2', [deck[28]!.id]).ok).toBe(true); // ♣5 压 ♠4
    const c1 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c1.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p0').ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);

    // 轮 2：p2 领出 ♠4 → 硝烟讲题发动 → 代打者弃权 → 选从牌堆摸一张
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true);
    const c = ask(engine);
    const yes = engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' });
    const t = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    const r1 = engine.resolveAsk('p0', { askId: t!.askId!, targetPlayerId: 'p1' });
    const proxy = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const r2 = engine.resolveAsk('p1', { askId: proxy!.askId!, choice: 'decline' });
    const punish = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const r3 = engine.resolveAsk('p1', { askId: punish!.askId!, choice: '你从牌堆摸一张牌' });
    expect(r3.ok).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(5); // 4 + 1
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
    expect(engine.playCards('p0', [deck[110]!.id]).ok).toBe(true); // 失败后仍可出牌（♠5 压 ♠4）
    assertConserved(engine);
  });

  it('宝贝硝烟不能讲题（2026-10-06 用户确认：讲题本质是硝烟出牌）：被组长标为宝贝后无讲题询问、出牌被拒、可过牌', () => {
    const hands = {
      p0: [deck[2]!], // 组长：♠5 领出
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 硝烟（宝贝）：低牌
      p2: [deck[1]!, deck[14]!, deck[28]!, deck[42]!], // 过牌
    };
    pad(hands, { p0: 4, p1: 4, p2: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: zuZhang, p1: xiaoYan });
    // 温柔：确认 → Y=1 → 标 p1（硝烟）
    const c = ask(engine);
    engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' });
    const y = ask(engine);
    engine.resolveAsk('p0', { askId: y.askId!, choice: '1' });
    const t = ask(engine);
    engine.resolveAsk('p0', { askId: t.askId!, targetPlayerId: 'p1' });
    expect(engine.snapshotFor('p0').babyIds).toEqual(['p1']);
    expect(engine.snapshotFor('p0').babyOwnerId).toBe('p0');
    // 组长出 ♠5
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.snapshotFor('p0').tableOwnerId).toBe('p0');
    // 轮到硝烟：出牌门控生效——讲题不询问（宝贝不得响应组长的牌）
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    // 硝烟出牌被拒、可过牌 → 轮到 p2
    const blocked = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toContain('宝贝');
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p2');
    assertConserved(engine);
  });

  it('讲题惩罚不可弃权（2026-10-06 用户确认）：declineAllowed=false，弃权/超时按默认作答（惩罚第一项、弃牌第一张）', () => {
    const hands = {
      p0: [deck[2]!], // 硝烟：♠5（之后被自动弃）
      p1: [deck[0]!, deck[13]!, deck[27]!, deck[41]!], // 代打者：无牌可打，弃权
      p2: [deck[1]!, deck[14]!, deck[28]!, deck[42]!], // ♠4♥4♣5 + ♦6（轮 1 压、轮 2 领出 ♠4）
    };
    pad(hands, { p0: 8, p1: 4, p2: 4 }, [109, 159]);
    const engine = mkEngine(hands, { p0: xiaoYan });

    // 轮 1：硝烟起牌（无讲题询问）→ 领出 ♠4；p1 过；p2 出 ♣5 压；硝烟弃权讲题后过牌
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    expect(engine.playCards('p0', [deck[109]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.playCards('p2', [deck[28]!.id]).ok).toBe(true); // ♣5 压 ♠4
    const c1 = ask(engine);
    expect(engine.resolveAsk('p0', { askId: c1.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p0').ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);

    // 轮 2：p2 领出 ♠4 → 硝烟讲题发动
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true);
    const c = ask(engine);
    engine.resolveAsk('p0', { askId: c.askId!, choice: 'yes' });
    const t = ask(engine);
    engine.resolveAsk('p0', { askId: t.askId!, targetPlayerId: 'p1' });
    const proxy = ask(engine);
    expect(proxy?.kind).toBe('proxyPlay');
    // 代打者弃权（未能打出）→ 惩罚二选一
    const r2 = engine.resolveAsk('p1', { askId: proxy!.askId!, choice: 'decline' });
    const punish = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(punish?.kind).toBe('choice');
    expect(punish?.askPlayerId).toBe('p1');
    expect(punish?.declineAllowed).toBe(false);
    // 代打者弃权（模拟超时自动弃权）→ 引擎按第一项作答：令硝烟弃置一张 → 问硝烟自选
    const r3 = engine.resolveAsk('p1', { askId: punish!.askId!, choice: 'decline' });
    const pick = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(pick?.kind).toBe('pickCards');
    expect(pick?.declineAllowed).toBe(false);
    // 硝烟弃权（模拟超时）→ 引擎自动弃第一张
    const before = engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount;
    const r4 = engine.resolveAsk('p0', { askId: pick!.askId!, choice: 'decline' });
    expect(r4.ok).toBe(true);
    expect(
      (r4 as { events: { type: string; text: string }[] }).events.some(
        (e) => e.type === 'skill:triggered' && /硝烟弃置了一张牌/.test(e.text)
      )
    ).toBe(true);
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(before - 1);
    // 弃牌暂存区（2026-10-06 用户规则）：弃的 ♠5 本回合公开展示（谁弃的、弃了什么全场可见）
    expect(engine.snapshotFor('p0').stagedDiscards).toEqual([{ playerId: 'p0', cards: [deck[2]!] }]);
    // 轮末（p0、p1 相继过牌，轮末最后出牌者 = p2）：暂存区与桌面牌一起进弃牌堆
    expect(engine.pass('p0').ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const snapEnd = engine.snapshotFor('p0');
    expect(snapEnd.stagedDiscards).toEqual([]);
    expect(snapEnd.discardCount).toBe(4); // 轮 1 被压的 ♠4 + 轮 1 轮末桌面 ♣5 + 轮 2 桌面 ♠4 + 弃置的 ♠5
    assertConserved(engine);
  });

  it('血压全挡：处分/旺旺/回味/地坛/巨石对 ≥8 手牌的硝烟一律不生效', () => {
    // ① 处分不触发（硝烟压牌后 9−1=8 ≥8 血压生效；讲题是她自己的技能，先弃权）
    const h1 = { p0: [deck[2]!], p1: [deck[3]!] };
    pad(h1, { p0: 8, p1: 9 }, [109, 159]);
    const e1 = mkEngine(h1, { p0: zuZhang, p1: xiaoYan });
    expect(e1.resolveAsk('p0', { askId: ask(e1).askId!, choice: 'decline' }).ok).toBe(true); // 温柔弃权
    e1.playCards('p0', [h1.p0[0]!.id]);
    expect(e1.resolveAsk('p1', { askId: ask(e1).askId!, choice: 'decline' }).ok).toBe(true); // 讲题弃权
    const r1 = e1.playCards('p1', [h1.p1[0]!.id]); // ♠6 压组长的牌 → 处分应被血压挡下
    expect(r1.ok && !r1.suspended).toBe(true);
    expect(r1.ok && r1.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'chu-fen')).toBe(false);

    // ② 旺旺不触发（硝烟压楠王的牌）
    const h2 = { p0: [deck[2]!], p1: [deck[3]!] };
    pad(h2, { p0: 8, p1: 9 }, [109, 159]);
    const e2 = mkEngine(h2, { p0: kingNan, p1: xiaoYan });
    e2.playCards('p0', [h2.p0[0]!.id]);
    expect(e2.resolveAsk('p1', { askId: ask(e2).askId!, choice: 'decline' }).ok).toBe(true); // 讲题弃权
    const r2 = e2.playCards('p1', [h2.p1[0]!.id]);
    expect(r2.ok && !r2.suspended).toBe(true);
    expect(r2.ok && r2.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'wang-wang')).toBe(false);

    // ③ 回味不触发（楠王压硝烟的牌：被压者 ≥8 → 不摸牌，含增益也挡）
    const h3 = { p0: [deck[3]!], p1: [deck[2]!] };
    pad(h3, { p0: 8, p1: 9 }, [109, 159]);
    const e3 = mkEngine(h3, { p0: kingNan, p1: xiaoYan }, 'p1');
    expect(e3.snapshotFor('p0').pendingAsk).toBeNull(); // 硝烟起牌：讲题不发动（2026-10-06）
    e3.playCards('p1', [h3.p1[0]!.id]); // 硝烟领出 ♠5 → 手牌 8，血压生效
    const r3 = e3.playCards('p0', [h3.p0[0]!.id]); // 楠王压 ♠6
    expect(r3.ok).toBe(true);
    expect(r3.ok && r3.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei')).toBe(false);
    expect(e3.snapshotFor('p0').players.find((p) => p.id === 'p1')!.handCount).toBe(8); // 未被回味加牌
    const jt3 = r3.ok ? (r3.pendingAsk as SkillAsk) : null; // 轮回到硝烟：讲题再问（弃权不消耗）
    expect(jt3?.prompt).toContain('讲题');
    expect(e3.resolveAsk('p1', { askId: jt3!.askId!, choice: 'decline' }).ok).toBe(true);

    // ④ 地坛不触发（硝烟炸弹压橐驼的牌：11−3=8 血压生效）
    const h4 = { p0: [deck[2]!], p1: [deck[3]!, deck[16]!, deck[29]!] };
    pad(h4, { p0: 8, p1: 11 }, [109, 159]);
    const e4 = mkEngine(h4, { p0: guoTT, p1: xiaoYan });
    e4.playCards('p0', [h4.p0[0]!.id]);
    expect(e4.resolveAsk('p1', { askId: ask(e4).askId!, choice: 'decline' }).ok).toBe(true); // 讲题弃权
    const r4 = e4.playCards('p1', [h4.p1[0]!.id, h4.p1[1]!.id, h4.p1[2]!.id]); // 3×6 炸弹
    expect(r4.ok && !r4.suspended).toBe(true);
    expect(r4.ok && r4.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan')).toBe(false);

    // ⑤ 巨石不触发（硝烟炸弹压雪灾的牌）
    const h5 = { p0: [deck[2]!], p1: [deck[3]!, deck[16]!, deck[29]!] };
    pad(h5, { p0: 8, p1: 11 }, [109, 159]);
    const e5 = mkEngine(h5, { p0: yyXue, p1: xiaoYan });
    e5.playCards('p0', [h5.p0[0]!.id]);
    expect(e5.resolveAsk('p1', { askId: ask(e5).askId!, choice: 'decline' }).ok).toBe(true); // 讲题弃权
    const r5 = e5.playCards('p1', [h5.p1[0]!.id, h5.p1[1]!.id, h5.p1[2]!.id]);
    expect(r5.ok && !r5.suspended).toBe(true);
    expect(r5.ok && r5.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'ju-shi')).toBe(false);
  });

  it('血压 + 禁打豁免：被诅咒时若手牌 ≥8 仍能起牌、讲题照常询问', () => {
    // 轮 1：硝烟（7 张）领出 ♠3♠4♦5 → 地坛诅咒生效；楠王压 456 → 回味 +3；肖亡压 567 收尾
    // 轮末肖亡观股大涨 → 硝烟摸 1 张到 8 张（血压生效）
    // 轮 2：硝烟虽被诅咒但手牌 ≥8 → 血压豁免禁打 → 轮到她时讲题照常询问
    const hands = {
      p0: [deck[0]!, deck[1]!, deck[41]!, deck[5]!, deck[7]!, deck[39]!, deck[40]!], // 硝烟：♠3♠4♦5（领出）+ 无后续压牌
      p1: [deck[17]!, deck[19]!, deck[20]!, deck[22]!, deck[161]!, deck[160]!, deck[159]!, deck[158]!, deck[157]!], // 橐驼：全程过牌（含王与高点，压低牌堆顶）
      p2: [deck[14]!, deck[15]!, deck[16]!], // 楠王：♥456 压
      p3: [deck[28]!, deck[29]!, deck[30]!], // 肖亡：♣567 收尾
    };
    pad(hands, { p0: 7, p1: 9, p2: 8, p3: 8 }, [109, 159]);
    const engine = mkEngine(hands, { p0: xiaoYan, p1: guoTT, p2: kingNan, p3: zecheng });

    // 轮 1：硝烟起牌（讲题不发动，2026-10-06）→ 领出 345 → 地坛判定命中（牌堆顶 ♦Q ∈ {♠,♦}）→ 诅咒硝烟
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    const r0 = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id, hands.p0[2]!.id]);
    expect(r0.ok && r0.suspended).toBe(true);
    const dt = r0.ok ? (r0.pendingAsk as SkillAsk) : null;
    expect(dt?.prompt).toContain('地坛');
    const rDt = engine.resolveAsk('p1', { askId: dt!.askId!, choice: 'yes' });
    expect(rDt.ok && rDt.events.some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan')).toBe(true);
    expect(engine.snapshotFor('p0').cursedPlayerIds).toContain('p0');

    expect(engine.pass('p1').ok).toBe(true);
    const r1 = engine.playCards('p2', [hands.p2[0]!.id, hands.p2[1]!.id, hands.p2[2]!.id]); // ♥456
    expect(r1.ok && !r1.suspended).toBe(true); // 地坛每回合一次、旺旺未压楠王的牌
    expect(engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount).toBe(7); // 4 + 回味 3
    const r2 = engine.playCards('p3', [hands.p3[0]!.id, hands.p3[1]!.id, hands.p3[2]!.id]); // ♣567 压楠王的 456
    expect(r2.ok && r2.suspended).toBe(true); // 旺旺询问（肖亡压了楠王的牌）
    const ww = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p2', { askId: ww!.askId!, choice: 'decline' }).ok).toBe(true);
    const jtAgain = ask(engine); // 轮回到硝烟：讲题再问（弃权不消耗）→ 弃权
    expect(jtAgain.prompt).toContain('讲题');
    expect(engine.resolveAsk('p0', { askId: jtAgain.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p0').ok).toBe(true); // 无 678，过牌
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);

    // 轮末：肖亡观股大涨（牌堆顶 5 张全是 ♦ 红牌）→ 每人 1 张，硝烟摸到 8 张
    // （观股询问挂起期间 finishRoundEnd 尚未执行，新起牌者在结算完成后才确定）
    const gg = ask(engine);
    expect(gg.prompt).toContain('观股');
    const rGg = engine.resolveAsk('p3', { askId: gg.askId!, choice: 'yes' });
    let boomAsk = rGg.ok ? (rGg.pendingAsk as SkillAsk) : null;
    expect(boomAsk?.kind).toBe('pickCards');
    const picks: Record<string, number> = {};
    while (boomAsk) {
      const pid = boomAsk.askPlayerId!;
      const pool = boomAsk.cards ?? [];
      expect(pool.length).toBeGreaterThan(0);
      picks[pid] = pool[0]!.id;
      const rr = engine.resolveAsk(pid, { askId: boomAsk.askId!, cardIds: [pool[0]!.id] });
      boomAsk = rr.ok ? (rr.pendingAsk as SkillAsk) : null;
    }
    expect(picks.p3).toBeDefined();
    expect(picks.p0).toBeDefined(); // 摸牌前 7 张不血压，参与大涨
    const snap = engine.snapshotFor('p0');
    expect(snap.roundLeaderId).toBe('p3'); // 观股结算完 → finishRoundEnd → 肖亡起新回合
    expect(snap.players.find((p) => p.id === 'p0')!.handCount).toBe(8); // 7 + 1
    expect(snap.bpProtectedIds).toContain('p0');

    // 轮 2：硝烟被诅咒但血压 ≥8 → 豁免禁打；肖亡领出后轮到硝烟 → 讲题照常询问
    const snap2 = engine.snapshotFor('p0');
    expect(snap2.cursedPlayerIds).toContain('p0');
    expect(snap2.roundLeaderId).toBe('p3');
    const lead3 = engine.playCards('p3', [deck[110]!.id]); // 肖亡领出填充牌 ♠5
    expect(lead3.ok).toBe(true);
    const jt = ask(engine);
    expect(jt.kind).toBe('confirm');
    expect(jt.prompt).toContain('讲题'); // 被诅咒仍能发动讲题（血压豁免禁打）
    expect(engine.resolveAsk('p0', { askId: jt.askId!, choice: 'decline' }).ok).toBe(true);
    assertConserved(engine);
  });
});
