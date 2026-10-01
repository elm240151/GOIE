import { describe, expect, it } from 'vitest';
import { JOKER_BIG, JOKER_SMALL, type Card, type CardRank, type Rank } from '../cards';
import { defaultRules } from '../config';
import { canBeat, comboKey, listPlayable, parseCombo, type Combo } from './combos';

const cfg = defaultRules;

let nextId = 0;
function mk(rank: CardRank): Card {
  return { id: nextId++, deck: 0, suit: 0, rank };
}
const W = () => mk(JOKER_SMALL);

function parse(ranks: CardRank[]): Combo | null {
  return parseCombo(ranks.map(mk), cfg);
}

// 断言 combo 的类型/点数/长度/标签
function expectCombo(combo: Combo | null, type: string, rank: number, length: number) {
  expect(combo).not.toBeNull();
  expect(combo!.type).toBe(type);
  expect(combo!.rank).toBe(rank);
  expect(combo!.length).toBe(length);
}

describe('parseCombo 牌型解析', () => {
  it('单张', () => {
    const c = parse([7]);
    expectCombo(c, 'single', 7, 1);
    expect(c!.label).toBe('7');
  });

  it('单王非法', () => {
    expect(parse([JOKER_SMALL])).toBeNull();
    expect(parse([JOKER_BIG])).toBeNull();
  });

  it('双王非法', () => {
    expect(parse([JOKER_SMALL, JOKER_BIG])).toBeNull();
    expect(parse([JOKER_SMALL, JOKER_SMALL])).toBeNull();
  });

  it('纯王炸弹非法', () => {
    expect(parse([JOKER_SMALL, JOKER_SMALL, JOKER_BIG])).toBeNull();
  });

  it('对子', () => {
    const c = parse([7, 7]);
    expectCombo(c, 'pair', 7, 2);
    expect(c!.label).toBe('对7');
  });

  it('王补对子 7+鬼=对7', () => {
    const c = parse([7, JOKER_SMALL]);
    expectCombo(c, 'pair', 7, 2);
  });

  it('2+鬼=对2', () => {
    const c = parse([15, JOKER_BIG]);
    expectCombo(c, 'pair', 15, 2);
  });

  it('顺子 345', () => {
    const c = parse([3, 4, 5]);
    expectCombo(c, 'straight', 3, 3);
    expect(c!.label).toBe('顺子 3-4-5');
  });

  it('顺子 3,4,鬼=345', () => {
    const c = parse([3, 4, JOKER_SMALL]);
    expectCombo(c, 'straight', 3, 3);
  });

  it('顺子 4,5,鬼,鬼=4567（向上延伸）', () => {
    const c = parse([4, 5, JOKER_SMALL, JOKER_BIG]);
    expectCombo(c, 'straight', 4, 4);
    expect(c!.label).toBe('顺子 4-5-6-7');
  });

  it('顺子 K,A,鬼=QKA（向上被A挡住，向下延伸）', () => {
    const c = parse([13, 14, JOKER_SMALL]);
    expectCombo(c, 'straight', 12, 3);
    expect(c!.label).toBe('顺子 Q-K-A');
  });

  it('顺子 10,J,Q,鬼,K=10JQKA', () => {
    const c = parse([10, 11, 12, JOKER_SMALL, 13]);
    expectCombo(c, 'straight', 10, 5);
    expect(c!.label).toBe('顺子 10-J-Q-K-A');
  });

  it('顺子内部缺口 3,4,鬼,6=3456', () => {
    const c = parse([3, 4, JOKER_SMALL, 6]);
    expectCombo(c, 'straight', 3, 4);
  });

  it('顺子含2非法', () => {
    expect(parse([3, 4, 15])).toBeNull();
    expect(parse([10, 11, 12, 13, 14, 15])).toBeNull();
  });

  it('顺子重复真牌非法', () => {
    expect(parse([3, 3, 4])).toBeNull();
  });

  it('顺子超过A非法', () => {
    expect(parse([13, 14, JOKER_SMALL, JOKER_BIG, JOKER_SMALL, 15])).toBeNull(); // 含2
  });

  it('连对 3344', () => {
    const c = parse([3, 3, 4, 4]);
    expectCombo(c, 'consecutivePairs', 3, 4);
    expect(c!.label).toBe('连对 3344');
  });

  it('连对 3,鬼,4,4=3344', () => {
    const c = parse([3, JOKER_SMALL, 4, 4]);
    expectCombo(c, 'consecutivePairs', 3, 4);
  });

  it('连对 5,5,6,6,鬼,鬼=556677', () => {
    const c = parse([5, 5, 6, 6, JOKER_SMALL, JOKER_BIG]);
    expectCombo(c, 'consecutivePairs', 5, 6);
    expect(c!.label).toBe('连对 556677');
  });

  it('连对内部空档 3,3,5,5,鬼,鬼=334455', () => {
    const c = parse([3, 3, 5, 5, JOKER_SMALL, JOKER_BIG]);
    expectCombo(c, 'consecutivePairs', 3, 6);
  });

  it('连对含2非法', () => {
    expect(parse([14, 14, 15, 15])).toBeNull(); // AA22
    expect(parse([15, 15, 3, 3])).toBeNull();
  });

  it('连对同点数超2张非法', () => {
    expect(parse([3, 3, 3, 4, 4])).toBeNull();
  });

  it('炸弹 3×5（三张即炸）', () => {
    const c = parse([5, 5, 5]);
    expectCombo(c, 'bomb', 5, 3);
    expect(c!.label).toBe('炸弹 3×5');
  });

  it('炸弹 5,5,鬼=3×5', () => {
    const c = parse([5, 5, JOKER_SMALL]);
    expectCombo(c, 'bomb', 5, 3);
  });

  it('炸弹 2,2,鬼=3×2（2 可以成炸）', () => {
    const c = parse([15, 15, JOKER_BIG]);
    expectCombo(c, 'bomb', 15, 3);
  });

  it('炸弹 13 张非法（上限 12）', () => {
    const cards: CardRank[] = [];
    for (let i = 0; i < 13; i++) cards.push(13);
    expect(parse(cards)).toBeNull();
  });

  it('混合炸弹非法 7,7,7,7,8', () => {
    expect(parse([7, 7, 7, 7, 8])).toBeNull();
  });

  it('空手牌非法', () => {
    expect(parse([])).toBeNull();
  });
});

