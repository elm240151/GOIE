// 客户端出牌预览提示：与服务端同一套 parseCombo/canBeat（零漂移）。
// "压不过"只提示不阻断——技能可能豁免基础规则（如蛮力 +2），最终以服务端判定为准。
// 全部文案在 strings.ts（game.preview），本文件只做规则判定。
import { RANK_2, RANK_3, canBeat, defaultRules, isJoker, rankLabel, type Card, type Combo, type Rank } from '@gdys/shared';
import { STR } from './strings';

/** 所选牌不能构成合法牌型时的原因；null = 合法 */
export function invalidReason(selected: readonly Card[]): string | null {
  if (selected.length === 0) return null;
  if (selected.every(isJoker)) return STR.game.preview.jokerAlone;
  return STR.game.preview.invalidCombo;
}

/** 留 X 禁止收尾：所选牌打完手牌且为特殊点数的单/对（正序 2/倒序 3）→ 提示；否则 null */
export function finishHint(combo: Combo, handLen: number, rev: boolean): string | null {
  if (combo.cards.length !== handLen) return null;
  if (combo.type !== 'single' && combo.type !== 'pair') return null;
  if (combo.rank === (rev ? RANK_3 : RANK_2)) return rev ? STR.game.preview.noFinish3 : STR.game.preview.noFinish2;
  return null;
}

/** combo 按基础规则压不过 table 时的原因；null = 能压 */
export function beatReason(combo: Combo, table: Combo | null, rev = false): string | null {
  if (table === null) return null; // 起牌恒可出
  if (canBeat(combo, table, defaultRules, rev)) return null;

  if (table.type === 'bomb') {
    if (combo.type !== 'bomb') return STR.game.preview.bombOnly;
    if (combo.length < table.length) return STR.game.preview.bombNotEnough;
    return rev ? STR.game.preview.bombTooSmall : STR.game.preview.bombTooBig;
  }
  if (combo.type !== table.type) return STR.game.preview.typeMismatch;
  if (combo.type === 'single' || combo.type === 'pair') {
    if (rev) {
      if (table.rank === RANK_3) return STR.game.preview.onlyBombBeats3; // 3 上桌后单/对无解
      const kind = combo.type === 'single' ? '' : STR.game.preview.kindPair;
      return STR.game.preview.mustDown1
        .replace('{kind}', kind)
        .replace('{label}', rankLabel((table.rank - 1) as Rank));
    }
    if (table.rank === RANK_2) return STR.game.preview.onlyBombBeats2; // 2 上桌后单/对无解
    const kind = combo.type === 'single' ? '' : STR.game.preview.kindPair;
    return STR.game.preview.mustUp1
      .replace('{kind}', kind)
      .replace('{label}', rankLabel((table.rank + 1) as Rank));
  }
  if (combo.length !== table.length) {
    return combo.type === 'straight' ? STR.game.preview.straightLen : STR.game.preview.cpLen;
  }
  if (combo.rank <= table.rank) return rev ? STR.game.preview.needHigherRev : STR.game.preview.needHigher;
  return STR.game.preview.outOfWindow;
}
