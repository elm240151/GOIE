// 手牌一横排：按点数排序、全部正立，牌多时自动加大叠压保证一排装得下；点选上浮。
// FLIP 重排：牌 id 序列变化（出牌移除/摸牌/整理换位）时量新旧位置，反转变换再平滑归零；
// 只依赖 id 序列，选牌不测量；外层 .hand-slot 跑 FLIP、内层跑飞入、牌面跑选中上浮，三层互不干扰。
import { useLayoutEffect, useRef } from 'react';
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

  // FLIP：记录各槽位位置，id 序列变化时反转变换再归零（减弱动效偏好下跳过）
  const slotRefs = useRef(new Map<number, HTMLDivElement>());
  const prevRects = useRef<Map<number, DOMRect> | null>(null);
  const idsKey = sorted.map((c) => c.id).join(',');
  useLayoutEffect(() => {
    const rects = new Map<number, DOMRect>();
    for (const [id, el] of slotRefs.current) rects.set(id, el.getBoundingClientRect());
    const prev = prevRects.current;
    prevRects.current = rects;
    if (!prev) return; // 首次挂载只记录位置
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const moves: { el: HTMLDivElement; dx: number; dy: number }[] = [];
    for (const [id, r] of rects) {
      const p = prev.get(id);
      if (p && (p.left !== r.left || p.top !== r.top)) {
        const dx = p.left - r.left;
        const dy = p.top - r.top;
        if (dx !== 0 || dy !== 0) moves.push({ el: slotRefs.current.get(id)!, dx, dy });
      }
    }
    if (moves.length === 0) return;
    // 反转：瞬间回到旧位置（无过渡），下一帧再归零播放过渡
    for (const m of moves) {
      m.el.style.transition = 'none';
      m.el.style.transform = `translate(${m.dx}px, ${m.dy}px)`;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const m of moves) {
          m.el.style.transition = '';
          m.el.style.transform = '';
        }
      });
    });
  }, [idsKey]);

  return (
    <div className="hand">
      {sorted.map((c) => {
        const enteredIdx = enteredIndex.get(c.id);
        return (
          <div
            key={c.id}
            className="hand-slot hand-slot-flip"
            ref={(el) => {
              if (el) slotRefs.current.set(c.id, el);
              else slotRefs.current.delete(c.id);
            }}
          >
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
