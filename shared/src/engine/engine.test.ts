import { describe, expect, it } from 'vitest';
import { JOKER_SMALL, cardColor, type Card } from '../cards';
import { defaultRules } from '../config';
import type { GameEvent } from './events';
import type { RoleDef, RoleRegistry, SkillAsk } from '../roles/types';
import { listPlayable } from './combos';
import { buildDeck } from './deck';
import { GameEngine, type ActionResult, type EnginePlayer } from './engine';
import { mulberry32 } from './rng';

/** 简单角色工厂（skills 模式） */
function mkRole(id: string, def: Partial<RoleDef> = {}): RoleDef {
  return { id, name: id, skills: [{ id: `${id}-skill`, name: '技能', description: '测试' }], ...def };
}

function mkEngine(
  playerCount: number,
  opts: {
    seed?: number;
    startPlayerId?: string;
    hands?: Record<string, Card[]>;
    deckCount?: number;
    roles?: RoleRegistry;
    roleIds?: Record<string, string>;
  } = {}
) {
  const players: EnginePlayer[] = [];
  for (let i = 0; i < playerCount; i++)
    players.push({ id: `p${i}`, name: `玩家${i}`, roleId: opts.roleIds?.[`p${i}`] ?? '' });
  const cfg = opts.deckCount ? { ...defaultRules, deck: { count: opts.deckCount } } : defaultRules;
  const engine = new GameEngine(cfg, players, {
    rng: mulberry32(opts.seed ?? 1),
    startPlayerId: opts.startPlayerId ?? 'p0',
    roles: opts.roles ?? new Map(),
    handsOverride: opts.hands,
  });
  engine.start();
  return { engine, players };
}

/** 侵略型 AI：能出就随机出一组，不能出才过 */
function aiTurn(engine: GameEngine, playerId: string, rnd: () => number): ActionResult {
  const snap = engine.snapshotFor(playerId);
  const combos = listPlayable(snap.players.find((p) => p.id === playerId)!.hand!, snap.table, defaultRules);
  if (combos.length === 0) return engine.pass(playerId);
  const pick = combos[Math.floor(rnd() * combos.length)]!;
  return engine.playCards(playerId, pick.cards.map((c) => c.id));
}

/** 牌守恒：单个快照内手牌 + 桌面 + 牌堆 + 弃牌堆 + 饼（吐饼） */
function totalCards(snap: ReturnType<GameEngine['snapshotFor']>): number {
  const handCards = snap.players.reduce((x, p) => x + p.handCount, 0);
  const pancakeCards = snap.players.reduce((x, p) => x + p.pancakeCount, 0);
  return handCards + (snap.table ? snap.table.cards.length : 0) + snap.deckCount + snap.discardCount + pancakeCards;
}

