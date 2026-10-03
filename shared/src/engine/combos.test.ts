import { describe, expect, it } from 'vitest';
import { JOKER_BIG, JOKER_SMALL, RANK_2, type Card, type CardRank, type Rank } from '../cards';
import { defaultRules } from '../config';
import { canBeat, comboKey, listPlayable, parseCombo, relabelCombo, type Combo } from './combos';

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

  it('留2禁止收尾：正序打出后手牌清空的单2/对2被排除', () => {
    // 只剩单2：无法起牌（死锁守卫自动过）
    expect(listPlayable([mk(15)], null, cfg)).toEqual([]);
    // 只剩单2：跟牌同样无候选
    expect(listPlayable([mk(15)], parse([3])!, cfg)).toEqual([]);
    // [2,2]：单2 可出（不空手），对2 被排除
    const twoTwo = listPlayable([mk(15), mk(15)], null, cfg);
    expect(twoTwo.map((c) => c.type)).toEqual(['single']);
    // [2,王]：单2 可出（剩王），对2 被排除
    const twoJoker = listPlayable([mk(15), W()], null, cfg);
    expect(twoJoker.map((c) => c.type)).toEqual(['single']);
    // 2炸（3 张 2）不受影响
    const bomb = listPlayable([mk(15), mk(15), mk(15)], null, cfg);
    expect(bomb.some((c) => c.type === 'bomb')).toBe(true);
    // 非收尾单2/对2 正常：手牌还有别的牌
    expect(listPlayable([mk(15), mk(7)], null, cfg).some((c) => c.type === 'single' && c.rank === 15)).toBe(true);
    expect(listPlayable([mk(15), mk(15), mk(7)], null, cfg).some((c) => c.type === 'pair' && c.rank === 15)).toBe(true);
  });
});

