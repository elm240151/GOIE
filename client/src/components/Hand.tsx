// 手牌一横排：按点数排序、全部正立，牌多时自动加大叠压保证一排装得下；点选上浮。
import { isJoker, type Card as CardT } from '@gdys/shared';
import Card from './Card';

function sortHand(cards: readonly CardT[]): CardT[] {
  return [...cards].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (isJoker(a) !== isJoker(b)) return isJoker(a) ? 1 : -1;
    return a.suit - b.suit;
  });
}

interface Props {
  cards: readonly CardT[];
  selectedIds: number[];
  onToggle?: (cardId: number) => void;
  /** 自定义显示顺序（cardId 数组，来自手牌整理）；缺省按点数排序 */
  order?: number[] | null;
  /** 新摸入本手的牌 id（入场动画：从上方飞入） */
  enteredIds?: readonly number[];
}

export default function Hand({ cards, selectedIds, onToggle, order, enteredIds }: Props) {
  const sorted = order
    ? order
        .map((id) => cards.find((c) => c.id === id))
        .filter((c): c is CardT => c !== undefined)
    : sortHand(cards);
  // 入场顺序错开（多张同时摸入时逐张飞入，封顶 6 张）
  const enteredIndex = new Map<number, number>();
  (enteredIds ?? []).forEach((id, i) => enteredIndex.set(id, i));
  return (
    <div className="hand">
      {sorted.map((c) => {
        const enteredIdx = enteredIndex.get(c.id);
        return (
          <div key={c.id} className="hand-slot">
            {/* 内层跑入场动画，与叠压布局互不干扰 */}
            <div
              className={`hand-slot-inner${enteredIdx !== undefined ? ' hand-enter' : ''}`}
              style={enteredIdx !== undefined ? { animationDelay: `${Math.min(enteredIdx, 5) * 0.06}s` } : undefined}
            >
              <Card
                card={c}
                selected={selectedIds.includes(c.id)}
                onClick={onToggle ? () => onToggle(c.id) : undefined}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