describe('canBeat 管牌判定', () => {
  const p = (ranks: CardRank[]) => parse(ranks)!;

  it('单张恰好大一级', () => {
    expect(canBeat(p([4]), p([3]), cfg)).toBe(true);
    expect(canBeat(p([5]), p([3]), cfg)).toBe(false);
    expect(canBeat(p([3]), p([4]), cfg)).toBe(false);
  });

  it('对子恰好大一级', () => {
    expect(canBeat(p([6, 6]), p([5, 5]), cfg)).toBe(true);
    expect(canBeat(p([7, 7]), p([5, 5]), cfg)).toBe(false);
  });

  it('2 无视+1压一切单张', () => {
    expect(canBeat(p([15]), p([14]), cfg)).toBe(true);
    expect(canBeat(p([15]), p([3]), cfg)).toBe(true);
  });

  it('对2 压一切对子', () => {
    expect(canBeat(p([15, 15]), p([14, 14]), cfg)).toBe(true);
    expect(canBeat(p([15, 15]), p([3, 3]), cfg)).toBe(true);
  });

  it('2 压不了 2', () => {
    expect(canBeat(p([15]), p([15]), cfg)).toBe(false);
    expect(canBeat(p([15, 15]), p([15, 15]), cfg)).toBe(false);
  });

  it('2 跨牌型压不了（单2压不了对子）', () => {
    expect(canBeat(p([15]), p([14, 14]), cfg)).toBe(false);
    expect(canBeat(p([15, 15]), p([14]), cfg)).toBe(false);
  });

  it('只有炸弹能压 2', () => {
    expect(canBeat(p([14]), p([15]), cfg)).toBe(false);
    expect(canBeat(p([3, 3, 3]), p([15]), cfg)).toBe(true);
    expect(canBeat(p([3, 3, 3]), p([15, 15]), cfg)).toBe(true);
  });

  it('炸弹张数优先于点数', () => {
    expect(canBeat(p([5, 5, 5, 5]), p([13, 13, 13]), cfg)).toBe(true); // 4×5 > 3×K
    expect(canBeat(p([13, 13, 13]), p([5, 5, 5, 5]), cfg)).toBe(false);
  });

  it('炸弹同张数比点数', () => {
    expect(canBeat(p([14, 14, 14]), p([13, 13, 13]), cfg)).toBe(true); // 3×A > 3×K
    expect(canBeat(p([15, 15, 15]), p([14, 14, 14]), cfg)).toBe(true); // 3×2 > 3×A
    expect(canBeat(p([3, 3, 3]), p([4, 4, 4]), cfg)).toBe(false);
  });

  it('炸弹炸一切', () => {
    expect(canBeat(p([3, 3, 3]), p([4, 5, 6]), cfg)).toBe(true);
    expect(canBeat(p([3, 3, 3]), p([14, 14]), cfg)).toBe(true);
  });

  it('非炸压不了炸', () => {
    expect(canBeat(p([4, 5, 6]), p([3, 3, 3]), cfg)).toBe(false);
    expect(canBeat(p([15]), p([3, 3, 3]), cfg)).toBe(false);
  });

  it('顺子：起点必须落在上家窗口内', () => {
    expect(canBeat(p([4, 5, 6]), p([3, 4, 5]), cfg)).toBe(true); // 456 接 345
    expect(canBeat(p([5, 6, 7]), p([3, 4, 5]), cfg)).toBe(true); // 567 接 345
    expect(canBeat(p([6, 7, 8]), p([3, 4, 5]), cfg)).toBe(false); // 678 接不了 345
  });

  it('顺子 3456 只能被 4567/5678/6789 接', () => {
    expect(canBeat(p([4, 5, 6, 7]), p([3, 4, 5, 6]), cfg)).toBe(true);
    expect(canBeat(p([5, 6, 7, 8]), p([3, 4, 5, 6]), cfg)).toBe(true);
    expect(canBeat(p([6, 7, 8, 9]), p([3, 4, 5, 6]), cfg)).toBe(true);
    expect(canBeat(p([7, 8, 9, 10]), p([3, 4, 5, 6]), cfg)).toBe(false);
  });

  it('顺子长度不同压不了', () => {
    expect(canBeat(p([4, 5, 6, 7]), p([3, 4, 5]), cfg)).toBe(false);
    expect(canBeat(p([4, 5, 6]), p([3, 4, 5, 6]), cfg)).toBe(false);
  });

  it('连对：3344 只能被 4455 接', () => {
    expect(canBeat(p([4, 4, 5, 5]), p([3, 3, 4, 4]), cfg)).toBe(true);
    expect(canBeat(p([5, 5, 6, 6]), p([3, 3, 4, 4]), cfg)).toBe(false);
  });

  it('起牌（桌面为空）恒可', () => {
    expect(canBeat(p([3]), null, cfg)).toBe(true);
  });
});

