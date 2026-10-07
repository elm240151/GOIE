// 自定义摸牌（Elm 开发者账号，2026-10-07）引擎级测试。
// 定稿模型「摸后换牌」：摸牌照常随机完成（结算流零破坏），动作收尾挂起 devSwap 询问逐张换牌——
// 指定牌从源堆取出、旧牌洗回随机位（牌守恒不变）；保持这张/剩余全部保持/超时均走下一张。
// 覆盖：开局发牌换牌闭环 / restKeep / 找不到牌重问 / 开关默认关零打扰 / 动作期轮末摸牌 /
// 技能摸牌（阿摩贪婪出牌后摸 1）/ 开关关闭清除挂起。
import { describe, expect, it } from 'vitest';
import { isJoker, type Card } from '../cards';
import { defaultRules } from '../config';
import type { RoleDef, RoleRegistry } from '../roles/types';
import amo from '../roles/amo';
import { buildDeck, shuffle } from './deck';
import { GameEngine, type EnginePlayer } from './engine';
import { mulberry32 } from './rng';

const plain = (): RoleDef => ({ id: 'plain', name: '路人', skills: [] });

function mkPlayers(n: number, roleIds: Record<string, string> = {}): EnginePlayer[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `玩家${i}`, roleId: roleIds[`p${i}`] ?? '' }));
}

/** 真实发牌（devSwap 依赖 rawDraw 记录，不能用 handsOverride） */
function mkDealEngine(opts: { seed?: number; devIds?: string[]; roles?: RoleRegistry; roleIds?: Record<string, string> } = {}) {
  const players = mkPlayers(2, opts.roleIds);
  const engine = new GameEngine(defaultRules, players, {
    rng: mulberry32(opts.seed ?? 1),
    startPlayerId: 'p0',
    roles: opts.roles ?? new Map(),
    devDrawPlayerIds: opts.devIds ?? [],
  });
  engine.start();
  return { engine, players };
}

/** 固定手牌（牌堆 = 整副去掉手牌，未洗牌自然序） */
function mkHandsEngine(hands: Record<string, Card[]>, opts: { devIds?: string[]; roles?: RoleRegistry; roleIds?: Record<string, string> } = {}) {
  const players = mkPlayers(Object.keys(hands).length, opts.roleIds);
  const engine = new GameEngine(defaultRules, players, {
    rng: mulberry32(1),
    startPlayerId: 'p0',
    roles: opts.roles ?? new Map(),
    handsOverride: hands,
    devDrawPlayerIds: opts.devIds ?? [],
  });
  engine.start();
  return { engine, players };
}

const handOf = (engine: GameEngine, pid: string): Card[] =>
  engine.snapshotFor(pid).players.find((p) => p.id === pid)!.hand!;
const totalCards = (engine: GameEngine): number => {
  const snap = engine.snapshotFor('p0');
  return (
    snap.players.reduce((s, p) => s + p.handCount, 0) +
    snap.deckCount +
    snap.discardCount +
    (snap.table ? snap.table.cards.length : 0)
  );
};

