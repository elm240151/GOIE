// 本回合出牌记录条：按时间序展示本回合内每一手牌（谁出的 + 牌型徽章），
// 回合结束统一进弃牌堆时清空；最新一手金框高亮并自动滚入视野。
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { STR } from '../strings';
import ComboBadge from './ComboBadge';

export default function RoundHistory() {
  const log = useStore((s) => s.roundPlayLog);
  const players = useStore((s) => s.snap?.players) ?? [];
  const ref = useRef<HTMLDivElement>(null);

  // 新一手出现 → 滚到最右（最新）
  useEffect(() => {
    const el = ref.current;
    if (!el || log.length === 0) return;
    el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [log.length]);

  return (
    <div className="round-history" ref={ref} title={STR.game.roundHistoryTitle}>
      {log.length === 0 && <span className="round-history-empty">{STR.game.roundHistoryEmpty}</span>}
      {log.map((entry, i) => {
        const name = players.find((p) => p.id === entry.playerId)?.name ?? STR.game.opponentFallback;
        const latest = i === log.length - 1;
        return (
          <div
            key={entry.combo.cards[0]!.id}
            className={`round-history-item ${latest ? 'round-history-latest' : ''}`}
          >
            <span className="round-history-name">{name}</span>
            <ComboBadge combo={entry.combo} small />
          </div>
        );
      })}
    </div>
  );
}
