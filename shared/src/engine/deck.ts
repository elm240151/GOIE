import { JOKER_BIG, JOKER_SMALL, type Card, type Rank, type Suit } from '../cards';
import type { Rng } from './rng';

/** 构建 deckCount 副 54 张牌（每副 3..2 各 4 张 + 大小王） */
export function buildDeck(deckCount: number): Card[] {
  const cards: Card[] = [];
  let id = 0;
  for (let d = 0; d < deckCount; d++) {
    for (let s = 0; s < 4; s++) {
      for (let r = 3; r <= 15; r++) {
        cards.push({
          id: id++,
          deck: d as 0 | 1 | 2,
          suit: s as Suit,
          rank: r as Rank,
        });
      }
    }
    cards.push({ id: id++, deck: d as 0 | 1 | 2, suit: 0, rank: JOKER_SMALL });
    cards.push({ id: id++, deck: d as 0 | 1 | 2, suit: 0, rank: JOKER_BIG });
  }
  return cards;
}

/** Fisher-Yates 洗牌（不改原数组） */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
