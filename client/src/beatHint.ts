// 客户端出牌预览提示：与服务端同一套 parseCombo/canBeat（零漂移）。
// "压不过"只提示不阻断——技能可能豁免基础规则（如蛮力 +2），最终以服务端判定为准。
import { RANK_2, RANK_3, canBeat, defaultRules, isJoker, rankLabel, type Card, type Combo, type Rank } from '@gdys/shared';

/** 所选牌不能构成合法牌型时的原因；null = 合法 */
export function invalidReason(selected: readonly Card[]): string | null {
  if (selected.length === 0) return null;
  if (selected.every(isJoker)) return '王不能单独打出';
  return '这不是合法牌型';
}

/** 留 X 禁止收尾：所选牌打完手牌且为特殊点数的单/对（正序 2/倒序 3）→ 提示；否则 null */
export function finishHint(combo: Combo, handLen: number, rev: boolean): string | null {
  if (combo.cards.length !== handLen) return null;
  if (combo.type !== 'single' && combo.type !== 'pair') return null;
  if (combo.rank === (rev ? RANK_3 : RANK_2))
    return rev ? '不能以单3/对3打完手牌（倒序禁止收尾）' : '不能以单2/对2打完手牌';
  return null;
}

/** combo 按基础规则压不过 table 时的原因；null = 能压 */
export function beatReason(combo: Combo, table: Combo | null, rev = false): string | null {
  if (table === null) return null; // 起牌恒可出
  if (canBeat(combo, table, defaultRules, rev)) return null;

  if (table.type === 'bomb') {
    if (combo.type !== 'bomb') return '只有炸弹能压炸弹';
    if (combo.length < table.length) return '炸弹张数不够';
    return rev ? '炸弹点数不够小（倒序比点反转）' : '炸弹点数不够大';
  }
  if (combo.type !== table.type) return '牌型不同，无法压';
  if (combo.type === 'single' || combo.type === 'pair') {
    if (rev) {
      if (table.rank === RANK_3) return '只有炸弹能压 3'; // 3 上桌后单/对无解
      const kind = combo.type === 'single' ? '' : '对';
      return `必须恰好小一级（出 ${kind}${rankLabel((table.rank - 1) as Rank)}）`;
    }
    if (table.rank === RANK_2) return '只有炸弹能压 2'; // 2 上桌后单/对无解
    const kind = combo.type === 'single' ? '' : '对';
    return `必须恰好大一点（出 ${kind}${rankLabel((table.rank + 1) as Rank)}）`;
  }
  if (combo.length !== table.length) {
    return combo.type === 'straight' ? '顺子长度必须相同' : '连对长度必须相同';
  }
  if (combo.rank <= table.rank) return rev ? '接牌最高点必须比上家大（倒序）' : '起点必须比上家大';
  return '起点超出接牌窗口';
}
