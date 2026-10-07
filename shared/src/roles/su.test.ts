import { describe, expect, it } from 'vitest';
import type { Card } from '../cards';
import { defaultRules } from '../config';
import { buildDeck } from '../engine/deck';
import { GameEngine, type EnginePlayer } from '../engine/engine';
import { mulberry32 } from '../engine/rng';
import button from './button';
import duoGe from './duo-ge';
import fishy from './fishy';
import guoTT from './guo-tt';
import kingNan from './king-nan';
import patrick from './patrick';
import su from './su';
import yyXue from './yy-xue';
import type { RoleDef, RoleRegistry, SkillAsk } from './types';

const deck = buildDeck(3);
const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
const pick = (r: number, s: number) => deck.find((c) => c.rank === r && c.suit === s)!;
const jokerSmall = deck.find((c) => c.rank === 16)!;

/** 同花色对子（副牌花色块状排列：byRank 第 0 与第 4 张同点数同花色、不同实体牌） */
const pairSameSuit = (r: number): [Card, Card] => {
  const c = byRank(r, 5);
  return [c[0]!, c[4]!];
};

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

/** 无 handsOverride（真实发牌）：两倍初始手牌测试用 */
function mkDealt(roles: Record<string, RoleDef>, startPlayerId = 'p0') {
  const players: EnginePlayer[] = Object.keys(roles).map((id, i) => ({
    id,
    name: `玩家${i}`,
    roleId: roles[id]!.id,
  }));
  const registry: RoleRegistry = new Map(Object.values(roles).map((r) => [r.id, r]));
  const engine = new GameEngine(defaultRules, players, { rng: mulberry32(1), startPlayerId, roles: registry });
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
const attributed = (r: { ok: boolean; events?: { type: string }[] }) =>
  r.ok && (r.events ?? []).some((e) => e.type === 'table:attributed');
const decline = (engine: GameEngine, by: string, ask: SkillAsk | null) => {
  expect(engine.resolveAsk(by, { askId: ask!.askId!, choice: 'decline' }).ok).toBe(true);
};
const handOf = (engine: GameEngine, pid: string): number =>
  engine.snapshotFor('p0').players.find((p) => p.id === pid)!.handCount;

describe('玊：两倍（锁定技）+ 呕哑', () => {
  it('两倍：初始手牌翻倍（先手 12、其余 10），别人不受影响', () => {
    const e = mkDealt({ p0: su, p1: plain(), p2: plain() }, 'p1');
    expect(handOf(e, 'p0')).toBe(10); // 玊非先手：5×2
    expect(handOf(e, 'p1')).toBe(6); // 先手照常 6
    expect(handOf(e, 'p2')).toBe(5);
    const e2 = mkDealt({ p0: su, p1: plain(), p2: plain() }, 'p0');
    expect(handOf(e2, 'p0')).toBe(12); // 玊先手：6×2（2026-10-04 用户确认）
  });

  it('两倍：轮末补摸翻倍（1→2），别人摸牌不翻倍', () => {
    const hands = {
      p0: byRank(9, 5), // 玊
      p1: byRank(4, 5),
      p2: byRank(5, 5),
    };
    const engine = mkEngine(hands, { p0: su });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 起单9
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pass('p2').ok).toBe(true);
    // 轮末：玊（最后出牌者）摸 1×2=2 张，并继续起牌
    expect(handOf(engine, 'p0')).toBe(6); // 4 + 2
    expect(engine.snapshotFor('p0').roundLeaderId).toBe('p0');
  });

  it('两倍：手牌上限 40，超出照常淘汰', () => {
    const hands = {
      p0: [pick(9, 0)], // 玊：打出这张后剩 39 张
      p1: byRank(4, 5),
      p2: byRank(5, 5),
    };
    pad(hands, { p0: 40, p1: 5, p2: 5 }, [3, 120]);
    const engine = mkEngine(hands, { p0: su });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2');
    expect(r.ok).toBe(true);
    // 39 + 轮末摸 2 = 41 > 40 → 淘汰（手牌进弃牌堆）
    const p0 = engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!;
    expect(p0.eliminated).toBe(true);
    expect(p0.handCount).toBe(0);
  });

  it('两倍：插队（无名）受害者摸 X×2', () => {
    const hands = {
      p0: [pick(9, 0), pick(9, 1), pick(5, 0), pick(6, 0)], // 玊：起对9♠♥
      p1: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)], // 路人（挨着玊：插队仍会询问）
      p2: [pick(10, 0), pick(10, 2), pick(8, 0)], // 无名：对10♠♣ 插队（10♠ 同花色 X=10）
    };
    const engine = mkEngine(hands, { p0: su, p2: patrick });
    const r1 = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    expect(r1.ok).toBe(true);
    const cut = askOf(r1);
    expect(cut?.kind).toBe('cutIn');
    const before = handOf(engine, 'p0'); // 2
    const r2 = engine.resolveAsk('p2', { askId: cut!.askId!, choice: 'yes', cardIds: hands.p2.slice(0, 2).map((c) => c.id) });
    expect(r2.ok).toBe(true);
    expect(handOf(engine, 'p0')).toBe(before + 20); // X=10 → 玊翻倍摸 20
  });

  it('两倍：回味（楠王）给被压者（玊）的摸牌翻倍', () => {
    // 玊起单7 → 楠王 单8 压 → 回味：被压者加 |8−7|=1 张 → 翻倍摸 2
    const hands = {
      p0: [pick(7, 0), pick(5, 1), pick(6, 1)], // 玊：起单7
      p1: [pick(8, 0), pick(4, 0), pick(5, 0), pick(6, 0)], // 楠王：单8 压 + 杂牌
      p2: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)],
    };
    const engine = mkEngine(hands, { p0: su, p1: kingNan });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 单7
    expect(handOf(engine, 'p0')).toBe(2);
    expect(engine.playCards('p1', [hands.p1[0]!.id]).ok).toBe(true); // 单8 压
    expect(handOf(engine, 'p0')).toBe(2 + 2); // |8−7|=1 → 翻倍摸 2
  });

  it('呕哑：对5 桌面——任意含5的合法牌型都能接（无视牌型），不含5被拒', () => {
    const hands = {
      p0: [pick(5, 0), pick(5, 1), pick(4, 0), pick(6, 0)], // 路人：起对5♠♥
      p1: [pick(5, 2), pick(5, 3), pick(9, 0), pick(3, 0), pick(7, 0)], // 玊：单5♣ / 单9♠…
      p2: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)],
    };
    const engine = mkEngine(hands, { p1: su }, 'p0');
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]).ok).toBe(true); // 对5
    const bad = engine.playCards('p1', [hands.p1[2]!.id]); // 单9：不含5、牌型不同也压不过
    expect(bad.ok).toBe(false);
    const ok1 = engine.playCards('p1', [hands.p1[0]!.id]); // 单5：含5 → 呕哑放行
    expect(ok1.ok).toBe(true);
    expect(engine.snapshotFor('p0').table?.label).toBe('5'); // 桌面换成玊的牌
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p2'); // 从玊下家继续
  });

  it('呕哑：顺子桌面须包含每个点数（缺一不可），王可补缺', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 0), pick(5, 0), pick(6, 0), pick(7, 0), pick(9, 1)], // 路人：起 34567
      p1: [pick(3, 1), pick(4, 1), pick(5, 1), pick(6, 1), jokerSmall, pick(9, 0), pick(10, 0), pick(11, 0), pick(12, 0), pick(13, 0)], // 玊
      p2: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)],
    };
    const engine = mkEngine(hands, { p1: su }, 'p0');
    expect(engine.playCards('p0', hands.p0.slice(0, 5).map((c) => c.id)).ok).toBe(true); // 34567
    const bad = engine.playCards('p1', hands.p1.slice(5, 10).map((c) => c.id)); // 9~K：不含 3~7 也压不过
    expect(bad.ok).toBe(false);
    const ok1 = engine.playCards('p1', hands.p1.slice(0, 5).map((c) => c.id)); // 王+3456（王当7）
    expect(ok1.ok).toBe(true);
    expect(engine.snapshotFor('p0').table?.label).toBe('顺子 3-4-5-6-7');
  });

  it('呕哑：单王桌面（王是无穷）不可发动——只有炸弹能压（按正常管牌规则）', () => {
    const hands = {
      p0: [jokerSmall, pick(5, 0), pick(6, 0)], // 橐驼：起单王
      p1: [pick(9, 0), pick(9, 1), pick(9, 2), pick(9, 3), pick(4, 0)], // 玊
      p2: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)],
    };
    const engine = mkEngine(hands, { p0: guoTT, p1: su }, 'p0');
    expect(engine.playCards('p0', [jokerSmall.id]).ok).toBe(true); // 单王（无穷）
    const bad = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 对9：没有无穷这个点数，呕哑不可发动
    expect(bad.ok).toBe(false);
    const bomb = engine.playCards('p1', hands.p1.slice(0, 4).map((c) => c.id)); // 炸弹 4×9：正常管牌规则仍可用
    expect(bomb.ok).toBe(true);
    expect(askOf(bomb)?.prompt).toContain('地坛'); // 炸弹 ≥3 张照常触发地坛
  });

  it('呕哑：接出最后一手牌照常获胜', () => {
    const hands = {
      p0: [pick(5, 0), pick(5, 1), pick(9, 0)], // 路人：起对5
      p1: [pick(5, 2)], // 玊：整手单5
      p2: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)],
    };
    const engine = mkEngine(hands, { p1: su }, 'p0');
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // 单5（呕哑）→ 打光
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').winnerId).toBe('p1');
  });

  it('呕哑：留2禁收尾同样适用（对2 呕哑打完手牌被拒）', () => {
    const hands = {
      p0: [pick(15, 0), pick(15, 1), pick(9, 0)], // 路人：起对2♠♥
      p1: [pick(15, 2), pick(15, 3)], // 玊：整手对2♣♦（含2，但打完手牌禁收尾）
      p2: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)],
    };
    const engine = mkEngine(hands, { p1: su }, 'p0');
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]).ok).toBe(true); // 对2
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 呕哑含2 但整手对2收尾
    expect(r.ok).toBe(false);
  });

  it('呕哑：接出的牌照常触发巨石判定（驱逐对象是玊）', () => {
    const hands = {
      p0: [pick(5, 0), pick(5, 1), pick(9, 0)], // 路人：起对5
      p1: [byRank(5, 10)[1]!, byRank(5, 10)[4]!, byRank(5, 10)[7]!, byRank(5, 10)[9]!], // 玊：炸弹 4×5
      p2: byRank(4, 5), // 雪灾
    };
    const engine = mkEngine(hands, { p1: su, p2: yyXue }, 'p0');
    expect(engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]).ok).toBe(true);
    const r = engine.playCards('p1', hands.p1.map((c) => c.id)); // 呕哑接炸弹（含5）
    expect(r.ok).toBe(true);
    const ask = askOf(r);
    expect(ask?.kind).toBe('confirm'); // 2026-10-07：巨石先问是否发动
    expect(ask?.prompt).toContain('驱逐 玩家1'); // 判定对象是玊（无归属改写）
    const y = engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'yes' });
    expect(y.ok).toBe(true);
    const suit = askOf(y);
    expect(suit?.kind).toBe('suit');
    decline(engine, 'p2', suit);
  });

  it('呕哑：倒序（海棠在场）下同样可用', () => {
    const hands = {
      p0: [pick(8, 0), pick(5, 0), pick(6, 0)], // 海棠：起单8（切倒序）
      p1: [pick(8, 1), pick(8, 2), pick(4, 0)], // 玊：对8♥♣
      p2: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)],
    };
    const engine = mkEngine(hands, { p0: fishy, p1: su }, 'p0');
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 单8，洄游切倒序
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 对8：倒序也压不过单8，但含8 → 呕哑放行
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').table?.label).toBe('对8');
  });

  it('呕哑：端庄翻面接（gap）桌面含实际点数——呕哑可接（含全部点数）', () => {
    const hands = {
      p0: [pick(3, 0), pick(4, 0), pick(5, 0), pick(9, 0), pick(10, 0)], // 路人：起 345
      p1: [pick(4, 1), pick(6, 1), pick(9, 1), pick(10, 1)], // 轴承：翻 4 → 剩 35 非法 → 后继 46（gap）+ 杂牌（防打光获胜）
      p2: [pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3), pick(8, 3)], // 玊：45678 含4、6
    };
    const engine = mkEngine(hands, { p1: button, p2: su }, 'p0');
    expect(engine.playCards('p0', hands.p0.slice(0, 3).map((c) => c.id)).ok).toBe(true); // 345
    const flip = engine.playCards('p1', hands.p1.slice(0, 2).map((c) => c.id), hands.p0[1]!.id); // 翻4 → 翻面接 46
    expect(flip.ok).toBe(true);
    expect(engine.snapshotFor('p0').table?.label).toBe('翻面接 46');
    const r = engine.playCards('p2', hands.p2.map((c) => c.id)); // 45678：含4、6 → 呕哑放行（正常只有炸弹能压 gap）
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').table?.label).toBe('顺子 4-5-6-7-8');
  });

  it('呕哑：打出的手点数和≥20 照常归属惰戈（与亢奋联动，且联动法音）', () => {
    const hands = {
      p0: [pick(13, 0), pick(9, 0), pick(10, 0)], // 路人：起单K♠（13 <20 不触发亢奋）
      p1: [pick(13, 2), pick(13, 3), pick(4, 0)], // 玊：对K♣♦（26）呕哑接
      p2: [pick(3, 3), pick(4, 3), pick(5, 3), pick(6, 3), pick(7, 3)], // 惰戈
    };
    const engine = mkEngine(hands, { p1: su, p2: duoGe }, 'p0');
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 单K
    const r = engine.playCards('p1', [hands.p1[0]!.id, hands.p1[1]!.id]); // 对K 呕哑（26 → 归属惰戈）
    expect(r.ok).toBe(true);
    const faYin = askOf(r);
    expect(faYin?.prompt).toContain('法音'); // 归属惰戈 → 联动法音
    const a1 = engine.resolveAsk('p2', { askId: faYin!.askId!, choice: 'decline' });
    expect(attributed(a1)).toBe(true); // 归属事件随恢复结果一起返回（挂起时事件缓冲）
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0'); // 轮转从惰戈下家
  });
});

/** 无技能路人角色（两倍发牌测试：不受技能影响） */
function plain(): RoleDef {
  return { id: 'plain', name: '路人', skills: [] };
}