describe('倒序（海棠洄游）：整条牌序反转', () => {
  const rev = true;
  const parseR = (ranks: CardRank[]): Combo | null => parseCombo(ranks.map(mk), cfg, rev);
  const beat = (combo: Combo | null, table: Combo | null) => canBeat(combo!, table, cfg, rev);

  it('倒序顺子解析：543（起点 = 最高点）', () => {
    const c = parseR([5, 4, 3]);
    expectCombo(c, 'straight', 5, 3);
    expect(c!.label).toBe('顺子 5-4-3');
  });

  it('倒序顺子 4,5,鬼=543（镜像：先向 3 延伸）', () => {
    const c = parseR([4, 5, JOKER_SMALL]);
    expectCombo(c, 'straight', 5, 3);
    expect(c!.label).toBe('顺子 5-4-3');
  });

  it('倒序顺子 4,5,鬼,鬼=6543（向 3 延伸被 2 挡住，再向 A 延伸）', () => {
    const c = parseR([4, 5, JOKER_SMALL, JOKER_BIG]);
    expectCombo(c, 'straight', 6, 4);
    expect(c!.label).toBe('顺子 6-5-4-3');
  });

  it('倒序顺子 A,K,鬼=AKQ（镜像：向 A 被挡住，向下延伸）', () => {
    const c = parseR([14, 13, JOKER_SMALL]);
    expectCombo(c, 'straight', 14, 3);
    expect(c!.label).toBe('顺子 A-K-Q');
  });

  it('倒序顺子含 2 非法', () => {
    expect(parseR([3, RANK_2, 4])).toBeNull();
  });

  it('倒序连对：5544（起点 = 最高点）', () => {
    const c = parseR([5, 5, 4, 4]);
    expectCombo(c, 'consecutivePairs', 5, 4);
    expect(c!.label).toBe('连对 5544');
  });

  it('倒序连对 6,6,5,5,鬼,鬼=665544（镜像：先向 3 延伸）', () => {
    const c = parseR([6, 6, 5, 5, JOKER_SMALL, JOKER_BIG]);
    expectCombo(c, 'consecutivePairs', 6, 6);
    expect(c!.label).toBe('连对 665544');
  });

  it('倒序连对 4,4,鬼,鬼=炸弹 4×4（同点数优先判炸，与正序一致）', () => {
    expectCombo(parseR([4, 4, JOKER_SMALL, JOKER_BIG]), 'bomb', 4, 4);
  });

  it('倒序单张：恰好小一级（5 只能 4 压）', () => {
    expect(beat(parseR([4]), parseR([5]))).toBe(true);
    expect(beat(parseR([6]), parseR([5]))).toBe(false);
    expect(beat(parseR([10]), parseR([5]))).toBe(false);
  });

  it('倒序单张：3 压一切但 3 压不了 3', () => {
    expect(beat(parseR([3]), parseR([9]))).toBe(true);
    expect(beat(parseR([3]), parseR([3]))).toBe(false);
  });

  it('倒序单张：2 谁也压不了，A 响应 2', () => {
    expect(beat(parseR([14]), parseR([15]))).toBe(true); // 倒序用 A 响应 2
    expect(beat(parseR([15]), parseR([9]))).toBe(false); // 2 最小压不了任何牌
    expect(beat(parseR([15]), parseR([15]))).toBe(false);
  });

  it('倒序对子：对3 压一切对子、对3 只有炸压', () => {
    expect(beat(parseR([3, 3]), parseR([9, 9]))).toBe(true);
    expect(beat(parseR([3, 3]), parseR([3, 3]))).toBe(false);
    expect(beat(parseR([9, 9]), parseR([3, 3]))).toBe(false);
    expect(beat(parseR([14, 14]), parseR([15, 15]))).toBe(true); // 对A 响应对2
    expect(beat(parseR([3, 3, 3]), parseR([3, 3]))).toBe(true); // 只有炸能压对3
  });

  it('倒序炸弹：张数优先不变、同张数比点反转（3炸最强/2炸最弱）', () => {
    expect(beat(parseR([3, 3, 3]), parseR([9, 9, 9]))).toBe(true);
    expect(beat(parseR([9, 9, 9]), parseR([3, 3, 3]))).toBe(false);
    expect(beat(parseR([15, 15, 15]), parseR([9, 9, 9]))).toBe(false);
    expect(beat(parseR([9, 9, 9]), parseR([3, 3, 3, 3]))).toBe(false); // 张数优先
    expect(beat(parseR([9, 9, 9, 9]), parseR([3, 3, 3]))).toBe(true);
    expect(beat(parseR([9, 9, 9]), parseR([5, 5]))).toBe(true); // 炸压一切不变
  });

  it('倒序顺子：654/765 接 543，876 不接（窗口镜像）', () => {
    expect(beat(parseR([6, 5, 4]), parseR([5, 4, 3]))).toBe(true);
    expect(beat(parseR([7, 6, 5]), parseR([5, 4, 3]))).toBe(true);
    expect(beat(parseR([8, 7, 6]), parseR([5, 4, 3]))).toBe(false);
    expect(beat(parseR([5, 4, 3]), parseR([6, 5, 4]))).toBe(false); // 最高点没更高
    expect(beat(parseR([4, 3, 5]), parseR([5, 4, 3]))).toBe(false); // 长度不同压不了
  });

  it('倒序连对：4433 只能被 5544 接（窗口镜像，与正序 3344 只被 4455 接一致）', () => {
    expect(beat(parseR([5, 5, 4, 4]), parseR([4, 4, 3, 3]))).toBe(true);
    expect(beat(parseR([6, 6, 5, 5]), parseR([4, 4, 3, 3]))).toBe(false);
    expect(beat(parseR([7, 7, 6, 6]), parseR([4, 4, 3, 3]))).toBe(false);
  });

  it('倒序：跨牌型判定不变（单压不了对、非炸压不了炸）', () => {
    expect(beat(parseR([4]), parseR([5, 5]))).toBe(false);
    expect(beat(parseR([4, 4, 4]), parseR([3]))).toBe(true);
    expect(beat(parseR([4]), parseR([3, 3, 3]))).toBe(false);
  });

  it('倒序枚举：跟单5 只能出单4 或单3', () => {
    const hand = [mk(4), mk(3), mk(6), mk(9)];
    const out = listPlayable(hand, parseR([5])!, cfg, rev);
    expect(out.map((c) => `${c.type}:${c.rank}`)).toEqual(['single:4', 'single:3']);
  });

  it('倒序枚举：跟543 只能出654/765', () => {
    const hand = [mk(6), mk(5), mk(4), mk(7), mk(6), mk(5), mk(8), mk(7), mk(6)];
    const out = listPlayable(hand, parseR([5, 4, 3])!, cfg, rev);
    expect(out.filter((c) => c.type === 'straight').map((c) => c.label)).toEqual(['顺子 6-5-4', '顺子 7-6-5']);
  });

  it('倒序枚举：跟炸弹3×5 只能更长或同长更小点数', () => {
    const hand = [mk(3), mk(3), mk(3), mk(9), mk(9), mk(9), mk(9)];
    const out = listPlayable(hand, parseR([5, 5, 5])!, cfg, rev);
    expect(out.some((c) => c.type === 'bomb' && c.rank === 3 && c.length === 3)).toBe(true); // 3炸
    expect(out.some((c) => c.type === 'bomb' && c.rank === 9 && c.length === 4)).toBe(true); // 更长
    expect(out.some((c) => c.type === 'bomb' && c.rank === 9 && c.length === 3)).toBe(false); // 同长 9 比 5 弱
  });

  it('倒序禁止收尾：打出后手牌清空的单3/对3被排除', () => {
    expect(listPlayable([mk(3)], null, cfg, rev)).toEqual([]);
    expect(listPlayable([mk(3)], parseR([9])!, cfg, rev)).toEqual([]); // 跟牌同样无候选
    const threeThree = listPlayable([mk(3), mk(3)], null, cfg, rev);
    expect(threeThree.map((c) => c.type)).toEqual(['single']);
    const threeJoker = listPlayable([mk(3), W()], null, cfg, rev);
    expect(threeJoker.map((c) => c.type)).toEqual(['single']);
    // 3炸 不受影响
    expect(listPlayable([mk(3), mk(3), mk(3)], null, cfg, rev).some((c) => c.type === 'bomb')).toBe(true);
    // 非收尾单3/对3 正常
    expect(listPlayable([mk(3), mk(7)], null, cfg, rev).some((c) => c.type === 'single' && c.rank === 3)).toBe(true);
    // 倒序下留 2 不再禁止：只剩单2 可起牌
    expect(listPlayable([mk(15)], null, cfg, rev).map((c) => c.type)).toEqual(['single']);
  });

  it('倒序往返性质：枚举出的每个组合都能按倒序重新解析为相同规范形', () => {
    let seed = 777;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ranks: CardRank[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    for (let iter = 0; iter < 200; iter++) {
      const size = 3 + Math.floor(rnd() * 15);
      const hand: Card[] = [];
      for (let i = 0; i < size; i++) hand.push(mk(ranks[Math.floor(rnd() * ranks.length)]!));
      for (const c of listPlayable(hand, null, cfg, rev)) {
        const reparsed = parseCombo(c.cards, cfg, rev);
        expect(reparsed).not.toBeNull();
        expect(comboKey(reparsed!)).toBe(comboKey(c));
      }
    }
  });
});

describe('单王（橐驼诅咒）：singleJoker 牌型', () => {
  const pj = () => parseCombo([mk(JOKER_SMALL)], cfg, false, true)!; // 正序单王
  const pjR = () => parseCombo([mk(JOKER_BIG)], cfg, true, true)!; // 倒序单王
  const parseR = (ranks: CardRank[]): Combo | null => parseCombo(ranks.map(mk), cfg, true);

  it('不开启时单王仍非法（正倒序一致）', () => {
    expect(parseCombo([mk(JOKER_SMALL)], cfg)).toBeNull();
    expect(parseCombo([mk(JOKER_BIG)], cfg, true)).toBeNull();
  });

  it('开启后解析为 singleJoker：点数 16、标签 王、可起牌', () => {
    const c = pj();
    expectCombo(c, 'singleJoker', 16, 1);
    expect(c.label).toBe('王');
    expect(canBeat(c, null, cfg)).toBe(true);
  });

  it('不开启时双王仍是纯王非法（正倒序一致）', () => {
    expect(parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg)).toBeNull();
    expect(parseCombo([mk(JOKER_SMALL), mk(JOKER_SMALL)], cfg, true)).toBeNull();
  });

  it('开启后双王解析为 jokerPair：点数 16、标签 对王、可起牌（对王，2026-10-03 用户确认）', () => {
    const c = parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg, false, true)!;
    expectCombo(c, 'jokerPair', 16, 2);
    expect(c.label).toBe('对王');
    expect(canBeat(c, null, cfg)).toBe(true);
    const cR = parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg, true, true)!;
    expectCombo(cR, 'jokerPair', 16, 2);
  });

  it('三王非法（对王只限两张王）', () => {
    expect(parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG), mk(JOKER_SMALL)], cfg, false, true)).toBeNull();
  });

  it('对王压一切对子：正序含对 2、倒序含对 3（镜像单王）', () => {
    const jp = () => parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg, false, true)!;
    expect(canBeat(jp(), parse([15, 15])!, cfg)).toBe(true); // 正序压对 2
    expect(canBeat(jp(), parse([3, 3])!, cfg)).toBe(true);
    expect(canBeat(jp(), parse([9, 9])!, cfg)).toBe(true);
    const jpR = () => parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg, true, true)!;
    expect(canBeat(jpR(), parseR([3, 3])!, cfg, true)).toBe(true); // 倒序压对 3
    expect(canBeat(jpR(), parseR([15, 15])!, cfg, true)).toBe(true);
  });

  it('只有炸弹能压对王，对王压不了对王', () => {
    const jp = () => parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg, false, true)!;
    expect(canBeat(parse([3, 3, 3])!, jp(), cfg)).toBe(true);
    expect(canBeat(parse([15, 15])!, jp(), cfg)).toBe(false); // 对 2 也压不了对王
    expect(canBeat(jp(), jp(), cfg)).toBe(false);
  });

  it('对王跨牌型压不了（单张/顺子/炸弹/单王都不吃对王）', () => {
    const jp = () => parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg, false, true)!;
    expect(canBeat(jp(), parse([5])!, cfg)).toBe(false);
    expect(canBeat(jp(), parse([4, 5, 6])!, cfg)).toBe(false);
    expect(canBeat(jp(), parse([3, 3, 3])!, cfg)).toBe(false);
    expect(canBeat(jp(), pj(), cfg)).toBe(false);
    expect(canBeat(pj(), jp(), cfg)).toBe(false);
  });

  it('枚举：双王手牌含对王候选；跟对子也有对王；跟对王只有炸弹候选', () => {
    const jp = () => parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg, false, true)!;
    // 双王起牌：每张王可单独出 + 对王
    expect(listPlayable([W(), W()], null, cfg, false, true).map(comboKey)).toEqual([
      'singleJoker:16:1',
      'singleJoker:16:1',
      'jokerPair:16:2',
    ]);
    const hand = [W(), W(), mk(5)];
    // 跟对子：对王压一切对子
    expect(listPlayable(hand, parse([5, 5])!, cfg, false, true).map(comboKey)).toEqual(['jokerPair:16:2']);
    // 跟对王：只有炸弹能压
    expect(listPlayable(hand, jp(), cfg, false, true).map(comboKey)).toEqual(['bomb:5:3']);
    // 单张桌面不吃对王（跨牌型）
    expect(listPlayable(hand, parse([5])!, cfg, false, true).map(comboKey)).not.toContain('jokerPair:16:2');
  });

  it('留2/留3 禁止收尾不过滤对王（对王不是对 2/对 3，可收尾）', () => {
    expect(listPlayable([W(), W()], null, cfg, false, true).map(comboKey)).toContain('jokerPair:16:2');
    expect(listPlayable([W(), W()], null, cfg, true, true).map(comboKey)).toContain('jokerPair:16:2');
  });

  it('relabelCombo 不改对王（答疑无点数可改，防御不变）', () => {
    const jp = parseCombo([mk(JOKER_SMALL), mk(JOKER_BIG)], cfg, false, true)!;
    const r = relabelCombo(jp, 9 as Rank, false);
    expect(r.type).toBe('jokerPair');
    expect(r.rank).toBe(16);
    expect(r.label).toBe('对王');
  });

  it('王压一切单张：正序含 2、倒序含 3（无穷大/无穷小镜像同规则）', () => {
    expect(canBeat(pj(), parse([15])!, cfg)).toBe(true); // 正序压 2
    expect(canBeat(pj(), parse([3])!, cfg)).toBe(true);
    expect(canBeat(pj(), parse([14])!, cfg)).toBe(true);
    expect(canBeat(pjR(), parseR([3])!, cfg, true)).toBe(true); // 倒序压 3
    expect(canBeat(pjR(), parseR([15])!, cfg, true)).toBe(true);
    expect(canBeat(pjR(), parseR([9])!, cfg, true)).toBe(true);
  });

  it('只有炸弹能压王，王压不了王', () => {
    expect(canBeat(parse([3, 3, 3])!, pj(), cfg)).toBe(true);
    expect(canBeat(parseR([3, 3, 3])!, pjR(), cfg, true)).toBe(true);
    expect(canBeat(parse([15])!, pj(), cfg)).toBe(false); // 单 2 也压不了
    expect(canBeat(parse([14, 14])!, pj(), cfg)).toBe(false);
    expect(canBeat(pj(), pj(), cfg)).toBe(false);
  });

  it('王跨牌型压不了（对子/顺子/炸弹都不吃王）', () => {
    expect(canBeat(pj(), parse([5, 5])!, cfg)).toBe(false);
    expect(canBeat(pj(), parse([4, 5, 6])!, cfg)).toBe(false);
    expect(canBeat(pj(), parse([3, 3, 3])!, cfg)).toBe(false);
    expect(canBeat(pjR(), parseR([5, 5])!, cfg, true)).toBe(false);
  });

  it('枚举起牌：开启后含单王候选、不开启不含', () => {
    const hand = [mk(3), W()];
    const on = listPlayable(hand, null, cfg, false, true).map(comboKey);
    expect(on).toContain('singleJoker:16:1');
    expect(on).toContain('single:3:1');
    const off = listPlayable(hand, null, cfg).map(comboKey);
    expect(off).not.toContain('singleJoker:16:1');
  });

  it('枚举跟单2：只剩王 → 唯一候选是王；不开启则无候选', () => {
    const hand = [W()];
    expect(listPlayable(hand, parse([15])!, cfg, false, true).map(comboKey)).toEqual(['singleJoker:16:1']);
    expect(listPlayable(hand, parse([15])!, cfg)).toEqual([]);
  });

  it('枚举跟对子：王无候选（跨牌型）', () => {
    expect(listPlayable([W()], parse([5, 5])!, cfg, false, true)).toEqual([]);
  });

  it('枚举跟单王：只有炸弹候选（王压不了王）', () => {
    const hand = [mk(4), mk(4), mk(4), W()];
    const keys = listPlayable(hand, pj(), cfg, false, true).map(comboKey);
    expect(keys).toEqual(['bomb:4:3', 'bomb:4:4']);
  });

  it('留2禁止收尾不过滤单王（王不是 2，可收尾；倒序同理）', () => {
    expect(listPlayable([W()], null, cfg, false, true).map(comboKey)).toEqual(['singleJoker:16:1']);
    expect(listPlayable([W()], null, cfg, true, true).map(comboKey)).toEqual(['singleJoker:16:1']);
  });

  it('relabelCombo 不改单王（答疑只对 ≥2 张牌型，防御不变）', () => {
    const r = relabelCombo(pj(), 9 as Rank, false);
    expect(r.type).toBe('singleJoker');
    expect(r.rank).toBe(16);
    expect(r.label).toBe('王');
  });
});

