// 牌型解析器：parseCombo / canBeat / listPlayable，全部纯函数，无游戏状态。
// 定稿规则要点：
// - 单/对 恰好大一级；2 无视 +1 压一切（仅炸弹可压 2）
// - 顺子/连对 同长度、起点严格更大，且起点必须落在上家牌型的点数窗口内
// - 炸弹 3 张起，张数多的大、同张数比点数；王可补张数
// - 王纯百搭：可补对子/顺子/连对/炸弹，不能单独出，纯王组合不合法（至少 1 张真牌）
// - 百搭顺子解析（确定性）：先补内部缺口 → 从最高真牌向上延伸（不超A）→ 向下延伸（不低于3）
import { RANK_2, RANK_3, RANK_A, isJoker, isRank, rankLabel, type Card, type Rank } from '../cards';
import type { RuleConfig } from '../config';

export type ComboType = 'single' | 'pair' | 'straight' | 'consecutivePairs' | 'bomb';

export interface Combo {
  type: ComboType;
  cards: Card[];
  /** 单/对/炸 = 点数；顺子/连对 = 起点 */
  rank: Rank;
  /** 张数 */
  length: number;
  /** 每张牌实际充当的点数（王显示其补的位置） */
  resolved: { cardId: number; rank: Rank }[];
  label: string;
}

export const comboKey = (c: Combo): string => `${c.type}:${c.rank}:${c.length}`;

// ---------- 内部工具 ----------

interface HandInfo {
  realByRank: Map<Rank, Card[]>;
  jokers: Card[];
  totalJokers: number;
}

function analyzeHand(hand: readonly Card[]): HandInfo {
  const realByRank = new Map<Rank, Card[]>();
  const jokers: Card[] = [];
  for (const c of [...hand].sort((a, b) => a.id - b.id)) {
    if (isJoker(c)) jokers.push(c);
    else if (isRank(c.rank)) {
      const arr = realByRank.get(c.rank) ?? [];
      arr.push(c);
      realByRank.set(c.rank, arr);
    }
  }
  return { realByRank, jokers, totalJokers: jokers.length };
}

function buildCombo(
  type: ComboType,
  cards: Card[],
  rank: Rank,
  resolved: { cardId: number; rank: Rank }[],
  label: string
): Combo {
  return { type, cards, rank, length: cards.length, resolved, label };
}

// ---------- parseCombo ----------

/**
 * 解析一组牌为牌型；不合法返回 null。
 * 全部真牌同点数 → 单/对/炸；多种点数 → 顺子/连对；其他非法。
 */
export function parseCombo(cards: readonly Card[], cfg: RuleConfig): Combo | null {
  if (cards.length === 0) return null;
  const sorted = [...cards].sort((a, b) => a.id - b.id);
  const info = analyzeHand(sorted);
  if (sorted.length - info.totalJokers < cfg.jokers.minRealCardsInCombo) return null; // 纯王组合非法

  if (info.realByRank.size === 1) {
    const [rank, rankCards] = [...info.realByRank][0]!;
    const n = sorted.length;
    if (n === 1 && info.totalJokers === 0) {
      return buildCombo('single', rankCards, rank, rankCards.map((c) => ({ cardId: c.id, rank })), rankLabel(rank));
    }
    if (n === 2 && info.totalJokers <= 1) {
      if (info.totalJokers === 1 && !cfg.jokers.completePair) return null;
      return buildCombo(
        'pair',
        sorted,
        rank,
        sorted.map((c) => ({ cardId: c.id, rank })),
        `对${rankLabel(rank)}`
      );
    }
    if (n >= cfg.bomb.minSize && n <= cfg.bomb.maxSize && info.totalJokers >= 0) {
      return buildCombo(
        'bomb',
        sorted,
        rank,
        sorted.map((c) => ({ cardId: c.id, rank })),
        `炸弹 ${n}×${rankLabel(rank)}`
      );
    }
    return null;
  }

  // 多种真牌点数 → 顺子 / 连对
  const straight = cfg.straight.exclude.some((r) => info.realByRank.has(r as Rank))
    ? null
    : tryStraight(sorted, info, cfg);
  if (straight) return straight;
  const cp = cfg.consecutivePairs.exclude.some((r) => info.realByRank.has(r as Rank))
    ? null
    : tryConsecutivePairs(sorted, info, cfg);
  return cp;
}

