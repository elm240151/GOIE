// 侧栏对局信息（仅 ≥1000px 桌面端显示；移动端 CSS display:none，DOM 复用不做双渲染）。
// 全部数据来自服务端快照 + 客户端 tablePlayerId，零判定。
import { useStore } from '../store';
import { STR } from '../strings';
import ComboBadge from './ComboBadge';

export default function RoundInfo() {
  const snap = useStore((s) => s.snap);
  const room = useStore((s) => s.room);
  const tablePlayerId = useStore((s) => s.tablePlayerId);
  if (!snap) return null;
  const players = snap.players;
  const finished = room?.phase === 'finished';
  const turnPlayer = snap.turnPlayerId ? players.find((p) => p.id === snap.turnPlayerId) : null;
  const owner = snap.table ? players.find((p) => p.id === tablePlayerId) : null;
  return (
    <section className="side-round">
      <h3 className="side-round-title">{STR.game.sideInfo}</h3>
      <ul className="side-info">
        <li className={snap.orderReversed ? 'side-order-rev' : ''}>
          {STR.game.sideOrder}
          {snap.orderReversed ? STR.game.orderReversed : STR.game.sideNormal}
        </li>
        <li>
          {STR.game.deckLeft.replace('{n}', String(snap.deckCount))} ·{' '}
          {STR.game.discard.replace('{n}', String(snap.discardCount))}
        </li>
        <li>
          {finished
            ? STR.game.sideGameOver
            : turnPlayer
              ? STR.game.sideTurn.replace('{name}', turnPlayer.name)
              : STR.game.waiting}
        </li>
        <li>
          {owner
            ? STR.game.sideTableOwner.replace('{name}', owner.name)
            : finished
              ? STR.game.sideGameOver
              : STR.game.tableEmpty}
        </li>
        {snap.prevTable && (
          <li className="side-prev">
            <span className="side-prev-label">{STR.game.prevTable}</span>
            <ComboBadge combo={snap.prevTable} small />
          </li>
        )}
      </ul>
    </section>
  );
}
