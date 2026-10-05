// 公开判定/展示牌面板：逐张亮出入场；store 清空时先播 0.4s 淡出再卸载（scheduleRevealClear 不动）。
import { useEffect, useState } from 'react';
import type { Card as CardT } from '@gdys/shared';
import { STR } from '../strings';
import Card from './Card';

interface Props {
  revealed: { cards: CardT[]; purpose: string } | null;
}

export default function RevealPanel({ revealed }: Props) {
  // last：退场期间继续渲染的内容；closing：淡出中
  const [last, setLast] = useState(revealed);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (revealed) {
      setLast(revealed);
      setClosing(false);
      return;
    }
    if (!last) return;
    setClosing(true);
    const t = setTimeout(() => {
      setLast(null);
      setClosing(false);
    }, 420);
    return () => clearTimeout(t);
  }, [revealed]);

  if (!last || last.cards.length === 0) return null;
  return (
    <div className={`reveal-panel ${closing ? 'reveal-closing' : ''}`}>
      <span className="reveal-label">
        {STR.game.revealPanel.replace('{purpose}', last.purpose)}
        {last.cards.length > 12 && (
          <em className="reveal-more">{STR.game.revealedMore.replace('{n}', String(last.cards.length))}</em>
        )}
      </span>
      <div className="reveal-cards">
        {last.cards.slice(0, 12).map((c, i) => (
          <div key={c.id} className="reveal-slot" style={{ animationDelay: `${Math.min(i, 6) * 0.4}s` }}>
            <Card card={c} />
          </div>
        ))}
      </div>
    </div>
  );
}