describe('relabelCombo 答疑改点（修勾）', () => {
  it('对/炸/单：label 改点数，牌型与实体牌不变', () => {
    const pair = parseCombo([mk(3), mk(3)], cfg)!;
    const p = relabelCombo(pair, 9 as Rank, false);
    expect(p.label).toBe('对9');
    expect(p.rank).toBe(9);
    expect(p.type).toBe('pair');
    expect(p.cards).toBe(pair.cards); // 实体牌不变
    expect(relabelCombo(parseCombo([mk(3), mk(3), mk(3)], cfg)!, 14 as Rank, false).label).toBe('炸弹 3×A');
    expect(relabelCombo(parseCombo([mk(5)], cfg)!, 7 as Rank, false).label).toBe('7');
  });

  it('顺子：起点改写，窗口升序展示（正序 rank = 最低点）', () => {
    const s = parseCombo([mk(3), mk(4), mk(5)], cfg)!;
    const r = relabelCombo(s, 9 as Rank, false);
    expect(r.label).toBe('顺子 9-10-J');
    expect(r.rank).toBe(9);
    expect(relabelCombo(parseCombo([mk(3), mk(4), mk(5), mk(6), mk(7)], cfg)!, 10 as Rank, false).label).toBe(
      '顺子 10-J-Q-K-A'
    );
  });

  it('顺子倒序：rank = 最高点，展示窗口升序', () => {
    const s = parseCombo([mk(10), mk(9), mk(8)], cfg, true)!; // T98 倒序起点 10
    expect(s.rank).toBe(10);
    const r = relabelCombo(s, 12 as Rank, true);
    expect(r.label).toBe('顺子 10-J-Q');
    expect(r.rank).toBe(12);
  });

  it('连对：起点改写（正序/倒序）', () => {
    const cp = parseCombo([mk(3), mk(3), mk(4), mk(4)], cfg)!;
    expect(relabelCombo(cp, 9 as Rank, false).label).toBe('连对 991010');
    const cpRev = parseCombo([mk(4), mk(4), mk(3), mk(3)], cfg, true)!;
    expect(cpRev.rank).toBe(4);
    expect(relabelCombo(cpRev, 6 as Rank, true).label).toBe('连对 5566');
  });
});
