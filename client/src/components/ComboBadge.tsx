// 牌型徽章：显示牌型名（如"对7""顺子 3-4-5-6"）+ 解析后的牌面（王显示其补的位置），点数下方带花色。
import type { Combo } from '@gdys/shared';
import { cardColor, isJoker, rankLabel, SUITS } from '@gdys/shared';

const TYPE_CLASS: Record<Combo['type'], string> = {
  single: 'combo-single',
  pair: 'combo-pair',
  straight: 'combo-straight',
  consecutivePairs: 'combo-cp',
  bomb: 'combo-bomb',
  singleJoker: 'combo-single',
};

interface Props {
  combo: Combo;
  small?: boolean;
  /** 答疑改点：牌型标签已按新点数重写，金色高亮显示 */
  retagged?: boolean;
}

export default function ComboBadge({ combo, small, retagged }: Props) {
  // 按解析结果重建牌面顺序（王放到它补的位置），复用 resolved 顺序
  const cards = combo.resolved.map((r) => {
    const c = combo.cards.find((x) => x.id === r.cardId)!;
    return isJoker(c) ? { ...c, asRank: r.rank } : { ...c, asRank: undefined };
  });
  return (
    <span className={`combo-badge ${TYPE_CLASS[combo.type]} ${small ? 'combo-small' : ''} ${retagged ? 'combo-retagged' : ''}`}>
      <span className="combo-label">{combo.label}</span>
      <span className="combo-cards">
        {cards.map((c, i) => (
          <span key={i} className={`combo-mini ${cardColor(c) === 'red' ? 'mini-red' : 'mini-black'}`}>
            {c.asRank !== undefined ? rankLabel(c.asRank) : rankLabel(c.rank)}
            {!isJoker(c) && <i className="combo-suit">{SUITS[c.suit]}</i>}
            {c.asRank !== undefined && <i className="combo-wild-mark">鬼</i>}
          </span>
        ))}
      </span>
    </span>
  );
}
