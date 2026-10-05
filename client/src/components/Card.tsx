// 单张牌面。王：双角标「王」+ 中央星徽与大小徽章，颜色用共享 cardColor（大王红、小王黑）。
import { cardColor, isJoker, JOKER_BIG, rankLabel, SUITS, type Card as CardT, type Rank } from '@gdys/shared';
import { STR } from '../strings';

interface Props {
  card: CardT;
  /** 作为百搭实际充当的点数（预览用） */
  asRank?: Rank;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  /** 牌背（端庄翻面牌：翻面后公开可见，但只显示牌背） */
  faceDown?: boolean;
}

export default function Card({ card, asRank, selected, onClick, disabled, faceDown }: Props) {
  const joker = isJoker(card);
  const red = cardColor(card) === 'red';
  const label = asRank !== undefined ? rankLabel(asRank) : rankLabel(card.rank);
  if (faceDown) {
    return (
      <button type="button" className="card card-back" disabled={!onClick} onClick={onClick}>
        <span className="card-center card-back-mark">✦</span>
      </button>
    );
  }
  const cls = ['card', red ? 'card-red' : 'card-black', joker ? 'card-joker' : '', selected ? 'card-selected' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled || !onClick}>
      {joker ? (
        <>
          <span className="card-corner">{STR.game.cardJokerLabel}</span>
          <span className="card-corner card-corner-br">{STR.game.cardJokerLabel}</span>
          <span className="card-center joker-center">
            <span className="joker-star">✦</span>
            <span className="joker-tag">{card.rank === JOKER_BIG ? STR.game.cardJokerBig : STR.game.cardJokerSmall}</span>
          </span>
          {asRank !== undefined && <em className="card-as-rank">{STR.game.cardAsRank.replace('{label}', label)}</em>}
        </>
      ) : (
        <>
          <span className="card-corner">{label}</span>
          <span className="card-center">{SUITS[card.suit]}</span>
          {asRank !== undefined && <em className="card-as-rank">{STR.game.cardAsRank.replace('{label}', label)}</em>}
        </>
      )}
    </button>
  );
}