describe('自定义摸牌（Elm 开发者账号）', () => {
  it('开局发牌换牌闭环：逐张询问 → 换牌生效守恒 → restKeep 收尾开局', () => {
    const seed = 1;
    const { engine } = mkDealEngine({ seed, devIds: ['p0'] });
    // 发牌从牌堆尾摸：先手 p0 摸 6 张（牌堆尾 6 张，splice 升序 = 摸牌序）
    const deck = shuffle(buildDeck(3), mulberry32(seed));
    const p0Drawn = deck.slice(156);
    expect(p0Drawn).toHaveLength(6);
    // 第 1 张挂起
    expect(engine.pendingAskPlayerId).toBe('p0');
    const ask1 = engine.currentAsk('p0')!;
    expect(ask1.kind).toBe('devSwap');
    expect(ask1.cards![0]!.id).toBe(p0Drawn[0]!.id);
    expect(ask1.swapIndex).toBe(0);
    expect(ask1.swapTotal).toBe(6);
    // 换成牌堆底那张（必在牌堆中——发牌只摸了尾 11 张）
    const target = deck[0]!;
    const spec = isJoker(target) ? { joker: target.rank } : { suit: target.suit, rank: target.rank };
    const r1 = engine.resolveAsk('p0', { askId: ask1.askId!, swapSpec: spec });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      // 换牌播报（skill:triggered roleId=dev）
      expect(r1.events.some((e) => e.type === 'skill:triggered' && e.playerId === 'p0')).toBe(true);
    }
    const hand1 = handOf(engine, 'p0');
    expect(hand1.some((c) => c.id === target.id)).toBe(true);
    expect(hand1.some((c) => c.id === p0Drawn[0]!.id)).toBe(false);
    // 下一张挂起
    const ask2 = engine.currentAsk('p0')!;
    expect(ask2.kind).toBe('devSwap');
    expect(ask2.cards![0]!.id).toBe(p0Drawn[1]!.id);
    // 剩余全部保持 → 开局收尾
    const r2 = engine.resolveAsk('p0', { askId: ask2.askId!, choice: 'restKeep' });
    expect(r2.ok).toBe(true);
    expect(engine.pendingAskPlayerId).toBeNull();
    const snap = engine.snapshotFor('p0');
    expect(snap.phase).toBe('playing');
    expect(snap.turnPlayerId).toBe('p0');
    // 守恒：6 + 5 + 牌堆 151 = 162（换牌一进一出不改变张数）
    expect(totalCards(engine)).toBe(162);
  });

  it('找不到指定牌：重问当前张（提示前缀 + 进度不变）', () => {
    const seed = 3;
    const { engine } = mkDealEngine({ seed, devIds: ['p0'] });
    const deck = shuffle(buildDeck(3), mulberry32(seed));
    const p0Drawn = deck.slice(156);
    // 选一个前 11 张完全没摸到的点数牌（3 副本全在牌堆 → 可连续消费 3 次后耗尽）
    const drawnFaces = new Set(p0Drawn.concat(deck.slice(151, 156)).map((c) => `${c.suit}-${c.rank}`));
    const face = deck.find((c) => !isJoker(c) && !drawnFaces.has(`${c.suit}-${c.rank}`))!;
    const spec = { suit: face.suit, rank: face.rank };
    // 前 3 张全换成同一张 → 牌堆里 3 副本全部取走
    for (let i = 0; i < 3; i++) {
      const ask = engine.currentAsk('p0')!;
      expect(ask.cards![0]!.id).toBe(p0Drawn[i]!.id);
      expect(engine.resolveAsk('p0', { askId: ask.askId!, swapSpec: spec }).ok).toBe(true);
    }
    // 第 4 张：牌堆里已无该牌 → 重问同一张（进度仍 4/6）
    const ask4 = engine.currentAsk('p0')!;
    const r4 = engine.resolveAsk('p0', { askId: ask4.askId!, swapSpec: spec });
    expect(r4.ok).toBe(true);
    const reAsk = engine.currentAsk('p0')!;
    expect(reAsk.prompt).toContain('牌堆里已经没有这张牌了');
    expect(reAsk.cards![0]!.id).toBe(p0Drawn[3]!.id);
    expect(reAsk.swapIndex).toBe(3);
    // 保持这张 → 推进到下一张
    expect(engine.resolveAsk('p0', { askId: reAsk.askId!, choice: 'keep' }).ok).toBe(true);
    expect(engine.currentAsk('p0')!.cards![0]!.id).toBe(p0Drawn[4]!.id);
    // 剩余全部保持 → 开局
    expect(engine.resolveAsk('p0', { askId: engine.currentAsk('p0')!.askId!, choice: 'restKeep' }).ok).toBe(true);
    expect(engine.snapshotFor('p0').phase).toBe('playing');
    expect(totalCards(engine)).toBe(162);
  });

  it('开关默认关：发牌零打扰，无任何询问', () => {
    const { engine } = mkDealEngine({ seed: 5 });
    expect(engine.pendingAskPlayerId).toBeNull();
    expect(engine.snapshotFor('p0').phase).toBe('playing');
  });

  it('动作期：开关开启后轮末摸牌 → 换牌询问 → 换牌生效且游戏继续', () => {
    const deck3 = buildDeck(3);
    // 房主 [♠3,♠6] 先手出单 3；下家 [♥5] 无牌可压 → 过 → 轮末房主摸 1 继续出
    const hands = { p0: [deck3[0]!, deck3[3]!], p1: [deck3[15]!] };
    const { engine } = mkHandsEngine(hands, { devIds: ['p0'] });
    expect(engine.pendingAskPlayerId).toBeNull();
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    // 轮末摸牌挂起换牌询问（牌堆 = 整副去手牌未洗牌 → 尾张 = 第二副大王 id 161）
    expect(engine.pendingAskPlayerId).toBe('p0');
    const ask = engine.currentAsk('p0')!;
    expect(ask.kind).toBe('devSwap');
    expect(ask.swapTotal).toBe(1);
    expect(ask.cards![0]!.id).toBe(161);
    // 换 ♠4（过滤后牌堆首张 id 1）
    expect(engine.resolveAsk('p0', { askId: ask.askId!, swapSpec: { suit: 0, rank: 4 } }).ok).toBe(true);
    expect(engine.pendingAskPlayerId).toBeNull(); // 只有 1 张：换完即收尾
    const hand = handOf(engine, 'p0');
    expect(hand.some((c) => c.id === 1)).toBe(true);
    expect(hand.some((c) => c.id === 161)).toBe(false);
    // 游戏继续：房主持牌权重新起牌；守恒 2+1+158+1 = 162
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
    expect(totalCards(engine)).toBe(162);
  });

  it('动作期：换牌询问挂起时关闭开关 → 询问清除、后续摸牌零打扰', () => {
    const deck3 = buildDeck(3);
    // p0 留 3 张（♠3/♠6/♥8）：换牌后手牌 [♠6,♥8,大王] 非纯王，下一轮照常起牌
    const hands = { p0: [deck3[0]!, deck3[3]!, deck3[18]!], p1: [deck3[15]!] };
    const { engine } = mkHandsEngine(hands, { devIds: ['p0'] });
    engine.playCards('p0', [hands.p0[0]!.id]);
    engine.pass('p1');
    expect(engine.pendingAskPlayerId).toBe('p0');
    // 挂起中关闭开关：询问清除（未换牌，摸到的大王照常留在手里）
    engine.setDevDraw('p0', false);
    expect(engine.pendingAskPlayerId).toBeNull();
    expect(handOf(engine, 'p0').some((c) => c.id === 161)).toBe(true);
    // 后续轮末摸牌不再询问：出 ♠6 → 下家过 → 房主再摸 1（小王 id 160）→ 无挂起、牌权保持
    expect(engine.playCards('p0', [3]).ok).toBe(true);
    expect(engine.pass('p1').ok).toBe(true);
    expect(engine.pendingAskPlayerId).toBeNull();
    expect(handOf(engine, 'p0').some((c) => c.id === 160)).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p0');
  });

  it('技能摸牌（阿摩贪婪：出牌后摸 1）同样进入换牌询问', () => {
    const deck3 = buildDeck(3);
    const hands = { p0: [deck3[0]!, deck3[3]!], p1: [deck3[15]!] };
    const registry: RoleRegistry = new Map([
      ['amo', amo],
      ['plain', plain()],
    ]);
    const { engine } = mkHandsEngine(hands, { devIds: ['p0'], roles: registry, roleIds: { p0: 'amo', p1: 'plain' } });
    // 阿摩出牌 → 引擎自动摸 1（id 161）→ 换牌询问
    expect(engine.playCards('p0', [hands.p0[0]!.id]).ok).toBe(true);
    expect(engine.pendingAskPlayerId).toBe('p0');
    const ask = engine.currentAsk('p0')!;
    expect(ask.kind).toBe('devSwap');
    expect(ask.swapTotal).toBe(1);
    expect(ask.cards![0]!.id).toBe(161);
    expect(engine.resolveAsk('p0', { askId: ask.askId!, swapSpec: { suit: 0, rank: 4 } }).ok).toBe(true);
    expect(handOf(engine, 'p0').some((c) => c.id === 1)).toBe(true);
    expect(engine.snapshotFor('p0').turnPlayerId).toBe('p1');
  });
});
