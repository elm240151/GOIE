// 牌型解析器：parseCombo / canBeat / listPlayable，全部纯函数，无游戏状态。
// 定稿规则要点：
// - 单/对 恰好大一级；2 无视 +1 压一切（仅炸弹可压 2）
// - 顺子/连对 同长度、起点严格更大，且起点必须落在上家牌型的点数窗口内
// - 炸弹 3 张起，张数多的大、同张数比点数；王可补张数
// - 王纯百搭：可补对子/顺子/连对/炸弹，不能单独出，纯王组合不合法（至少 1 张真牌）
// - 诅咒（橐驼，allowSoloJoker）：单王可单独打出（压一切单张）、对王 = 双王同时打出（压一切对子），
//   都只有炸弹能压、王压不了王，正倒序一致
// - 百搭顺子解析（确定性）：先补内部缺口 → 从最高真牌向上延伸（不超A）→ 向下延伸（不低于3）
// - 倒序（海棠洄游，rev=true）：整条牌序反转——恰好小一级可压；3 最大压一切（3 压不了 3、对 3 只有炸压）；
//   2 最小谁也压不了（倒序用 A 响应 2）；顺子/连对为倒序连续（起点 = 最高点数，接牌窗口规则镜像，
//   百搭延伸镜像：先向 3 再向 A）；炸弹张数优先不变、同张数比点反转（3 炸最强/2 炸最弱）
// - 留 X 禁止收尾：正序单 2/对 2、倒序单 3/对 3（含王补），打出后手牌清空 → 不可出（listPlayable 直接排除）
// - 翻面接（轴承端庄，type 'gap'）：剩余非法牌型被后继接出的桌面（如 345 翻 4 → 接 46）——不是可解析的牌型，
//   只能由引擎经 validateFlipResponse 构造；只有炸弹能压（特殊技能例外），枚举（listPlayable）只给炸弹
import { RANK_2, RANK_3, RANK_A, isJoker, isRank, rankLabel, type Card, type Rank } from '../cards';
import type { RuleConfig } from '../config';

export type ComboType = 'single' | 'pair' | 'straight' | 'consecutivePairs' | 'bomb' | 'singleJoker' | 'jokerPair' | 'gap';

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
 * rev = 倒序（海棠洄游）：顺子/连对按倒序连续解析（起点 = 最高点数）。
 * allowSoloJoker = 单王可单独打出（橐驼诅咒：点数视作无穷大/无穷小，压一切单张、只有炸弹能压）。
 */
export function parseCombo(
  cards: readonly Card[],
  cfg: RuleConfig,
  rev = false,
  allowSoloJoker = false
): Combo | null {
  if (cards.length === 0) return null;
  const sorted = [...cards].sort((a, b) => a.id - b.id);
  const info = analyzeHand(sorted);
  if (sorted.length - info.totalJokers < cfg.jokers.minRealCardsInCombo) {
    if (allowSoloJoker && sorted.length === 1 && info.totalJokers === 1) return soloJokerOf(sorted[0]!);
    if (allowSoloJoker && sorted.length === 2 && info.totalJokers === 2) return jokerPairOf(sorted);
    return null; // 纯王组合非法
  }

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
    : tryStraight(sorted, info, cfg, rev);
  if (straight) return straight;
  const cp = cfg.consecutivePairs.exclude.some((r) => info.realByRank.has(r as Rank))
    ? null
    : tryConsecutivePairs(sorted, info, cfg, rev);
  return cp;
}