function tryStraight(sorted: Card[], info: HandInfo, cfg: RuleConfig): Combo | null {
  const n = sorted.length;
  if (n < cfg.straight.minLength || n > cfg.straight.maxLength) return null;
  // 顺子每个点数真牌至多 1 张
  for (const cs of info.realByRank.values()) if (cs.length > 1) return null;
  const ranks = [...info.realByRank.keys()].sort((a, b) => a - b);
  const minR = ranks[0]!;
  const maxR = ranks[ranks.length - 1]!;
  const missing = maxR - minR + 1 - ranks.length; // 内部缺口（必须补）
  if (missing > info.totalJokers) return null;
  let leftover = info.totalJokers - missing;
  let start = minR;
  let end = maxR;
  // 向上延伸（不超 A）
  while (leftover > 0 && end < RANK_A) {
    end++;
    leftover--;
  }
  // 向下延伸（不低于 3）
  while (leftover > 0 && start > RANK_3) {
    start--;
    leftover--;
  }
  if (leftover > 0) return null;
  if (end - start + 1 !== n) return null;

  const windowRanks: Rank[] = [];
  for (let r = start; r <= end; r++) windowRanks.push(r as Rank);
  const cards: Card[] = [];
  const resolved: { cardId: number; rank: Rank }[] = [];
  let ji = 0;
  for (const r of windowRanks) {
    const real = info.realByRank.get(r);
    if (real && real.length > 0) {
      cards.push(real[0]!);
      resolved.push({ cardId: real[0]!.id, rank: r });
    } else {
      const j = info.jokers[ji++]!;
      cards.push(j);
      resolved.push({ cardId: j.id, rank: r });
    }
  }
  return buildCombo('straight', cards, start, resolved, `顺子 ${windowRanks.map(rankLabel).join('-')}`);
}

function tryConsecutivePairs(sorted: Card[], info: HandInfo, cfg: RuleConfig): Combo | null {
  const n = sorted.length;
  if (n % 2 !== 0) return null;
  const pairs = n / 2;
  if (pairs < cfg.consecutivePairs.minPairs || pairs > cfg.consecutivePairs.maxPairs) return null;
  // 每个点数真牌至多 2 张
  const counts = new Map<Rank, number>();
  for (const [r, cs] of info.realByRank) {
    if (cs.length > 2) return null;
    counts.set(r, cs.length);
  }
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  const minR = ranks[0]!;
  const maxR = ranks[ranks.length - 1]!;
  let jokersNeeded = 0;
  for (let r = minR; r <= maxR; r++) jokersNeeded += Math.max(0, 2 - (counts.get(r as Rank) ?? 0));
  if (jokersNeeded > info.totalJokers) return null;
  let remaining = info.totalJokers - jokersNeeded;
  let start = minR;
  let end = maxR;
  while (remaining >= 2 && end < RANK_A) {
    end++;
    remaining -= 2;
  }
  while (remaining >= 2 && start > RANK_3) {
    start--;
    remaining -= 2;
  }
  if (remaining !== 0) return null;
  if (end - start + 1 !== pairs) return null;

  const cards: Card[] = [];
  const resolved: { cardId: number; rank: Rank }[] = [];
  let ji = 0;
  for (let r = start; r <= end; r++) {
    const rank = r as Rank;
    const have = counts.get(rank) ?? 0;
    for (const c of info.realByRank.get(rank) ?? []) {
      cards.push(c);
      resolved.push({ cardId: c.id, rank });
    }
    for (let k = 0; k < 2 - have; k++) {
      const j = info.jokers[ji++]!;
      cards.push(j);
      resolved.push({ cardId: j.id, rank });
    }
  }
  const windowRanks: Rank[] = [];
  for (let r = start; r <= end; r++) windowRanks.push(r as Rank);
  return buildCombo(
    'consecutivePairs',
    cards,
    start,
    resolved,
    `连对 ${windowRanks.map((r) => `${rankLabel(r)}${rankLabel(r)}`).join('')}`
  );
}

// ---------- canBeat ----------

/** combo 能否压过 table 上的牌（table 为 null 表示起牌，恒真） */
export function canBeat(combo: Combo, table: Combo | null, cfg: RuleConfig): boolean {
  if (table === null) return true;
  if (combo.type === 'bomb') {
    if (table.type !== 'bomb') return true; // 炸弹炸一切
    if (combo.length !== table.length) return combo.length > table.length; // 张数优先
    return combo.rank > table.rank; // 同张数比点数
  }
  if (table.type === 'bomb') return false; // 非炸压不了炸
  if (combo.type !== table.type) return false;

  if (combo.type === 'single' || combo.type === 'pair') {
    if (combo.rank === RANK_2) return table.rank !== RANK_2 && cfg.follow.singlePair.twoBeatsAll;
    if (table.rank === RANK_2) return false;
    if (cfg.follow.singlePair.strictPlusOne) return combo.rank === table.rank + 1;
    return combo.rank > table.rank;
  }
  // 顺子 / 连对：同长度、起点严格更大，且起点落在上家点数窗口内
  if (combo.length !== table.length) return false;
  if (combo.rank <= table.rank) return false;
  if (cfg.follow.longCombo.startWithinPrevWindow) {
    const span = combo.type === 'straight' ? table.length : table.length / 2;
    if (combo.rank > table.rank + span - 1) return false;
  }
  return true;
}