describe('GameEngine 游戏循环', () => {
  it('种子化全流程模拟（2-6人）：恰好一个赢家、零和、牌守恒', () => {
    for (let n = 2; n <= 6; n++) {
      for (let seed = 1; seed <= 30; seed++) {
        const { engine, players } = mkEngine(n, { seed });
        const rnd = mulberry32(seed * 999 + 7);
        let guard = 0;
        while (true) {
          if (++guard > 10000) throw new Error(`模拟未收敛 n=${n} seed=${seed}`);
          const turnId = engine.snapshotFor(players[0]!.id).turnPlayerId!;
          const result = aiTurn(engine, turnId, rnd);
          expect(result.ok).toBe(true);
          const snap0 = engine.snapshotFor(players[0]!.id);
          if (snap0.phase === 'finished') {
            const deltas = snap0.scoreDeltas!;
            if (snap0.winnerId === null) {
              // 留 2 禁止收尾：全员只剩单 2/纯王时无人能起牌 → 流局（不记分、手牌都只剩 ≤2 张）
              for (const p of snap0.players) expect(p.handCount).toBeLessThanOrEqual(2);
              for (const p of snap0.players) expect(deltas[p.id]).toBe(0);
            } else {
              // 赢家手牌为 0；留2规则下赢家可能是唯一幸存者（其余全被淘汰）
              const winner = snap0.players.find((p) => p.id === snap0.winnerId)!;
              if (winner.handCount !== 0) {
                expect(snap0.players.filter((p) => p.id !== snap0.winnerId).every((p) => p.eliminated)).toBe(true);
              }
              // 3人局：赢家+2、输家各-1
              if (n === 3) {
                for (const p of snap0.players) {
                  expect(deltas[p.id]).toBe(p.id === snap0.winnerId ? 2 : -1);
                }
              }
            }
            // 零和
            let sum = 0;
            for (const id of players.map((p) => p.id)) sum += deltas[id]!;
            expect(sum).toBe(0);
            // 牌守恒：手牌 + 桌面 + 牌堆 + 弃牌堆 = 162
            expect(totalCards(snap0)).toBe(162);
            // 累计分更新
            for (const p of snap0.players) {
              expect(snap0.totals[p.id]).toBe(deltas[p.id]);
            }
            break;
          }
        }
      }
    }
  });

  it('出完即胜：最后一张打出立刻获胜，即使别人还能压', () => {
    const deck = buildDeck(3);
    const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
    const hands = {
      p0: [byRank(3, 1)[0]!],
      p1: [byRank(4, 1)[0]!, ...byRank(5, 4)],
    };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0' });
    const r = engine.playCards('p0', hands.p0.map((c) => c.id));
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
    expect(snap.scoreDeltas!.p0).toBe(1);
    expect(snap.scoreDeltas!.p1).toBe(-1);
  });

  it('归属改写不改变出完即胜：谁打完谁赢（按物理出牌者判定）', () => {
    // 模拟阿色再问范式：别人压了自己的牌就归属改写为自己（p0 手牌未空）
    const attr = mkRole('attr', {
      hooks: {
        afterPlay(ctx) {
          if (ctx.game.respondedTo() === ctx.self.id) ctx.game.attributeTable(ctx.self.id);
          return;
        },
      },
    });
    const deck = buildDeck(3);
    const c = (r: number, s: number) => deck.find((x) => x.rank === r && x.suit === s)!;
    const hands = { p0: [c(3, 0), c(5, 0)], p1: [c(4, 0)] };
    const { engine } = mkEngine(2, {
      hands,
      startPlayerId: 'p0',
      roles: new Map([['attr', attr]]),
      roleIds: { p0: 'attr' },
    });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    // p1 用最后一张 4♠ 压（恰好大一级）→ 归属改写为 p0 → 但 p1 手牌已空：仍判 p1 获胜
    const r = engine.playCards('p1', [hands.p1[0]!.id]);
    expect(r.ok).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p1');
  });

  it('留2规则：以单2/对2（含王补）打完手牌被禁止，玩家留在局中不判负', () => {
    const deck = buildDeck(3);
    const twos = (n: number) => deck.filter((c) => c.rank === 15).slice(0, n);
    const threes = (n: number) => deck.filter((c) => c.rank === 3).slice(0, n);
    const fours = (n: number) => deck.filter((c) => c.rank === 4).slice(0, n);
    const jokers = deck.filter((c) => c.rank === 16 || c.rank === 17);

    // 单2 打完手牌 → 拒绝（跟牌者只剩一张 2）
    let { engine } = mkEngine(2, { hands: { p0: [twos(1)[0]!], p1: [...threes(1), ...fours(1)] }, startPlayerId: 'p1' });
    expect(engine.playCards('p1', [engine.snapshotFor('p1').players[1]!.hand![0]!.id]).ok).toBe(true); // p1 起单3
    let r = engine.playCards('p0', engine.snapshotFor('p0').players[0]!.hand!.map((c) => c.id));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('不能以单 2/对 2 打完手牌');
    let snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing');
    expect(snap.players[0]!.eliminated).toBe(false); // 不判负，留在局中
    expect(snap.players[0]!.handCount).toBe(1);

    // 对2 打完手牌 → 拒绝
    engine = mkEngine(2, { hands: { p0: [...twos(2)], p1: [...threes(2), ...fours(1)] }, startPlayerId: 'p1' }).engine;
    expect(engine.playCards('p1', engine.snapshotFor('p1').players[1]!.hand!.slice(0, 2).map((c) => c.id)).ok).toBe(true); // 对3
    r = engine.playCards('p0', engine.snapshotFor('p0').players[0]!.hand!.map((c) => c.id));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('不能以单 2/对 2 打完手牌');

    // [2, 王] 也算对2 → 拒绝
    engine = mkEngine(2, { hands: { p0: [twos(1)[0]!, jokers[0]!], p1: [...threes(2), ...fours(1)] }, startPlayerId: 'p1' }).engine;
    expect(engine.playCards('p1', engine.snapshotFor('p1').players[1]!.hand!.slice(0, 2).map((c) => c.id)).ok).toBe(true);
    r = engine.playCards('p0', engine.snapshotFor('p0').players[0]!.hand!.map((c) => c.id));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('不能以单 2/对 2 打完手牌');

    // 2炸（3 张 2）：不受影响，正常获胜
    engine = mkEngine(2, { hands: { p0: [...twos(3)], p1: [deck[0]!] }, startPlayerId: 'p0' }).engine;
    expect(engine.playCards('p0', engine.snapshotFor('p0').players[0]!.hand!.map((c) => c.id)).ok).toBe(true);
    expect(engine.snapshotFor('p0').winnerId).toBe('p0');

    // 纯王组合是结构性非法（王炸不存在），无此情形
  });

  it('留2规则：只剩单2 的起牌者死锁守卫自动过，不判负继续在局中', () => {
    const deck = buildDeck(3);
    const twos = (n: number) => deck.filter((c) => c.rank === 15).slice(0, n);
    const hands = { p0: [twos(1)[0]!], p1: [...deck.filter((c) => c.rank === 3).slice(0, 1)] };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0' });
    // p0 无任何可起牌型 → 自动过，p1 起牌并出完获胜
    const snap = engine.snapshotFor('p1');
    expect(snap.phase).toBe('playing');
    expect(snap.turnPlayerId).toBe('p1');
    expect(engine.playCards('p1', engine.snapshotFor('p1').players[1]!.hand!.map((c) => c.id)).ok).toBe(true);
    const end = engine.snapshotFor('p1');
    expect(end.phase).toBe('finished');
    expect(end.winnerId).toBe('p1');
    expect(end.players[0]!.eliminated).toBe(false); // 留2者不判负
    expect(end.players[0]!.handCount).toBe(1);
    expect(end.scoreDeltas!.p0).toBe(-1);
    expect(end.scoreDeltas!.p1).toBe(1);
  });

  it('留2规则：3人局多人只剩单2/纯王由死锁守卫跳过，能起牌者继续', () => {
    const deck = buildDeck(3);
    const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
    const hands = {
      p0: [byRank(15, 1)[0]!], // 单2 无法起牌
      p1: [byRank(16, 1)[0]!, byRank(17, 1)[0]!], // 纯王无法起牌
      p2: [byRank(3, 1)[0]!, ...byRank(4, 4)],
    };
    const { engine } = mkEngine(3, { hands, startPlayerId: 'p0' });
    const snap = engine.snapshotFor('p2');
    expect(snap.phase).toBe('playing'); // 不流局（p2 可起牌）
    expect(snap.turnPlayerId).toBe('p2');
    expect(snap.players[0]!.eliminated).toBe(false); // 留2者不判负
    expect(snap.players[0]!.handCount).toBe(1);
    expect(snap.players[1]!.eliminated).toBe(false);
    expect(snap.table).toBeNull(); // 前面的人都是死锁自动过，未出牌
  });

  it('留2规则：全员只剩单2 → 流局（无人能起牌，不记分）', () => {
    const deck = buildDeck(3);
    const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
    const hands = {
      p0: [byRank(15, 1)[0]!],
      p1: [byRank(15, 2)[0]!],
      p2: [byRank(15, 3)[0]!],
    };
    const { engine } = mkEngine(3, { hands, startPlayerId: 'p0' });
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBeNull();
    expect(snap.scoreDeltas).toEqual({ p0: 0, p1: 0, p2: 0 });
  });

  it('纯王手牌起牌者：自动过，下家起牌（死锁守卫）', () => {
    const deck = buildDeck(3);
    const jokers = deck.filter((c) => c.rank === 16 || c.rank === 17).slice(0, 2);
    const hands = {
      p0: [...jokers],
      p1: deck.filter((c) => c.rank === 3).slice(0, 5),
    };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0' });
    const snap = engine.snapshotFor('p1');
    expect(snap.turnPlayerId).toBe('p1'); // p0 自动过，p1 起牌
    expect(snap.table).toBeNull();
    const events = engine.playCards('p1', engine.snapshotFor('p1').players[1]!.hand!.slice(0, 1).map((c) => c.id));
    expect(events.ok).toBe(true);
  });

  it('全员纯王手牌：无人能起牌 → 流局（无赢家、不记分）', () => {
    const deck = buildDeck(3);
    const jokers = deck.filter((c) => c.rank === 16 || c.rank === 17);
    const hands = {
      p0: [...jokers.slice(0, 2)],
      p1: [...jokers.slice(2, 4)],
      p2: [...jokers.slice(4, 6)],
    };
    const { engine } = mkEngine(3, { hands, startPlayerId: 'p0' });
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBeNull();
    expect(snap.turnPlayerId).toBeNull();
    expect(snap.scoreDeltas).toEqual({ p0: 0, p1: 0, p2: 0 });
    expect(snap.totals).toEqual({ p0: 0, p1: 0, p2: 0 }); // 流局累计分不变
    const ended = engine.drainEvents().find((e) => e.type === 'game:ended') as
      | { winnerId: string | null }
      | undefined;
    expect(ended?.winnerId).toBeNull();
  });

  it('新一轮起牌者不能过（必须出牌）', () => {
    const deck = buildDeck(3);
    const hands = {
      p0: deck.filter((c) => c.rank === 3).slice(0, 5),
      p1: deck.filter((c) => c.rank === 4).slice(0, 5),
    };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0' });
    const r = engine.pass('p0');
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('必须出牌');
  });

  it('一轮结束：无人管时出牌者摸 1 张并继续起牌', () => {
    const deck = buildDeck(3);
    const hands = {
      p0: deck.filter((c) => c.rank === 3).slice(0, 6),
      p1: deck.filter((c) => c.rank === 10).slice(0, 5),
      p2: deck.filter((c) => c.rank === 10).slice(5, 10),
    };
    const { engine } = mkEngine(3, { hands, startPlayerId: 'p0' });
    const before = engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount;
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // p0 出单3
    expect(engine.pass('p1').ok).toBe(true); // p1 过
    const r = engine.pass('p2'); // p2 过 → 一轮结束
    expect(r.ok).toBe(true);
    const events = (r as { events: { type: string }[] }).events;
    expect(events.some((e) => e.type === 'round:ended')).toBe(true);
    const after = engine.snapshotFor('p0').players.find((p) => p.id === 'p0')!.handCount;
    expect(after).toBe(before); // 出了1张摸回1张
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0'); // p0 继续起牌
  });

  it('牌堆耗尽后游戏仍能结束（小牌库模拟）', () => {
    const { engine, players } = mkEngine(2, { seed: 42, deckCount: 1 });
    const rnd = mulberry32(4242);
    let guard = 0;
    while (true) {
      if (++guard > 10000) throw new Error('模拟未收敛');
      const snap0 = engine.snapshotFor(players[0]!.id);
      if (snap0.phase === 'finished') break;
      const r = aiTurn(engine, snap0.turnPlayerId!, rnd);
      expect(r.ok).toBe(true);
    }
    const snap0 = engine.snapshotFor(players[0]!.id);
    expect(snap0.winnerId).not.toBeNull();
    // 牌守恒：手牌 + 桌面 + 牌堆 + 弃牌堆 = 54（单副牌）
    expect(totalCards(snap0)).toBe(54);
  });

  it('牌堆耗尽：轮末补摸时弃牌堆洗回牌堆（发 deck:recycled）', () => {
    const deck = buildDeck(1);
    const pick = (r: number, s: number) => deck.find((c) => c.rank === r && c.suit === s)!;
    const used = new Set([pick(3, 2).id, pick(5, 0).id, pick(4, 3).id]);
    const filler = deck.filter((c) => !used.has(c.id));
    const hands = {
      p0: [pick(3, 2), pick(5, 0), ...filler.slice(0, 16)], // 18 张
      p1: [pick(4, 3), ...filler.slice(16, 33)], // 18 张
      p2: filler.slice(33), // 18 张
    }; // 18 × 3 = 54 → 牌堆 0
    const { engine } = mkEngine(3, { hands, deckCount: 1, startPlayerId: 'p0' });
    expect(engine.playCards('p0', [pick(3, 2).id]).ok).toBe(true); // 单3
    expect(engine.playCards('p1', [pick(4, 3).id]).ok).toBe(true); // 压单4 → ♣3 进弃牌堆
    expect(engine.pass('p2').ok).toBe(true); // p2 过 → 轮回 p0
    expect(engine.playCards('p0', [pick(5, 0).id]).ok).toBe(true); // 压单5
    expect(engine.pass('p1').ok).toBe(true);
    const r = engine.pass('p2'); // 除出牌者外全过 → 轮末 p0 摸 1 → 牌堆空 → 弃牌 2 张洗回（桌面 ♠5 尚未进弃牌堆）
    expect(r.ok).toBe(true);
    expect((r as { events: GameEvent[] }).events.some((e) => e.type === 'deck:recycled' && e.count === 2)).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.deckCount).toBe(1); // 洗回 2、摸 1
    expect(snap.discardCount).toBe(1); // 洗回后桌面 ♠5 进弃牌堆
    expect(totalCards(snap)).toBe(54);
  });

  it('牌堆耗尽：判定类技能翻牌时弃牌堆洗回（revealTop 走洗回）', () => {
    const deck = buildDeck(1);
    const pick = (r: number, s: number) => deck.find((c) => c.rank === r && c.suit === s)!;
    const probe = mkRole('probe', {
      hooks: {
        onRoundEnd(ctx) {
          const cards = ctx.game.revealTop(1, '探针');
          if (cards.length > 0) ctx.game.discardRevealed(cards.map((c) => c.id));
          return { ok: true };
        },
      },
    });
    const used = new Set([pick(3, 2).id, pick(4, 3).id]);
    const filler = deck.filter((c) => !used.has(c.id));
    const hands = {
      p0: [pick(3, 2), ...filler.slice(0, 17)], // 18 张
      p1: [pick(4, 3), ...filler.slice(17, 34)], // 18 张
      p2: filler.slice(34), // 18 张（探针）
    }; // 18 × 3 = 54 → 牌堆 0
    const registry: RoleRegistry = new Map([['probe', probe]]);
    const { engine } = mkEngine(3, {
      hands,
      deckCount: 1,
      startPlayerId: 'p0',
      roles: registry,
      roleIds: { p2: 'probe' },
    });
    expect(engine.playCards('p0', [pick(3, 2).id]).ok).toBe(true); // 单3
    expect(engine.playCards('p1', [pick(4, 3).id]).ok).toBe(true); // 压单4 → ♣3 进弃牌堆
    expect(engine.pass('p2').ok).toBe(true);
    const r = engine.pass('p0'); // 全过 → 轮末钩子：翻牌 → 牌堆空 → 弃牌 1 张洗回 → 翻 1 弃 1
    expect(r.ok).toBe(true);
    const evs = (r as { events: GameEvent[] }).events;
    expect(evs.some((e) => e.type === 'deck:recycled' && e.count === 1)).toBe(true);
    expect(evs.some((e) => e.type === 'cards:revealed')).toBe(true);
    const snap = engine.snapshotFor('p0');
    expect(snap.deckCount).toBe(0); // 翻牌洗回 1 → 翻 1 弃 1 → 轮末补摸再次洗回摸 1 → 0
    expect(snap.discardCount).toBe(1); // 轮末后桌面 ♦4 进弃牌堆
    expect(totalCards(snap)).toBe(54);
  });

  it('起牌者出牌后，跟牌者必须恰好大一级（基础规则拒绝）', () => {
    const deck = buildDeck(3);
    const hands = {
      p0: deck.filter((c) => c.rank === 3).slice(0, 6),
      p1: [deck.find((c) => c.rank === 5)!], // 只有单5
    };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0' });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 单3
    const r = engine.playCards('p1', [hands.p1[0]!.id]); // 单5 管单3 → 非法
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('恰好大一级');
  });

  it('王不能单独打出（引擎拒绝）', () => {
    const deck = buildDeck(3);
    const joker = deck.find((c) => c.rank === 16)!;
    const hands = {
      p0: [joker, ...deck.filter((c) => c.rank === 3).slice(0, 5)],
      p1: deck.filter((c) => c.rank === 4).slice(0, 5),
    };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0' });
    const r = engine.playCards('p0', [joker.id]);
    expect(r.ok).toBe(false);
  });
});

