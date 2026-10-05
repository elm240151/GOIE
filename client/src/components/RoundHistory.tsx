// 本回合出牌记录：按时间序展示本回合内每一手牌（谁出的 + 牌型徽章），
// 回合结束统一进弃牌堆时清空；最新一手金框高亮并自动滚入视野。
// 两种形态共用同一数据：横条（移动端牌桌顶部）与侧条（≥1000px 桌面端右侧竖排）。
import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { STR } from '../strings';
import ComboBadge from './ComboBadge';

interface Props {
  /** 'strip' = 移动端顶部横条；'side' = 桌面端右侧竖条 */
  variant?: 'strip' | 'side';
}

export default function RoundHistory({ variant = 'strip' }: Props) {
  const log = useStore((s) => s.roundPlayLog);
  const players = useStore((s) => s.snap?.players) ?? [];
  const ref = useRef<HTMLDivElement>(null);
  const side = variant === 'side';

  // 新一手出现 → 滚到最新（横条滚到最右、侧条滚到底）
  useEffect(() => {
    const el = ref.current;
    if (!el || log.length === 0) return;
    if (side) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [log.length, side]);

  return (
    <div className={`round-history ${side ? 'round-history-side' : ''}`} ref={ref} title={STR.game.roundHistoryTitle}>
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