// ---------- listPlayable ----------

/** 枚举手牌当前可出的所有组合（候选间互斥，王可被重复计入不同候选） */
export function listPlayable(hand: readonly Card[], table: Combo | null, cfg: RuleConfig): Combo[] {
  const info = analyzeHand(hand);
  return table === null ? listLeading(info, cfg) : listFollowing(info, table, cfg);
}

function singleOf(c: Card): Combo {
  const r = c.rank as Rank;
  return buildCombo('single', [c], r, [{ cardId: c.id, rank: r }], rankLabel(r));
}

function pairOf(cards: Card[], rank: Rank): Combo {
  return buildCombo('pair', cards, rank, cards.map((c) => ({ cardId: c.id, rank })), `对${rankLabel(rank)}`);
}

function bombOf(realCards: Card[], jokers: Card[], rank: Rank, len: number): Combo {
  const cards = [...realCards.slice(0, Math.min(realCards.length, len)), ...jokers.slice(0, Math.max(0, len - realCards.length))];
  return buildCombo('bomb', cards, rank, cards.map((c) => ({ cardId: c.id, rank })), `炸弹 ${len}×${rankLabel(rank)}`);
}

function straightOf(s: number, len: number, info: HandInfo): Combo {
  const windowRanks: Rank[] = [];
  for (let r = s; r < s + len; r++) windowRanks.push(r as Rank);
  const cards: Card[] = [];
  const resolved: { cardId: number; rank: Rank }[] = [];
  let ji = 0;
  for (const r of windowRanks) {
    const real = info.realByRank.get(r);
    if (real && real.length > 0) {
      cards.push(real[0]!);
      resolved.push({ cardId: real[0]!.id, rank: r });
    } else {
      const j = info.jokers[ji++]!;
      cards.push(j);
      resolved.push({ cardId: j.id, rank: r });
    }
  }
  return buildCombo('straight', cards, windowRanks[0]!, resolved, `顺子 ${windowRanks.map(rankLabel).join('-')}`);
}

function windowExcluded(s: number, len: number, exclude: number[]): boolean {
  for (let r = s; r < s + len; r++) if (exclude.includes(r)) return true;
  return false;
}

function straightMissing(s: number, len: number, info: HandInfo): number {
  let missing = 0;
  for (let r = s; r < s + len; r++) {
    const cs = info.realByRank.get(r as Rank);
    if (!cs || cs.length === 0) missing++;
  }
  return missing;
}

function consecutivePairsOf(s: number, pairs: number, info: HandInfo): Combo {
  const windowRanks: Rank[] = [];
  for (let r = s; r < s + pairs; r++) windowRanks.push(r as Rank);
  const cards: Card[] = [];
  const resolved: { cardId: number; rank: Rank }[] = [];
  let ji = 0;
  for (const r of windowRanks) {
    const have = info.realByRank.get(r) ?? [];
    for (const c of have) {
      cards.push(c);
      resolved.push({ cardId: c.id, rank: r });
    }
    for (let k = 0; k < 2 - have.length; k++) {
      const j = info.jokers[ji++]!;
      cards.push(j);
      resolved.push({ cardId: j.id, rank: r });
    }
  }
  return buildCombo(
    'consecutivePairs',
    cards,
    windowRanks[0]!,
    resolved,
    `连对 ${windowRanks.map((r) => `${rankLabel(r)}${rankLabel(r)}`).join('')}`
  );
}

function cpMissing(s: number, pairs: number, info: HandInfo): number {
  let missing = 0;
  for (let r = s; r < s + pairs; r++) missing += Math.max(0, 2 - (info.realByRank.get(r as Rank)?.length ?? 0));
  return missing;
}

/** 枚举出的候选必须能被解析器回验为同一规范形（王牌歧义下与解析器保持一致） */
function verified(combo: Combo, cfg: RuleConfig): Combo | null {
  const re = parseCombo(combo.cards, cfg);
  if (re === null || comboKey(re) !== comboKey(combo)) return null;
  return combo;
}