function tryStraight(sorted: Card[], info: HandInfo, cfg: RuleConfig, rev: boolean): Combo | null {
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
  if (rev) {
    // 倒序镜像：先向 3 延伸（倒序的顶端），再向 A 延伸
    while (leftover > 0 && start > RANK_3) {
      start--;
      leftover--;
    }
    while (leftover > 0 && end < RANK_A) {
      end++;
      leftover--;
    }
  } else {
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
  }
  if (leftover > 0) return null;
  if (end - start + 1 !== n) return null;

  const windowRanks: Rank[] = [];
  for (let r = start; r <= end; r++) windowRanks.push(r as Rank);
  const display = rev ? [...windowRanks].reverse() : windowRanks;
  const cards: Card[] = [];
  const resolved: { cardId: number; rank: Rank }[] = [];
  let ji = 0;
  for (const r of display) {
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
  // 起点：正序 = 最低点数；倒序 = 最高点数
  return buildCombo('straight', cards, (rev ? end : start) as Rank, resolved, `顺子 ${display.map(rankLabel).join('-')}`);
}

function tryConsecutivePairs(sorted: Card[], info: HandInfo, cfg: RuleConfig, rev: boolean): Combo | null {
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
  if (rev) {
    // 倒序镜像：先向 3 延伸（倒序的顶端），再向 A 延伸
    while (remaining >= 2 && start > RANK_3) {
      start--;
      remaining -= 2;
    }
    while (remaining >= 2 && end < RANK_A) {
      end++;
      remaining -= 2;
    }
  } else {
    while (remaining >= 2 && end < RANK_A) {
      end++;
      remaining -= 2;
    }
    while (remaining >= 2 && start > RANK_3) {
      start--;
      remaining -= 2;
    }
  }
  if (remaining !== 0) return null;
  if (end - start + 1 !== pairs) return null;

  const windowRanks: Rank[] = [];
  for (let r = start; r <= end; r++) windowRanks.push(r as Rank);
  const display = rev ? [...windowRanks].reverse() : windowRanks;
  const cards: Card[] = [];
  const resolved: { cardId: number; rank: Rank }[] = [];
  let ji = 0;
  for (const rank of display) {
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
  // 起点：正序 = 最低点数；倒序 = 最高点数
  return buildCombo(
    'consecutivePairs',
    cards,
    (rev ? end : start) as Rank,
    resolved,
    `连对 ${display.map((r) => `${rankLabel(r)}${rankLabel(r)}`).join('')}`
  );
}

// ---------- canBeat ----------

/**
 * combo 能否压过 table 上的牌（table 为 null 表示起牌，恒真）。
 * rev = 倒序：整条牌序反转——恰好小一级可压；3 最大压一切（3 压不了 3、对 3 只有炸压）；
 * 2 最小谁也压不了（A 响应 2）；顺子/连对起点 = 最高点数；炸弹同张数比点反转（3 炸最强）。
 */
export function canBeat(combo: Combo, table: Combo | null, cfg: RuleConfig, rev = false): boolean {
  if (table === null) return true;
  // 翻面接（轴承端庄）接出的非法牌型桌面：只有炸弹能压（其余响应经技能豁免，如斜视的 allowAnyway 不作用于 gap）
  if (table.type === 'gap') return combo.type === 'bomb';
  if (combo.type === 'gap') return false; // gap 组合只作为桌面出现（防御）
  // 单王（橐驼诅咒）：压一切单张（含当前最大 2/3），只有炸弹能压——正倒序一致（无穷大/无穷小镜像同规则）
  if (table.type === 'singleJoker') return combo.type === 'bomb';
  if (combo.type === 'singleJoker') return table.type === 'single';
  // 对王（橐驼诅咒）：压一切对子（正序含对 2、倒序含对 3），只有炸弹能压、王压不了王——正倒序一致
  if (table.type === 'jokerPair') return combo.type === 'bomb';
  if (combo.type === 'jokerPair') return table.type === 'pair';
  if (combo.type === 'bomb') {
    if (table.type !== 'bomb') return true; // 炸弹炸一切
    if (combo.length !== table.length) return combo.length > table.length; // 张数优先
    return rev ? combo.rank < table.rank : combo.rank > table.rank; // 同张数比点（倒序反转）
  }
  if (table.type === 'bomb') return false; // 非炸压不了炸
  if (combo.type !== table.type) return false;

  if (combo.type === 'single' || combo.type === 'pair') {
    if (rev) {
      // 倒序镜像：3 无视 −1 压一切（3 压不了 3、对 3 只有炸压）；2 最小谁也压不了（A 响应 2）
      if (combo.rank === RANK_3) return table.rank !== RANK_3 && cfg.follow.singlePair.twoBeatsAll;
      if (table.rank === RANK_3) return false;
      if (cfg.follow.singlePair.strictPlusOne) return combo.rank === table.rank - 1;
      return combo.rank < table.rank;
    }
    if (combo.rank === RANK_2) return table.rank !== RANK_2 && cfg.follow.singlePair.twoBeatsAll;
    if (table.rank === RANK_2) return false;
    if (cfg.follow.singlePair.strictPlusOne) return combo.rank === table.rank + 1;
    return combo.rank > table.rank;
  }
  // 顺子 / 连对：同长度、起点严格更大（倒序 = 最高点），且起点落在上家点数窗口内（规则镜像同公式）
  if (combo.length !== table.length) return false;
  if (combo.rank <= table.rank) return false;
  if (cfg.follow.longCombo.startWithinPrevWindow) {
    const span = combo.type === 'straight' ? table.length : table.length / 2;
    if (combo.rank > table.rank + span - 1) return false;
  }
  return true;
}

/**
 * 重建 combo 的 label 与 rank 为指定点数（修勾答疑改点：牌型不变、判定点数改写，
 * 实体牌不变）。顺子/连对改的是起点（按当前牌序约定：正序 = 最低点、倒序 = 最高点），
 * 展示窗口恒为升序（与 parseCombo 的 label 格式一致）。
 */
export function relabelCombo(combo: Combo, rank: Rank, rev: boolean): Combo {
  if (combo.type === 'singleJoker') return combo; // 答疑只对 ≥2 张牌型，单王不会走到这里（防御）
  if (combo.type === 'jokerPair') return combo; // 对王同理：王无点数可改，答疑不会对其发动（防御）
  if (combo.type === 'gap') return combo; // 翻面接：多点数牌型无单一判定点数可改，答疑不会对其发动（防御）
  if (combo.type === 'single') return { ...combo, rank, label: rankLabel(rank) };
  if (combo.type === 'pair') return { ...combo, rank, label: `对${rankLabel(rank)}` };
  if (combo.type === 'bomb') return { ...combo, rank, label: `炸弹 ${combo.length}×${rankLabel(rank)}` };
  const span = combo.type === 'straight' ? combo.length : combo.length / 2;
  const start = rev ? rank - span + 1 : rank; // 倒序 rank = 最高点，窗口起点 = 最高点 − 长度 + 1
  const windowRanks = Array.from({ length: span }, (_, i) => (start + i) as Rank);
  const label =
    combo.type === 'straight'
      ? `顺子 ${windowRanks.map(rankLabel).join('-')}`
      : `连对 ${windowRanks.map((r) => `${rankLabel(r)}${rankLabel(r)}`).join('')}`;
  return { ...combo, rank, label };
}

// ---------- listPlayable ----------

/**
 * 枚举手牌当前可出的所有组合（候选间互斥，王可被重复计入不同候选）。
 * rev = 倒序；留 X 禁止收尾：打出后手牌清空的单/对（正序 2 / 倒序 3）直接排除。
 * allowSoloJoker = 单王单独打出候选（橐驼诅咒）。
 */
export function listPlayable(
  hand: readonly Card[],
  table: Combo | null,
  cfg: RuleConfig,
  rev = false,
  allowSoloJoker = false
): Combo[] {
  const info = analyzeHand(hand);
  const out = table === null ? listLeading(info, cfg, rev, allowSoloJoker) : listFollowing(info, table, cfg, rev, allowSoloJoker);
  const finishRank = rev ? RANK_3 : RANK_2;
  return out.filter(
    (c) =>
      !(c.cards.length === hand.length && (c.type === 'single' || c.type === 'pair') && c.rank === finishRank)
  );
}

function singleOf(c: Card): Combo {
  const r = c.rank as Rank;
  return buildCombo('single', [c], r, [{ cardId: c.id, rank: r }], rankLabel(r));
}

/** 单王（橐驼诅咒）：rank 编码 16（高于 2），正倒序都压一切单张、只有炸弹能压 */
function soloJokerOf(c: Card): Combo {
  return buildCombo('singleJoker', [c], 16 as Rank, [{ cardId: c.id, rank: 16 as Rank }], '王');
}

/** 对王（橐驼诅咒）：rank 编码 16，压一切对子（正序含对 2、倒序含对 3），只有炸弹能压 */
function jokerPairOf(cards: Card[]): Combo {
  return buildCombo('jokerPair', cards, 16 as Rank, cards.map((c) => ({ cardId: c.id, rank: 16 as Rank })), '对王');
}

function pairOf(cards: Card[], rank: Rank): Combo {
  return buildCombo('pair', cards, rank, cards.map((c) => ({ cardId: c.id, rank })), `对${rankLabel(rank)}`);
}

function bombOf(realCards: Card[], jokers: Card[], rank: Rank, len: number): Combo {
  const cards = [...realCards.slice(0, Math.min(realCards.length, len)), ...jokers.slice(0, Math.max(0, len - realCards.length))];
  return buildCombo('bomb', cards, rank, cards.map((c) => ({ cardId: c.id, rank })), `炸弹 ${len}×${rankLabel(rank)}`);
}

/** 窗口点数（展示序）：正序 [s..s+len-1] 升序；倒序 [s..s-len+1] 降序（s = 最高点） */
function windowRanksOf(s: number, len: number, rev: boolean): Rank[] {
  const out: Rank[] = [];
  for (let i = 0; i < len; i++) out.push((rev ? s - i : s + i) as Rank);
  return out;
}

function straightOf(s: number, len: number, info: HandInfo, rev: boolean): Combo {
  const windowRanks = windowRanksOf(s, len, rev);
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
  return buildCombo('straight', cards, s as Rank, resolved, `顺子 ${windowRanks.map(rankLabel).join('-')}`);
}

function windowExcluded(s: number, len: number, exclude: number[], rev: boolean): boolean {
  for (const r of windowRanksOf(s, len, rev)) if (exclude.includes(r)) return true;
  return false;
}

function straightMissing(s: number, len: number, info: HandInfo, rev: boolean): number {
  let missing = 0;
  for (const r of windowRanksOf(s, len, rev)) {
    const cs = info.realByRank.get(r);
    if (!cs || cs.length === 0) missing++;
  }
  return missing;
}

function consecutivePairsOf(s: number, pairs: number, info: HandInfo, rev: boolean): Combo {
  const windowRanks = windowRanksOf(s, pairs, rev);
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
    s as Rank,
    resolved,
    `连对 ${windowRanks.map((r) => `${rankLabel(r)}${rankLabel(r)}`).join('')}`
  );
}

function cpMissing(s: number, pairs: number, info: HandInfo, rev: boolean): number {
  let missing = 0;
  for (const r of windowRanksOf(s, pairs, rev)) missing += Math.max(0, 2 - (info.realByRank.get(r)?.length ?? 0));
  return missing;
}

/** 枚举出的候选必须能被解析器回验为同一规范形（王牌歧义下与解析器保持一致） */
function verified(combo: Combo, cfg: RuleConfig, rev: boolean, allowSoloJoker: boolean): Combo | null {
  const re = parseCombo(combo.cards, cfg, rev, allowSoloJoker);
  if (re === null || comboKey(re) !== comboKey(combo)) return null;
  return combo;
}

function listLeading(info: HandInfo, cfg: RuleConfig, rev: boolean, allowSoloJoker: boolean): Combo[] {
  const out: Combo[] = [];
  const ranks = [...info.realByRank.keys()].sort((a, b) => a - b);

  // 单张
  for (const r of ranks) out.push(singleOf(info.realByRank.get(r)![0]!));
  // 单王（诅咒：每张王都可单独起牌）
  if (allowSoloJoker) for (const j of info.jokers) out.push(soloJokerOf(j));
  // 对王（诅咒：双王可同时打出，压一切对子）
  if (allowSoloJoker && info.jokers.length >= 2) out.push(jokerPairOf(info.jokers.slice(0, 2)));
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
  // 顺子（倒序：s = 最高点，窗口 [s−len+1 .. s] 不越界且不含 2）
  for (let len = cfg.straight.minLength; len <= cfg.straight.maxLength; len++) {
    const lo = rev ? RANK_3 + len - 1 : RANK_3;
    const hi = rev ? RANK_A : RANK_A - len + 1;
    for (let s = lo; s <= hi; s++) {
      if (windowExcluded(s, len, cfg.straight.exclude, rev)) continue;
      if (straightMissing(s, len, info, rev) <= info.totalJokers) out.push(straightOf(s, len, info, rev));
    }
  }
  // 连对（倒序：s = 最高点）
  for (let p = cfg.consecutivePairs.minPairs; p <= cfg.consecutivePairs.maxPairs; p++) {
    const lo = rev ? RANK_3 + p - 1 : RANK_3;
    const hi = rev ? RANK_A : RANK_A - p + 1;
    for (let s = lo; s <= hi; s++) {
      if (windowExcluded(s, p, cfg.consecutivePairs.exclude, rev)) continue;
      if (cpMissing(s, p, info, rev) <= info.totalJokers) out.push(consecutivePairsOf(s, p, info, rev));
    }
  }
  return out.filter((c) => verified(c, cfg, rev, allowSoloJoker) !== null);
}

function listFollowing(
  info: HandInfo,
  table: Combo,
  cfg: RuleConfig,
  rev: boolean,
  allowSoloJoker: boolean
): Combo[] {
  const out: Combo[] = [];
  const ranks = [...info.realByRank.keys()].sort((a, b) => a - b);
  // 单王（诅咒）：压一切单张（含 2/3），正倒序一致
  if (allowSoloJoker && table.type === 'single') for (const j of info.jokers) out.push(soloJokerOf(j));
  // 对王（诅咒）：压一切对子（含对 2/对 3），正倒序一致
  if (allowSoloJoker && table.type === 'pair' && info.jokers.length >= 2) out.push(jokerPairOf(info.jokers.slice(0, 2)));

  if (table.type === 'singleJoker' || table.type === 'jokerPair' || table.type === 'gap') {
    // 只有炸弹能压王/对王（诅咒）与翻面接（端庄）：任意炸弹均可（无 length/rank 可比，不走炸弹比较分支）
    for (const r of ranks) {
      const cs = info.realByRank.get(r)!;
      const maxLen = Math.min(cs.length + info.totalJokers, cfg.bomb.maxSize);
      for (let len = cfg.bomb.minSize; len <= maxLen; len++) out.push(bombOf(cs, info.jokers, r, len));
    }
    return out.filter((c) => verified(c, cfg, rev, allowSoloJoker) !== null);
  }

  if (table.type === 'bomb') {
    for (const r of ranks) {
      const cs = info.realByRank.get(r)!;
      const maxLen = Math.min(cs.length + info.totalJokers, cfg.bomb.maxSize);
      // 更长：任何点数都能压
      for (let len = table.length + 1; len <= maxLen; len++) out.push(bombOf(cs, info.jokers, r, len));
      // 同长：点数更高（倒序比点反转）
      const higher = rev ? r < table.rank : r > table.rank;
      if (higher && table.length >= cfg.bomb.minSize && table.length <= maxLen)
        out.push(bombOf(cs, info.jokers, r, table.length));
    }
    return out.filter((c) => verified(c, cfg, rev, allowSoloJoker) !== null);
  }

  if (table.type === 'single') {
    if (rev) {
      const minusOne = (table.rank - 1) as Rank;
      if (minusOne >= RANK_3 && info.realByRank.has(minusOne)) out.push(singleOf(info.realByRank.get(minusOne)![0]!));
      if (table.rank !== RANK_3 && cfg.follow.singlePair.twoBeatsAll && info.realByRank.has(RANK_3))
        out.push(singleOf(info.realByRank.get(RANK_3)![0]!));
    } else {
      const plusOne = (table.rank + 1) as Rank;
      if (plusOne <= RANK_A && info.realByRank.has(plusOne)) out.push(singleOf(info.realByRank.get(plusOne)![0]!));
      if (table.rank !== RANK_2 && cfg.follow.singlePair.twoBeatsAll && info.realByRank.has(RANK_2))
        out.push(singleOf(info.realByRank.get(RANK_2)![0]!));
    }
    return out.filter((c) => verified(c, cfg, rev, allowSoloJoker) !== null);
  }

  if (table.type === 'pair') {
    if (rev) {
      const minusOne = (table.rank - 1) as Rank;
      if (minusOne >= RANK_3) {
        const cs = info.realByRank.get(minusOne);
        if (cs && cs.length >= 2) out.push(pairOf(cs.slice(0, 2), minusOne));
        else if (cs && cs.length === 1 && info.totalJokers >= 1 && cfg.jokers.completePair)
          out.push(pairOf([cs[0]!, info.jokers[0]!], minusOne));
      }
      if (table.rank !== RANK_3 && cfg.follow.singlePair.twoBeatsAll) {
        const threes = info.realByRank.get(RANK_3);
        if (threes && threes.length >= 2) out.push(pairOf(threes.slice(0, 2), RANK_3));
        else if (threes && threes.length === 1 && info.totalJokers >= 1 && cfg.jokers.completePair)
          out.push(pairOf([threes[0]!, info.jokers[0]!], RANK_3));
      }
    } else {
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
    }
    return out.filter((c) => verified(c, cfg, rev, allowSoloJoker) !== null);
  }

  if (table.type === 'straight') {
    const len = table.length;
    // 起点必须落在上家窗口内（正序 = 最低点、倒序 = 最高点，公式相同）
    const windowEnd = table.rank + len - 1;
    const maxStart = Math.min(windowEnd, rev ? RANK_A : RANK_A - len + 1);
    for (let s = table.rank + 1; s <= maxStart; s++) {
      if (windowExcluded(s, len, cfg.straight.exclude, rev)) continue;
      if (straightMissing(s, len, info, rev) <= info.totalJokers) out.push(straightOf(s, len, info, rev));
    }
    return out.filter((c) => verified(c, cfg, rev, allowSoloJoker) !== null);
  }

  // consecutivePairs
  const pairs = table.length / 2;
  const windowEnd = table.rank + pairs - 1;
  const maxStart = Math.min(windowEnd, rev ? RANK_A : RANK_A - pairs + 1);
  for (let s = table.rank + 1; s <= maxStart; s++) {
    if (windowExcluded(s, pairs, cfg.consecutivePairs.exclude, rev)) continue;
    if (cpMissing(s, pairs, info, rev) <= info.totalJokers) out.push(consecutivePairsOf(s, pairs, info, rev));
  }
  return out.filter((c) => verified(c, cfg, rev, allowSoloJoker) !== null);
}

// ---------- 端庄（轴承）：翻面接牌 ----------

export type FlipResponse =
  | { ok: true; combo: Combo; pressedKind: 'top' | 'prev' }
  | { ok: false; reason: string };

/**
 * 端庄翻面接牌校验（轴承；纯函数，服务端判定与客户端预览共用）。
 * - 桌面只有一张牌（情况一）：翻掉整手 → 接上一手的牌（按正常管牌规则；前面只有这一手则无法发动）。
 * - 桌面多张（情况二）：翻掉其中一张，剩余牌仍是合法牌型 → 按正常管牌规则接；剩余非法 →
 *   打后继（每张剩余牌按原牌型中所当点数 ±1：正序 +1、倒序 −1——倒序镜像，与「恰好小一级」等
 *   倒序规则同源（2026-10-04 用户最终确认）；王按所当点数，响应可用王补缺）或炸弹。
 *   后继接出的桌面（type 'gap'）只有炸弹能压。
 */
export function validateFlipResponse(
  table: Combo | null,
  prevTable: Combo | null,
  flippedCardId: number,
  cards: readonly Card[],
  cfg: RuleConfig,
  rev = false,
  allowSoloJoker = false
): FlipResponse {
  if (!table) return { ok: false, reason: '起牌时不能发动【端庄】（只能在响应时翻面）' };
  const flipped = table.cards.find((c) => c.id === flippedCardId);
  if (!flipped) return { ok: false, reason: '翻面的牌不在桌面上' };
  if (cards.length === 0) return { ok: false, reason: '请选择要出的牌' };
  if (table.cards.length === 1) {
    // 情况一：翻掉整手单张，接上一手的牌（按正常管牌规则）
    if (!prevTable) return { ok: false, reason: '前面只有这一手牌，无法发动【端庄】' };
    const combo = parseCombo(cards, cfg, rev, allowSoloJoker);
    if (!combo) return { ok: false, reason: '这不是合法牌型（王不能单独打出）' };
    if (!canBeat(combo, prevTable, cfg, rev)) return { ok: false, reason: '压不过上一手的牌' };
    return { ok: true, combo, pressedKind: 'prev' };
  }
  // 情况二：翻掉其中一张，剩余按规则响应
  const remainder = table.cards.filter((c) => c.id !== flippedCardId);
  const remainderCombo = parseCombo(remainder, cfg, rev, true); // 剩余单王/对王视为王类牌型（只有炸弹能压）
  const combo = parseCombo(cards, cfg, rev, allowSoloJoker);
  if (remainderCombo) {
    if (!combo) return { ok: false, reason: '这不是合法牌型（王不能单独打出）' };
    if (!canBeat(combo, remainderCombo, cfg, rev)) return { ok: false, reason: '压不过翻面后剩余的牌' };
    return { ok: true, combo, pressedKind: 'top' };
  }
  // 剩余非法：炸弹照常炸一切；否则后继接牌（每张剩余牌按原牌型中所当点数 ±1：正序 +1、倒序 −1）
  // 后继响应本身不是合法牌型——如剩 35 接 46——不能先按合法牌型卡掉
  if (combo?.type === 'bomb') return { ok: true, combo, pressedKind: 'top' };
  if (cards.length !== remainder.length)
    return { ok: false, reason: '剩余不是合法牌型：只能打后继（每张点数 ±1，王可补缺）或炸弹' };
  const resolvedOf = new Map(table.resolved.map((r) => [r.cardId, r.rank]));
  const successorRanks: number[] = [];
  for (const c of remainder) {
    const r = (resolvedOf.get(c.id) ?? c.rank) as number;
    const s = rev ? r - 1 : r + 1;
    if (s < RANK_3 || s > RANK_2) return { ok: false, reason: '翻面后无法后继接牌（只有炸弹能压）' };
    successorRanks.push(s);
  }
  const need = [...successorRanks].sort((a, b) => a - b);
  let jokers = 0;
  for (const c of cards) {
    if (isJoker(c)) {
      jokers++;
      continue;
    }
    const i = need.indexOf(c.rank);
    if (i < 0) return { ok: false, reason: '后继接牌点数不对（正序 +1、倒序 −1，王可补缺）' };
    need.splice(i, 1);
  }
  if (need.length !== jokers) return { ok: false, reason: '后继接牌点数不对（正序 +1、倒序 −1，王可补缺）' };
  // 构造后继牌型：真牌记实际点数，王按剩余未命中的后继点数逐个分配（确定性：按牌 id 序）
  const assigned = [...need].sort((a, b) => a - b);
  const sorted = [...cards].sort((a, b) => a.id - b.id);
  let ji = 0;
  const resolved = sorted.map((c) => ({
    cardId: c.id,
    rank: isJoker(c) ? (assigned[ji++]! as Rank) : (c.rank as Rank),
  }));
  const maxRank = Math.max(...resolved.map((r) => r.rank));
  const label = `翻面接 ${resolved.map((r) => rankLabel(r.rank)).join('')}`;
  return {
    ok: true,
    combo: buildCombo('gap', sorted, maxRank as Rank, resolved, label),
    pressedKind: 'top',
  };
}
