import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { parseCombo } from '../engine/combos';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import captain, { jokerSuits, matchesRankOrSuit } from './captain';
import patrick from './patrick';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const pick = (r: number, s: number) => deck.find((c) => c.rank === r && c.suit === s)!;
const joker = (big: boolean) => deck.find((c) => c.rank === (big ? 17 : 16))!;

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

/** 牌守恒：所有手牌 + 牌堆 + 弃牌 + 桌面 + 边牌 + 翻牌区 = 162 */
function total(engine: GameEngine): number {
  const snap = engine.snapshotFor('p0');
  let n = snap.deckCount + snap.discardCount + snap.revealed.length + snap.tableSide.length;
  for (const p of snap.players) n += p.handCount;
  if (snap.table) n += snap.table.cards.length;
  return n;
}

describe('第九席 阿色（抽你/再问）', () => {
  it('抽你：指定后只有指定者能响应（其他人出牌被拦、过牌后轮末阿色再问）', () => {
    const hands = { p0: byRank(3, 5), p1: byRank(10, 5), p2: byRank(5, 5), p3: byRank(6, 5) };
    const engine = mkEngine(hands, { p0: captain });
    // 第一轮：阿色出单3，其余全过 → 轮末整备询问
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    const r = engine.pass('p3');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('6');
    // 确认 → 选目标：候选不含自己
    const a1 = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk = a1.ok ? (a1.pendingAsk as SkillAsk) : null;
    expect(pickAsk?.kind).toBe('pickTarget');
    expect(pickAsk?.targetCandidates).toEqual(['p1', 'p2', 'p3']);
    // 指定 p1 → 正常摸牌、阿色起新轮
    const a2 = engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' });
    expect(a2.ok).toBe(true);
    expect(a2.ok && a2.events.some((e) => e.type === 'skill:triggered' && /指定/.test(e.text))).toBe(true);
    expect(a2.ok && a2.events.some((e) => e.type === 'round:ended' && e.drew === 1)).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
    // 新轮：阿色出单3 → 只有 p1 能响应
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const block2 = engine.playCards('p2', [hands.p2[0]!.id]);
    expect(block2.ok).toBe(false);
    expect((block2 as { reason: string }).reason).toContain('抽你');
    expect(engine.pass('p2').ok).toBe(true);
    const block3 = engine.playCards('p3', [hands.p3[0]!.id]);
    expect(block3.ok).toBe(false);
    expect((block3 as { reason: string }).reason).toContain('抽你');
    // p3 过 → 全过轮末，阿色仍有牌权，再次询问（已用 1 次）
    const r2 = engine.pass('p3');
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('confirm');
    expect(ask2?.prompt).toContain('5');
    expect(engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'decline' }).ok).toBe(true);
  });

  it('抽你：指定者压过后限制解除，其他人可正常接牌', () => {
    const hands = { p0: byRank(3, 5), p1: byRank(4, 5), p2: byRank(5, 5) };
    const engine = mkEngine(hands, { p0: captain });
    // 第一轮拿牌权并指定 p1
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pick = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(pick?.kind).toBe('pickTarget');
    const done = engine.resolveAsk('p0', { askId: pick!.askId!, targetPlayerId: 'p1' });
    expect(done.ok).toBe(true);
    // 新轮：阿色出单3 → p1（被指定者）压4 合法 → 触发再问（阿色弃权）→ 限制解除
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    const beat = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(beat.ok).toBe(true);
    const zw = beat.ok ? (beat.pendingAsk as SkillAsk) : null;
    expect(zw?.kind).toBe('confirm');
    expect(engine.resolveAsk('p0', { askId: zw!.askId!, choice: 'decline' }).ok).toBe(true);
    // p2 压5 不再被拦
    expect(engine.playCards('p2', [hands.p2[0]!.id]).ok).toBe(true);
  });

  it('抽你：弃权不消耗次数、指定自己不消耗，次数用尽不再询问', () => {
    // p0 8 张三：8 轮每轮出一张（补摸的是牌堆顶的王，留在手牌尾部不参与）
    const hands = { p0: byRank(3, 8), p1: byRank(10, 5), p2: byRank(11, 5) };
    const engine = mkEngine(hands, { p0: captain });
    // 每轮：阿色出当前手牌第一张（轮末补摸 1 张，手牌在轮换），其余过
    const roundEnd = () => {
      const card = engine.snapshotFor('p0').players[0]!.hand![0]!;
      expect(engine.playCards('p0', [card.id]).ok).toBe(true);
      expect(engine.pass('p1').ok).toBe(true);
      return engine.pass('p2');
    };
    const askOf = (r: ReturnType<typeof roundEnd>) => (r.ok ? (r.pendingAsk as SkillAsk) : null);
    // R1：弃权 → 不消耗
    let r = roundEnd();
    let ask = askOf(r);
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('5');
    expect(engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
    // R2：次数仍是 5；指定自己（恶意答案）→ 不消耗
    r = roundEnd();
    ask = askOf(r);
    expect(ask?.prompt).toContain('5');
    const yes2 = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk2 = yes2.ok ? (yes2.pendingAsk as SkillAsk) : null;
    expect(pickAsk2?.targetCandidates).toEqual(['p1', 'p2']);
    expect(engine.resolveAsk('p0', { askId: pickAsk2!.askId!, targetPlayerId: 'p0' }).ok).toBe(true);
    // R3：仍未消耗
    r = roundEnd();
    ask = askOf(r);
    expect(ask?.prompt).toContain('5');
    // 依次消耗 5 次（R3~R7）
    for (let i = 5; i >= 1; i--) {
      const y = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
      const pask = y.ok ? (y.pendingAsk as SkillAsk) : null;
      expect(pask?.kind).toBe('pickTarget');
      expect(engine.resolveAsk('p0', { askId: pask!.askId!, targetPlayerId: 'p1' }).ok).toBe(true);
      if (i > 1) {
        r = roundEnd();
        ask = askOf(r);
        expect(ask?.prompt).toContain(String(i - 1));
      }
    }
    // R8：次数用尽 → 不再询问，直接摸牌
    r = roundEnd();
    expect(r.ok).toBe(true);
    expect(r.ok && !r.pendingAsk).toBe(true);
    expect(r.ok && r.events.some((e) => e.type === 'round:ended' && e.drew === 1)).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
  });

  it('再问：弃权即消耗，同一轮第二次被压不再询问', () => {
    const hands = {
      p0: [byRank(3, 1)[0]!, byRank(5, 1)[0]!, byRank(7, 1)[0]!, byRank(9, 1)[0]!, byRank(11, 1)[0]!],
      p1: [byRank(4, 1)[0]!, byRank(12, 1)[0]!],
      p2: [byRank(6, 1)[0]!, byRank(13, 1)[0]!],
      p3: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p0: captain });
    // 阿色出3 → p1 压4 → 再问询问
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]);
    const ask = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    expect(ask?.prompt).toContain('再问');
    // 弃权 → 消耗
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p2');
    // 阿色再压5 → p2 压6（第二次压阿色）→ 不再询问
    expect(engine.pass('p2').ok).toBe(true);
    expect(engine.pass('p3').ok).toBe(true);
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r2 = engine.playCards('p2', [hands.p2[0]!.id]);
    expect(r2.ok).toBe(true);
    expect(r2.ok && !r2.pendingAsk).toBe(true);
  });

  it('再问：压牌者补打同点/同花的牌明置桌旁，候选只含合规牌，弃置守恒', () => {
    const hands = {
      p0: byRank(3, 5),
      p1: [pick(4, 0), pick(4, 1), pick(13, 0), pick(7, 1), pick(9, 3)],
      p2: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p0: captain });
    // 阿色出3 → p1 压4♠ → 再问 → 是
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]);
    const ask = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(pickAsk?.kind).toBe('pickCards');
    expect(pickAsk?.askPlayerId).toBe('p1');
    expect(engine.pendingAskPlayerId).toBe('p1');
    // 候选 = 与单4♠ 同点（4♥）或同花（K♠）；7♥、9♦ 不可选
    const cardIds = pickAsk!.cards!.map((c) => c.id);
    expect(cardIds).toEqual([hands.p1[1]!.id, hands.p1[2]!.id]);
    expect(cardIds).not.toContain(hands.p1[3]!.id);
    expect(cardIds).not.toContain(hands.p1[4]!.id);
    // 补打 K♠ → 明置桌旁
    const done = engine.resolveAsk('p1', { askId: pickAsk!.askId!, cardIds: [hands.p1[2]!.id] });
    expect(done.ok).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'skill:triggered' && /补打/.test(e.text))).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.tableSide.map((c) => c.id)).toEqual([hands.p1[2]!.id]);
    expect(snap.players[1]!.handCount).toBe(3); // 5 - 压牌 - 补打
    // 轮结束：边牌随桌面一起弃置，p1 补摸 1 张
    expect(engine.pass('p2').ok).toBe(true);
    const r2 = engine.pass('p0');
    expect(r2.ok && r2.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p1' && e.drew === 1)).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.table).toBeNull();
    expect(snap.tableSide).toHaveLength(0);
    expect(snap.players[1]!.handCount).toBe(4);
    expect(total(engine)).toBe(162);
  });

  it('再问：打不出（候选为空/弃权）→ 压牌归属改写为阿色，牌权归阿色', () => {
    const hands = {
      p0: byRank(3, 5),
      p1: [pick(4, 1), pick(13, 0), pick(12, 2), pick(11, 3), pick(9, 2)],
      p2: byRank(10, 5),
    };
    const engine = mkEngine(hands, { p0: captain });
    // 阿色出3 → p1 压4♥（余牌无 4 也无 ♥）→ 再问 → 是 → 候选为空
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r1 = engine.playCards('p1', [hands.p1[0]!.id]);
    const ask = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(pickAsk?.cards).toHaveLength(0);
    // p1 弃权 → 归属改写
    const d = engine.resolveAsk('p1', { askId: pickAsk!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'table:attributed' && e.playerId === 'p0' && e.fromPlayerId === 'p1')).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'skill:triggered' && /归阿色/.test(e.text))).toBe(true);
    // 轮转从阿色下家（p1）继续；全过 → 牌权归阿色、整备再问（次数仍是 5）
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1');
    expect(engine.pass('p1').ok).toBe(true);
    const r2 = engine.pass('p2');
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('confirm');
    expect(ask2?.prompt).toContain('5');
    // 弃权后正常补摸
    const d2 = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'decline' });
    expect(d2.ok && d2.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p0' && e.drew === 1)).toBe(true);
    expect(total(engine)).toBe(162);
  });

  it('抽你+再问联动：归属改写后的手牌仍受限制，实际压牌者可接着打（视作阿色打出）', () => {
    const fiveS = pick(5, 0);
    const hands = {
      p0: byRank(3, 5),
      p1: [pick(4, 1), fiveS, pick(12, 2), pick(11, 3), pick(9, 2)],
      p2: byRank(5, 6).filter((c) => c.id !== fiveS.id).slice(0, 5),
    };
    const engine = mkEngine(hands, { p0: captain });
    // 第一轮拿牌权并指定 p1
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r1 = engine.pass('p2');
    const ask = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' }).ok).toBe(true);
    // 新轮：阿色出3 → p1（被指定者）压4♥ → 再问 → p1 打不出 → 归属阿色
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    const r2 = engine.playCards('p1', [hands.p1[0]!.id]);
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const yes2 = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' });
    const pickAsk2 = yes2.ok ? (yes2.pendingAsk as SkillAsk) : null;
    expect(pickAsk2?.cards).toHaveLength(0);
    const d = engine.resolveAsk('p1', { askId: pickAsk2!.askId!, choice: 'decline' });
    expect(d.ok && d.events.some((e) => e.type === 'table:attributed' && e.playerId === 'p0')).toBe(true);
    // 轮转从阿色下家（p1）继续：实际压牌者可以接这张牌（现在视作阿色打出）
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1');
    expect(engine.playCards('p1', [hands.p1[1]!.id]).ok).toBe(true); // 5♠ 压 4♥
    // 限制解除：p2 自由行动（5 压不了 5，过牌即可）
    expect(engine.pass('p2').ok).toBe(true);
    const r3 = engine.pass('p0');
    expect(r3.ok && r3.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p1')).toBe(true);
  });

  it('抽你+再问联动：归属改写后其他人仍被拦，全过后牌权归阿色', () => {
    const fiveS = pick(5, 0);
    const hands = {
      p0: byRank(3, 5),
      p1: [pick(4, 1), fiveS, pick(12, 2), pick(11, 3), pick(9, 2)],
      p2: byRank(5, 6).filter((c) => c.id !== fiveS.id).slice(0, 5),
    };
    const engine = mkEngine(hands, { p0: captain });
    // 第一轮指定 p1
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r1 = engine.pass('p2');
    const ask = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' }).ok).toBe(true);
    // 新轮：阿色出3 → p1 压4♥ → 再问打不出 → 归属阿色（限制照旧：只能 p1 响应）
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true);
    const r2 = engine.playCards('p1', [hands.p1[0]!.id]);
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const yes2 = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' });
    const pickAsk2 = yes2.ok ? (yes2.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p1', { askId: pickAsk2!.askId!, choice: 'decline' }).ok).toBe(true);
    // p1 不接（过）→ p2 想压5 被拦
    expect(engine.pass('p1').ok).toBe(true);
    const block = engine.playCards('p2', [hands.p2[0]!.id]);
    expect(block.ok).toBe(false);
    expect((block as { reason: string }).reason).toContain('抽你');
    // p2 过 → 全过 → 牌权归阿色（整备再问挂起，回答后补摸）
    const r3 = engine.pass('p2');
    const ask3 = r3.ok ? (r3.pendingAsk as SkillAsk) : null;
    expect(ask3?.kind).toBe('confirm');
    const d3 = engine.resolveAsk('p0', { askId: ask3!.askId!, choice: 'decline' });
    expect(d3.ok && d3.events.some((e) => e.type === 'round:ended' && e.lastPlayerId === 'p0')).toBe(true);
  });

  it('抽你限制下插队不触发（无名也不被询问）', () => {
    const hands = {
      p0: byRank(3, 5),
      p1: byRank(10, 5),
      p2: [byRank(4, 1)[0]!, ...byRank(9, 4)],
    };
    const engine = mkEngine(hands, { p0: captain, p2: patrick });
    // 第一轮：无限制时无名（p2）会被问插队 → 弃权；随后全过拿牌权，指定 p1
    const lead = engine.playCards('p0', [hands.p0[0]!.id]);
    expect(lead.ok).toBe(true);
    const cutAsk = lead.ok ? (lead.pendingAsk as SkillAsk) : null;
    expect(cutAsk?.kind).toBe('cutIn');
    expect(engine.resolveAsk('p2', { askId: cutAsk!.askId!, choice: 'decline' }).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r1 = engine.pass('p2');
    const ask = r1.ok ? (r1.pendingAsk as SkillAsk) : null;
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    const pickAsk = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(engine.resolveAsk('p0', { askId: pickAsk!.askId!, targetPlayerId: 'p1' }).ok).toBe(true);
    // 新轮：阿色出3 → 插队被限制跳过，直接轮到 p1
    const r2 = engine.playCards('p0', [hands.p0[1]!.id]);
    expect(r2.ok).toBe(true);
    expect(r2.ok && !r2.pendingAsk).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1');
  });

  it('matchesRankOrSuit：王按实际代表点数与包含花色（小王双黑、大王双红）', () => {
    // 对K（K♠ + 小王）：小王代表 K
    const pairK = parseCombo([pick(13, 0), joker(false)], defaultRules)!;
    expect(pairK.type).toBe('pair');
    expect(matchesRankOrSuit(pick(13, 1), pairK)).toBe(true); // K♥ 同点
    expect(matchesRankOrSuit(pick(3, 2), pairK)).toBe(true); // ♣3 同小王的花色（♣）
    expect(matchesRankOrSuit(pick(3, 1), pairK)).toBe(false); // ♥3 不同点不同花
    // 对7（7♥ + 大王）：大王代表 7
    const pair7 = parseCombo([pick(7, 1), joker(true)], defaultRules)!;
    expect(matchesRankOrSuit(pick(7, 2), pair7)).toBe(true); // 7♣ 同点
    expect(matchesRankOrSuit(pick(14, 3), pair7)).toBe(true); // ♦A 同大王的花色（♦）
    expect(matchesRankOrSuit(pick(14, 2), pair7)).toBe(false); // ♣A 不同
    // 真对Q：小王按花色可配 ♣/♠
    const pairQ = parseCombo([pick(12, 2), pick(12, 3)], defaultRules)!;
    expect(matchesRankOrSuit(pick(12, 0), pairQ)).toBe(true); // Q♠ 同点
    expect(matchesRankOrSuit(joker(false), pairQ)).toBe(true); // 小王含 ♣
    expect(jokerSuits(joker(false))).toEqual([0, 2]);
    expect(jokerSuits(joker(true))).toEqual([1, 3]);
  });
});
