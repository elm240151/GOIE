// 点数编码：3..15（15 = 2），16 = 小王，17 = 大王（王无点数，纯百搭）
export type Rank = 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
export type CardRank = Rank | 16 | 17;

export const RANK_3 = 3;
export const RANK_A = 14;
export const RANK_2 = 15;
export const JOKER_SMALL = 16;
export const JOKER_BIG = 17;

export const SUITS = ['♠', '♥', '♣', '♦'] as const;
export type Suit = 0 | 1 | 2 | 3;

export interface Card {
  /** 全局唯一，一局内不变 */
  id: number;
  /** 属于第几副牌（0-2） */
  deck: 0 | 1 | 2;
  /** 花色（王时无意义） */
  suit: Suit;
  rank: CardRank;
}

export const isJoker = (c: Card): boolean => c.rank === JOKER_SMALL || c.rank === JOKER_BIG;
/** 王 = 百搭 */
export const isWild = isJoker;
/** 是否普通点数（非王） */
export const isRank = (r: CardRank): r is Rank => r >= RANK_3 && r <= RANK_2;

export type CardColor = 'red' | 'black';

/** 颜色（判定/技能用）：♥♦ 与大王为红，♠♣ 与小王为黑 */
export const cardColor = (c: Card): CardColor =>
  isJoker(c) ? (c.rank === JOKER_BIG ? 'red' : 'black') : c.suit === 1 || c.suit === 3 ? 'red' : 'black';

/**
 * 王的包含花色：小王双黑 ♠♣，大王双红 ♥♦。
 * 判定中出现王（打出的牌里、或翻出的判定牌）一律按对应颜色的两种花色计算（2026-10-03 用户确认）。
 */
export const jokerSuits = (c: Card): number[] => (c.rank === JOKER_BIG ? [1, 3] : [0, 2]);

/**
 * 点数计算（楠王回味等技能用）：2 记作 2、A 记作 1、其余按牌面点数（J=11 Q=12 K=13）。
 * 注意与牌序 rank 不同：这里 2 不是最大。王不在点数体系内——当百搭按所当点数、单出由技能按无穷处理。
 * （2026-10-03 用户确认）
 */
export const pointValue = (rank: number): number => (rank === RANK_2 ? 2 : rank === RANK_A ? 1 : rank);

export function rankLabel(r: CardRank): string {
  switch (r) {
    case 11:
      return 'J';
    case 12:
      return 'Q';
    case 13:
      return 'K';
    case 14:
      return 'A';
    case 15:
      return '2';
    case JOKER_SMALL:
      return '小王';
    case JOKER_BIG:
      return '大王';
    default:
      return String(r);
  }
}

export function cardLabel(c: Card): string {
  return isJoker(c) ? rankLabel(c.rank) : `${SUITS[c.suit]}${rankLabel(c.rank)}`;
}