describe('框架：淘汰 / 手牌上限 / 询问挂起 / 插队 / 翻牌池', () => {
  const deck = buildDeck(3);
  const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);

  it('手牌上限：开局超 20 张立即淘汰，仅剩一人直接获胜', () => {
    const hands = { p0: byRank(3, 5), p1: [...byRank(4, 12), ...byRank(5, 9)] }; // p1 共 21 张
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0' });
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe('p0');
    const p1 = snap.players.find((p) => p.id === 'p1')!;
    expect(p1.eliminated).toBe(true);
    expect(p1.handCount).toBe(0);
    expect(snap.scoreDeltas).toEqual({ p0: 1, p1: -1 }); // 淘汰者记 −1，零和不变
    expect(totalCards(snap)).toBe(162);
    expect(engine.drainEvents().some((e) => e.type === 'player:eliminated')).toBe(true);
  });

  it('询问挂起：出牌前 ask → 恢复（yes 提交 / decline 否决为 game:error），挂起时其他动作被拒', () => {
    const role = mkRole('ask-veto', {
      hooks: {
        beforePlay(ctx, proposed) {
          if (ctx.game.turnPlayerId() !== ctx.self.id) return;
          if (proposed.table || proposed.combo.type !== 'single' || proposed.combo.rank !== 3) return;
          if (!ctx.answer) return { ok: true, ask: { kind: 'confirm', prompt: '确认出单3？' } };
          if (ctx.answer.choice === 'yes') return { ok: true };
          return { ok: false, reason: '自己否决了' };
        },
      },
    });
    const hands = { p0: [byRank(3, 1)[0]!, ...byRank(9, 4)], p1: byRank(13, 5) };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['ask-veto', role]]), roleIds: { p0: 'ask-veto' } });
    const r = engine.playCards('p0', [hands.p0[0]!.id]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    // 挂起期间其他动作被拒
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(false);
    expect(engine.pass('p0').ok).toBe(false);
    // 错误回答者 / 失效 askId
    const badWho = engine.resolveAsk('p1', { askId: ask!.askId!, choice: 'yes' });
    expect(badWho.ok).toBe(false);
    const stale = engine.resolveAsk('p0', { askId: 'ask-999', choice: 'yes' });
    expect(stale.ok).toBe(false);
    // 拒绝：出牌中止 → game:error
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'game:error' && e.reason === '自己否决了')).toBe(true);
    let snap = engine.snapshotFor('p0');
    expect(snap.table).toBeNull();
    expect(snap.turnPlayerId).toBe('p0');
    // 再试并同意：提交
    const r2 = engine.playCards('p0', [hands.p0[0]!.id]);
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.askId).not.toBe(ask?.askId); // askId 自增不重复
    const a = engine.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'cards:played')).toBe(true);
    snap = engine.snapshotFor('p0');
    expect(snap.table?.rank).toBe(3);
    expect(snap.turnPlayerId).toBe('p1');
  });

  it('打断钩子：出 2 被驱逐（淘汰 + 夺权），桌面作废、驱逐者起牌、牌守恒', () => {
    const role = mkRole('interruptor', {
      hooks: {
        onPlayInterrupt(ctx, played) {
          if (played.type !== 'single' || played.rank !== 15) return;
          const owner = ctx.game.roundLastPlayerId()!;
          if (owner === ctx.self.id) return;
          ctx.game.announce('interruptor', 'ju-shi', '驱逐！');
          return { ok: true, modify: { eliminate: [owner], seizeLead: true } };
        },
      },
    });
    const hands = { p0: [byRank(15, 1)[0]!, ...byRank(9, 4)], p1: byRank(13, 5), p2: byRank(12, 5) };
    const { engine } = mkEngine(3, { hands, startPlayerId: 'p0', roles: new Map([['interruptor', role]]), roleIds: { p1: 'interruptor' } });
    const r = engine.playCards('p0', [hands.p0[0]!.id]); // 出单2
    expect(r.ok).toBe(true);
    const events = r.ok ? r.events : [];
    expect(events.some((e) => e.type === 'player:eliminated' && e.playerId === 'p0')).toBe(true);
    expect(events.some((e) => e.type === 'skill:triggered')).toBe(true);
    const snap = engine.snapshotFor('p1');
    expect(snap.phase).toBe('playing'); // 驱逐优先于获胜
    const p0 = snap.players.find((p) => p.id === 'p0')!;
    expect(p0.eliminated).toBe(true);
    expect(p0.handCount).toBe(0);
    expect(snap.table).toBeNull(); // 桌面作废
    expect(snap.turnPlayerId).toBe('p1'); // 驱逐者起牌
    expect(totalCards(snap)).toBe(162);
  });

  it('插队（canCutIn）：接受 → 插队者接牌、被响应者摸 X 张、从插队者下家继续；拒绝 → 正常轮转', () => {
    const cutter = mkRole('cutter', { canCutIn: true });
    const sameSuit4 = deck.filter((c) => c.rank === 4 && c.suit === 0).slice(0, 2); // 两张黑桃4
    const hands = {
      p0: [byRank(3, 2)[0]!, byRank(3, 2)[1]!, ...byRank(9, 3)],
      p1: byRank(13, 5),
      p2: [...sameSuit4, ...byRank(10, 3)],
    };
    // 接受路径
    const { engine } = mkEngine(3, {
      hands,
      startPlayerId: 'p0',
      roles: new Map([['cutter', cutter]]), roleIds: { p2: 'cutter' },
    });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 起对3
    expect(r.ok).toBe(true);
    expect(r.ok && r.suspended).toBe(true);
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('cutIn');
    const a = engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'yes', cardIds: sameSuit4.map((c) => c.id) });
    expect(a.ok).toBe(true);
    const snap = engine.snapshotFor('p2');
    expect(snap.table?.rank).toBe(4); // 对4 压上
    expect(snap.turnPlayerId).toBe('p0'); // 从插队者 p2 的下家继续（跳过 p1）
    const p0 = snap.players.find((p) => p.id === 'p0')!;
    expect(p0.handCount).toBe(5 - 2 + 8); // 被响应者摸 X = 4+4 = 8
    const p2 = snap.players.find((p) => p.id === 'p2')!;
    expect(p2.handCount).toBe(5 - 2);
    // 拒绝路径：正常轮转到下家
    const { engine: e2 } = mkEngine(3, {
      hands,
      startPlayerId: 'p0',
      roles: new Map([['cutter', cutter]]), roleIds: { p2: 'cutter' },
    });
    const r2 = e2.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]);
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    expect(ask2?.kind).toBe('cutIn');
    const d = e2.resolveAsk('p2', { askId: ask2!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(e2.snapshotFor('p1').turnPlayerId).toBe('p1');
    expect(e2.snapshotFor('p1').table?.rank).toBe(3);
  });

  it('洄游切换：插队出牌同样计一次切换（flipsOrderOnPlay + canCutIn）', () => {
    const flipcut = mkRole('flipcut', { flipsOrderOnPlay: true, canCutIn: true });
    const sameSuit5 = deck.filter((c) => c.rank === 5 && c.suit === 0).slice(0, 2); // 两张黑桃5
    const hands = {
      p0: [byRank(4, 2)[0]!, byRank(4, 2)[1]!, ...byRank(9, 3)],
      p1: byRank(13, 5),
      p2: [...sameSuit5, ...byRank(10, 3)],
    };
    const { engine } = mkEngine(3, {
      hands,
      startPlayerId: 'p0',
      roles: new Map([['flipcut', flipcut]]),
      roleIds: { p2: 'flipcut' },
    });
    const r = engine.playCards('p0', [hands.p0[0]!.id, hands.p0[1]!.id]); // 起对4
    expect(r.ok).toBe(true);
    expect(engine.snapshotFor('p0').orderReversed).toBe(false); // 插队接受前尚未切换
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('cutIn');
    const a = engine.resolveAsk('p2', { askId: ask!.askId!, choice: 'yes', cardIds: sameSuit5.map((c) => c.id) });
    expect(a.ok).toBe(true);
    const snap = engine.snapshotFor('p2');
    expect(snap.orderReversed).toBe(true); // 插队者的物理出牌同样切换牌序
    expect(snap.table?.rank).toBe(5); // 对5 压上
    expect(snap.turnPlayerId).toBe('p0'); // 从插队者下家继续
    const p0 = snap.players.find((p) => p.id === 'p0')!;
    expect(p0.handCount).toBe(5 - 2 + 10); // 被响应者摸 X = 5+5 = 10
  });

  it('翻牌池守恒：未收尾的技能泄漏直接抛错；takeRevealed/discardRevealed 正常收尾', () => {
    const leakRole = mkRole('leaker', {
      hooks: { onTurnStart(ctx) { ctx.game.revealTop(1); } },
    });
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5) };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['leaker', leakRole]]), roleIds: { p0: 'leaker' } });
    expect(() => engine.playCards('p0', [hands.p0[0]!.id])).toThrow('翻牌池未清空');
    // 正常收尾：翻 2 张 → 拿 1 张（豁免）→ 弃余下
    const cleanRole = mkRole('cleaner', {
      hooks: {
        onTurnStart(ctx) {
          if (ctx.game.turnPlayerId() !== ctx.self.id) return;
          const top = ctx.game.revealTop(2);
          ctx.game.takeRevealed(ctx.self.id, [top[0]!.id]);
          ctx.game.discardRevealed();
        },
      },
    });
    const { engine: e2 } = mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['cleaner', cleanRole]]), roleIds: { p0: 'cleaner' } });
    expect(e2.snapshotFor('p0').players[0]!.handCount).toBe(6); // 5 + 1
    const r = e2.playCards('p0', [hands.p0[0]!.id]);
    expect(r.ok).toBe(true); // 池已清空，不抛错
  });

  it('回合开始钩子询问挂起（开局整备）：两段询问恢复后照常出牌', () => {
    const starter = mkRole('starter', {
      setup() {
        return { stage: null as null | 'pick', done: false };
      },
      hooks: {
        onTurnStart(ctx) {
          const st = ctx.state as { stage: null | 'pick'; done: boolean };
          if (ctx.game.eliminated(ctx.self.id)) return;
          if (ctx.game.turnPlayerId() !== ctx.self.id || ctx.game.roundLeaderId() !== ctx.self.id) return;
          if (st.stage === 'pick') {
            // 选目标阶段（多阶段重跑）
            st.stage = null;
            ctx.game.announce('starter', 'starter-skill', `指定 ${ctx.answer?.targetPlayerId}`);
            return;
          }
          if (st.done && !ctx.answer) return;
          st.done = true;
          if (!ctx.answer) return { ok: true, ask: { kind: 'confirm', prompt: '整备确认？' } };
          if (ctx.answer.choice === 'decline') return;
          st.stage = 'pick';
          return { ok: true, ask: { kind: 'pickTarget', prompt: '指定一人', targetCandidates: ['p1'] } };
        },
      },
    });
    const hands = { p0: [byRank(3, 1)[0]!, byRank(4, 1)[0]!], p1: byRank(13, 5) };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['starter', starter]]), roleIds: { p0: 'starter' } });
    // 开局即挂起（首回合无摸牌但有整备阶段）
    const ask = engine.snapshotFor('p0').pendingAsk;
    expect(ask?.kind).toBe('confirm');
    // 挂起期间动作被拒
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(false);
    // 确认 → 选目标 → 恢复
    const yes = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(yes.ok).toBe(true);
    const pick = yes.ok ? (yes.pendingAsk as SkillAsk) : null;
    expect(pick?.kind).toBe('pickTarget');
    const done = engine.resolveAsk('p0', { askId: pick!.askId!, targetPlayerId: 'p1' });
    expect(done.ok).toBe(true);
    expect(done.ok && done.events.some((e) => e.type === 'skill:triggered')).toBe(true);
    // 恢复正常出牌
    expect(engine.snapshotFor('p0').pendingAsk).toBeNull();
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.snapshotFor('p1').turnPlayerId).toBe('p1');
  });

  it('翻牌公开：revealTop 广播 cards:revealed（含 purpose），挂起期间快照 revealed 池所有人可见', () => {
    const openFlip = mkRole('open-flip', {
      setup() {
        return { flipped: false };
      },
      hooks: {
        onRoundEnd(ctx, lastPlayerId) {
          if (lastPlayerId !== ctx.self.id) return;
          if (!ctx.answer) return { ok: true, ask: { kind: 'confirm', prompt: '翻牌？' } };
          if (ctx.answer.choice !== 'yes') return;
          if (!(ctx.state as { flipped: boolean }).flipped) {
            (ctx.state as { flipped: boolean }).flipped = true;
            ctx.game.revealTop(1, '测试判定');
            // 二次挂起：展示区未清空期间，其他玩家的快照也能看到这张牌
            return { ok: true, ask: { kind: 'confirm', prompt: '二次确认' } };
          }
          ctx.game.discardRevealed();
        },
      },
    });
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5) };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['open-flip', openFlip]]), roleIds: { p0: 'open-flip' } });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.pass('p1');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'yes' });
    expect(d.ok).toBe(true);
    const ev = d.ok ? d.events.find((e) => e.type === 'cards:revealed') : undefined;
    expect(ev).toBeTruthy();
    expect((ev as { purpose?: string } | undefined)?.purpose).toBe('测试判定');
    // p1（旁观视角）也能看到翻出的牌与未决询问
    const snap = engine.snapshotFor('p1');
    expect(snap.revealed.length).toBe(1);
    expect(snap.pendingAsk?.kind).toBe('confirm');
    // 收尾后展示区清空
    const d2 = engine.resolveAsk('p0', { askId: snap.pendingAsk!.askId!, choice: 'yes' });
    expect(d2.ok).toBe(true);
    expect(engine.snapshotFor('p1').revealed.length).toBe(0);
  });

  it('盲抽询问：hidden pickCards 经 currentAsk 只暴露牌背（id 保留回传、牌面掩码，非本人拿不到）', () => {
    const blind = mkRole('blind', {
      hooks: {
        onRoundEnd(ctx, lastPlayerId) {
          if (lastPlayerId !== ctx.self.id) return;
          return {
            ok: true,
            ask: {
              kind: 'pickCards',
              prompt: '盲抽 1 张',
              cards: [...ctx.game.handOf('p1')],
              min: 1,
              max: 1,
              hidden: true,
            },
          };
        },
      },
    });
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5) };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['blind', blind]]), roleIds: { p0: 'blind' } });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.pass('p1');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.hidden).toBe(true);
    // 服务端下发（currentAsk）时牌面已掩码，id 保留供回传
    const served = engine.currentAsk('p0');
    expect(served?.kind).toBe('pickCards');
    expect(served?.cards?.length).toBe(5);
    expect(served?.cards?.every((c) => (c as { rank: number }).rank === 0 && (c as { suit: number }).suit === 0)).toBe(true);
    expect(served?.cards?.map((c) => c.id)).toEqual(hands.p1.map((c) => c.id));
    expect(engine.currentAsk('p1')).toBeNull(); // 只发给被询问者
  });

  it('判定豁免只持续一轮：超限但豁免 → 不淘汰；豁免到期 → 淘汰', () => {
    let revealed = false;
    const judge = mkRole('judge', {
      hooks: {
        onTurnStart(ctx) {
          if (ctx.game.turnPlayerId() !== ctx.self.id || revealed) return;
          revealed = true;
          const top = ctx.game.revealTop(2);
          ctx.game.takeRevealed(ctx.self.id, top.map((c) => c.id));
        },
      },
    });
    const hands = {
      p0: [byRank(3, 1)[0]!, byRank(4, 1)[0]!, ...byRank(9, 12), ...byRank(10, 6)], // 20 张
      p1: byRank(13, 5),
    };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['judge', judge]]), roleIds: { p0: 'judge' } });
    // 开局判定拿 2 张 → 22 张但豁免 2，不淘汰
    const snap0 = engine.snapshotFor('p0');
    expect(snap0.players[0]!.handCount).toBe(22);
    expect(snap0.players[0]!.eliminated).toBe(false);
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true); // 出单3
    expect(engine.pass('p1').ok).toBe(true); // 一轮结束，p0 摸 1 → 22，豁免仍在
    const snap1 = engine.snapshotFor('p0');
    expect(snap1.players[0]!.handCount).toBe(22);
    expect(snap1.players[0]!.eliminated).toBe(false);
    expect(engine.playCards('p0', [hands.p0[1]!.id]).ok).toBe(true); // 出单4
    const r2 = engine.pass('p1'); // 再一轮结束，豁免到期 → 22 > 20 淘汰
    expect(r2.ok).toBe(true);
    expect(r2.ok && r2.events.some((e) => e.type === 'player:eliminated' && e.reason === '手牌超过上限')).toBe(true);
    const snap2 = engine.snapshotFor('p0');
    expect(snap2.phase).toBe('finished');
    expect(snap2.winnerId).toBe('p1');
    expect(snap2.players.find((p) => p.id === 'p0')!.eliminated).toBe(true);
  });

  it('suppressDraw：轮末跳过自动摸牌', () => {
    const role = mkRole('no-draw', {
      hooks: {
        onRoundEnd(ctx, lastPlayerId) {
          if (lastPlayerId !== ctx.self.id) return;
          return { ok: true, modify: { suppressDraw: true } };
        },
      },
    });
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5) };
    const { engine } = mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['no-draw', role]]), roleIds: { p0: 'no-draw' } });
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.pass('p1');
    expect(r.ok).toBe(true);
    const events = r.ok ? r.events : [];
    const ended = events.find((e) => e.type === 'round:ended') as { drew: number } | undefined;
    expect(ended?.drew).toBe(0);
    const snap = engine.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBe(4); // 出了 1 张没摸回
    expect(snap.turnPlayerId).toBe('p0'); // 仍由 p0 起牌
  });

  it('onRoundEnd 询问：判定流程（拒绝正常摸牌 / 接受翻牌拿黑牌+抑制摸牌）', () => {
    const role = mkRole('hei-lian', {
      hooks: {
        onRoundEnd(ctx, lastPlayerId) {
          if (lastPlayerId !== ctx.self.id) return;
          if (!ctx.answer) return { ok: true, ask: { kind: 'confirm', prompt: '是否发动判定？' } };
          if (ctx.answer.choice !== 'yes') return;
          const top = ctx.game.revealTop(5);
          const blacks = top.filter((c) => cardColor(c) === 'black');
          ctx.game.takeRevealed(ctx.self.id, blacks.map((c) => c.id));
          ctx.game.discardRevealed();
          ctx.game.announce('hei-lian', 'hei-lian', `获得 ${blacks.length} 张黑牌`);
          return { ok: true, modify: { suppressDraw: true } };
        },
      },
    });
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5) };
    const mk = () =>
      mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['hei-lian', role]]), roleIds: { p0: 'hei-lian' } });
    // 拒绝：正常摸牌
    const { engine } = mk();
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r = engine.pass('p1');
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(d.ok && d.events.some((e) => e.type === 'round:ended' && e.drew === 1)).toBe(true);
    // 接受：翻 5 张拿黑牌，抑制自动摸牌，池清空
    const { engine: e2 } = mk();
    expect(e2.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    const r2 = e2.pass('p1');
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const a = e2.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    const events = a.ok ? a.events : [];
    expect(events.some((e) => e.type === 'skill:triggered')).toBe(true);
    expect(events.some((e) => e.type === 'round:ended' && e.drew === 0)).toBe(true);
    const snap = e2.snapshotFor('p0');
    expect(snap.players[0]!.handCount).toBeGreaterThanOrEqual(4); // 4 + 黑牌数 ≥ 4
    expect(snap.phase).toBe('playing'); // 池清空不抛错
  });

  it('onSkillAction 询问循环：ask → 恢复 → endTurn 换轮', () => {
    const role = mkRole('huan-pai', {
      skillActions: [{ skillId: 'huan', when: 'myTurn', label: '换牌' }],
      hooks: {
        onSkillAction(ctx, req) {
          if (req.skillId !== 'huan') return;
          if (!ctx.answer) return { ok: true, ask: { kind: 'confirm', prompt: '要换牌吗？' } };
          if (ctx.answer.choice !== 'yes') return;
          ctx.game.announce('huan-pai', 'huan', '换牌完成');
          return { ok: true, modify: { endTurn: true } };
        },
      },
    });
    const hands = { p0: byRank(3, 5), p1: byRank(13, 5) };
    const mk = () =>
      mkEngine(2, { hands, startPlayerId: 'p0', roles: new Map([['huan-pai', role]]), roleIds: { p0: 'huan-pai' } });
    // 拒绝：不换轮
    const { engine } = mk();
    const r = engine.useSkillAction('p0', { skillId: 'huan' });
    const ask = r.ok ? (r.pendingAsk as SkillAsk) : null;
    expect(ask?.kind).toBe('confirm');
    const d = engine.resolveAsk('p0', { askId: ask!.askId!, choice: 'decline' });
    expect(d.ok).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
    // 同意：换轮
    const { engine: e2 } = mk();
    const r2 = e2.useSkillAction('p0', { skillId: 'huan' });
    const ask2 = r2.ok ? (r2.pendingAsk as SkillAsk) : null;
    const a = e2.resolveAsk('p0', { askId: ask2!.askId!, choice: 'yes' });
    expect(a.ok).toBe(true);
    expect(a.ok && a.events.some((e) => e.type === 'turn:started' && e.playerId === 'p1')).toBe(true);
    expect(e2.snapshotFor('p0').turnPlayerId).toBe('p1');
  });
});