function listLeading(info: HandInfo, cfg: RuleConfig): Combo[] {
  const out: Combo[] = [];
  const ranks = [...info.realByRank.keys()].sort((a, b) => a - b);

  // 单张
  for (const r of ranks) out.push(singleOf(info.realByRank.get(r)![0]!));
  // 对子
  for (const r of ranks) {
    const cs = info.realByRank.get(r)!;
    if (cs.length >= 2) out.push(pairOf(cs.slice(0, 2), r));
    else if (cs.length === 1 && info.totalJokers >= 1 && cfg.jokers.completePair)
      out.push(pairOf([cs[0]!, info.jokers[0]!], r));
  }
  // 炸弹（3 张起）
  for (const r of ranks) {
    const c = info.realByRank.get(r)!.length;
    const maxLen = Math.min(c + info.totalJokers, cfg.bomb.maxSize);
    for (let len = cfg.bomb.minSize; len <= maxLen; len++) {
      out.push(bombOf(info.realByRank.get(r)!, info.jokers, r, len));
    }
  }
  // 顺子
  for (let len = cfg.straight.minLength; len <= cfg.straight.maxLength; len++) {
    for (let s = RANK_3; s + len - 1 <= RANK_A; s++) {
      if (windowExcluded(s, len, cfg.straight.exclude)) continue;
      if (straightMissing(s, len, info) <= info.totalJokers) out.push(straightOf(s, len, info));
    }
  }
  // 连对
  for (let p = cfg.consecutivePairs.minPairs; p <= cfg.consecutivePairs.maxPairs; p++) {
    for (let s = RANK_3; s + p - 1 <= RANK_A; s++) {
      if (windowExcluded(s, p, cfg.consecutivePairs.exclude)) continue;
      if (cpMissing(s, p, info) <= info.totalJokers) out.push(consecutivePairsOf(s, p, info));
    }
  }
  return out.filter((c) => verified(c, cfg) !== null);
}

function listFollowing(info: HandInfo, table: Combo, cfg: RuleConfig): Combo[] {
  const out: Combo[] = [];
  const ranks = [...info.realByRank.keys()].sort((a, b) => a - b);

  if (table.type === 'bomb') {
    for (const r of ranks) {
      const cs = info.realByRank.get(r)!;
      const maxLen = Math.min(cs.length + info.totalJokers, cfg.bomb.maxSize);
      // 更长：任何点数都能压
      for (let len = table.length + 1; len <= maxLen; len++) out.push(bombOf(cs, info.jokers, r, len));
      // 同长：点数更高
      if (r > table.rank && table.length >= cfg.bomb.minSize && table.length <= maxLen)
        out.push(bombOf(cs, info.jokers, r, table.length));
    }
    return out.filter((c) => verified(c, cfg) !== null);
  }

  if (table.type === 'single') {
    const plusOne = (table.rank + 1) as Rank;
    if (plusOne <= RANK_A && info.realByRank.has(plusOne)) out.push(singleOf(info.realByRank.get(plusOne)![0]!));
    if (table.rank !== RANK_2 && cfg.follow.singlePair.twoBeatsAll && info.realByRank.has(RANK_2))
      out.push(singleOf(info.realByRank.get(RANK_2)![0]!));
    return out.filter((c) => verified(c, cfg) !== null);
  }

  if (table.type === 'pair') {
    const plusOne = (table.rank + 1) as Rank;
    if (plusOne <= RANK_A) {
      const cs = info.realByRank.get(plusOne);
      if (cs && cs.length >= 2) out.push(pairOf(cs.slice(0, 2), plusOne));
      else if (cs && cs.length === 1 && info.totalJokers >= 1 && cfg.jokers.completePair)
        out.push(pairOf([cs[0]!, info.jokers[0]!], plusOne));
    }
    if (table.rank !== RANK_2 && cfg.follow.singlePair.twoBeatsAll) {
      const twos = info.realByRank.get(RANK_2);
      if (twos && twos.length >= 2) out.push(pairOf(twos.slice(0, 2), RANK_2));
      else if (twos && twos.length === 1 && info.totalJokers >= 1 && cfg.jokers.completePair)
        out.push(pairOf([twos[0]!, info.jokers[0]!], RANK_2));
    }
    return out.filter((c) => verified(c, cfg) !== null);
  }

  if (table.type === 'straight') {
    const len = table.length;
    const windowEnd = table.rank + len - 1; // 起点必须落在上家窗口内
    const maxStart = Math.min(windowEnd, RANK_A - len + 1);
    for (let s = table.rank + 1; s <= maxStart; s++) {
      if (windowExcluded(s, len, cfg.straight.exclude)) continue;
      if (straightMissing(s, len, info) <= info.totalJokers) out.push(straightOf(s, len, info));
    }
    return out.filter((c) => verified(c, cfg) !== null);
  }

  // consecutivePairs
  const pairs = table.length / 2;
  const windowEnd = table.rank + pairs - 1;
  const maxStart = Math.min(windowEnd, RANK_A - pairs + 1);
  for (let s = table.rank + 1; s <= maxStart; s++) {
    if (windowExcluded(s, pairs, cfg.consecutivePairs.exclude)) continue;
    if (cpMissing(s, pairs, info) <= info.totalJokers) out.push(consecutivePairsOf(s, pairs, info));
  }
  return out.filter((c) => verified(c, cfg) !== null);
}