describe('listPlayable 可出牌枚举', () => {
  it('起牌：手牌包含的牌型都在枚举内', () => {
    const hand = [mk(3), mk(4), mk(5), mk(7), mk(7), W()];
    const combos = listPlayable(hand, null, cfg);
    const keys = combos.map(comboKey);
    // 单张
    expect(keys).toContain('single:3:1');
    expect(keys).toContain('single:7:1');
    expect(keys).not.toContain('single:16:1');
    // 对子（7+鬼）
    expect(keys).toContain('pair:7:2');
    // 顺子 345 / 3,4,鬼=345
    expect(keys).toContain('straight:3:3');
    // 炸弹 3×7
    expect(keys).toContain('bomb:7:3');
  });

  it('跟单3：只能出单4或单2', () => {
    const hand = [mk(4), mk(5), mk(6), mk(15)];
    const combos = listPlayable(hand, parse([3])!, cfg);
    const keys = combos.map(comboKey);
    expect(keys).toEqual(['single:4:1', 'single:15:1']);
  });

  it('跟对5：只能出对6或对2', () => {
    const hand = [mk(6), mk(6), mk(7), mk(7), mk(15), W()];
    const combos = listPlayable(hand, parse([5, 5])!, cfg);
    const keys = combos.map(comboKey);
    expect(keys).toContain('pair:6:2');
    expect(keys).toContain('pair:15:2'); // 15+鬼
    expect(keys).not.toContain('pair:7:2');
  });

  it('跟345：只能出456/567', () => {
    const hand = [mk(4), mk(5), mk(6), mk(7), mk(8)];
    const combos = listPlayable(hand, parse([3, 4, 5])!, cfg);
    const keys = combos.map(comboKey);
    expect(keys).toContain('straight:4:3');
    expect(keys).toContain('straight:5:3');
    expect(keys).not.toContain('straight:6:3');
  });

  it('跟炸弹3×5：只能出更长炸弹或同长更高点数', () => {
    const hand = [mk(6), mk(6), mk(6), mk(5), mk(5), mk(5), mk(5), mk(3), mk(3), mk(3)];
    const combos = listPlayable(hand, parse([5, 5, 5])!, cfg);
    const keys = combos.map(comboKey);
    expect(keys).toContain('bomb:6:3'); // 同长更高
    expect(keys).toContain('bomb:5:4'); // 更长
    expect(keys).not.toContain('bomb:3:3'); // 点数低
  });

  it('跟单2：没有能压的（只有炸弹）', () => {
    const hand = [mk(14), mk(15), mk(7), mk(8)];
    const combos = listPlayable(hand, parse([15])!, cfg);
    expect(combos).toEqual([]);
  });

  it('往返性质：随机手牌枚举出的每个组合都能重新解析为相同规范形', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ranks: CardRank[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    for (let iter = 0; iter < 200; iter++) {
      const size = 3 + Math.floor(rnd() * 15);
      const hand: Card[] = [];
      for (let i = 0; i < size; i++) hand.push(mk(ranks[Math.floor(rnd() * ranks.length)]!));
      const leading = listPlayable(hand, null, cfg);
      for (const c of leading) {
        const reparsed = parseCombo(c.cards, cfg);
        expect(reparsed).not.toBeNull();
        expect(comboKey(reparsed!)).toBe(comboKey(c));
      }
    }
  });
});
