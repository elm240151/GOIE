// 单张牌面。王显示为竖排"王"，颜色用共享 cardColor（大王红、小王黑）。
import { cardColor, isJoker, JOKER_BIG, rankLabel, SUITS, type Card as CardT, type Rank } from '@gdys/shared';

interface Props {
  card: CardT;
  /** 作为百搭实际充当的点数（预览用） */
  asRank?: Rank;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

export default function Card({ card, asRank, selected, onClick, disabled }: Props) {
  const joker = isJoker(card);
  const red = cardColor(card) === 'red';
  const label = asRank !== undefined ? rankLabel(asRank) : rankLabel(card.rank);
  const cls = ['card', red ? 'card-red' : 'card-black', joker ? 'card-joker' : '', selected ? 'card-selected' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled || !onClick}>
      {joker ? (
        <span className="card-joker-text">
          {card.rank === JOKER_BIG ? '大王' : '小王'}
          {asRank !== undefined && <em className="card-as-rank">当{label}</em>}
        </span>
      ) : (
        <>
          <span className="card-corner">{label}</span>
          <span className="card-center">{SUITS[card.suit]}</span>
          {asRank !== undefined && <em className="card-as-rank">当{label}</em>}
        </>
      )}
    </button>
  );
}
