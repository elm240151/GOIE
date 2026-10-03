// 座位：头像+名字、手牌数、角色名、掉线标、回合高亮+倒计时、本轮打出的牌（常驻至轮末）、过牌气泡。
import { useEffect, useState } from 'react';
import { getRole, type GameSnapshot } from '@gdys/shared';
import { useStore } from '../store';
import { STR, TURN_SECONDS } from '../strings';
import ComboBadge from './ComboBadge';

interface Props {
  player: GameSnapshot['players'][number];
  isMe: boolean;
  /** 剩余秒数（仅轮到该座位时显示） */
  turnLeft?: number | null;
}

export default function PlayerSeat({ player, isMe, turnLeft }: Props) {
  const snap = useStore((s) => s.snap);
  const passedAt = useStore((s) => s.passedAt);
  const roundPlays = useStore((s) => s.roundPlays);
  const isTurn = snap?.turnPlayerId === player.id && snap?.phase === 'playing';
  const role = getRole(player.roleId);
  const [now, setNow] = useState(Date.now());

  // 过牌气泡 2.5s 后消失
  const passedTs = passedAt[player.id];
  useEffect(() => {
    if (!passedTs) return;
    const t = setTimeout(() => setNow(Date.now()), 2600);
    return () => clearTimeout(t);
  }, [passedTs]);
  const showPassed = passedTs !== undefined && now - passedTs < 2500;

  // 本轮打出的牌：在打出者面前保持到轮末（轮末进弃牌堆）
  const roundPlay = roundPlays[player.id];

  return (
    <div className={`seat ${isTurn ? 'seat-turn' : ''} ${isMe ? 'seat-me' : ''} ${player.eliminated ? 'seat-eliminated' : ''}`}>
      <div className="seat-avatar">
        {player.eliminated ? '✕' : player.name.slice(0, 1)}
        {isTurn && turnLeft !== null && turnLeft !== undefined && (
          <span className={`seat-countdown ${turnLeft <= 5 ? 'seat-countdown-urgent' : ''}`}>{turnLeft}s</span>
        )}
      </div>
      <div className="seat-name">
        {player.name}
        {isMe && <em className="seat-you">{STR.room.you}</em>}
      </div>
      <div className="seat-meta">
        <span className="seat-role">{role?.name ?? '?'}</span>
        <span className="seat-handcount">×{player.handCount}</span>
        {snap?.cursedPlayerIds.includes(player.id) && <span className="seat-curse">{STR.game.curseBadge}</span>}
        {player.eliminated && <span className="seat-offline">{STR.game.eliminated}</span>}
        {!player.connected && !player.eliminated && <span className="seat-offline">{STR.room.offlineBadge}</span>}
      </div>
      {/* 牌背堆：直观显示手牌张数（最多叠 8 张，其余看 ×N） */}
      {!player.eliminated && player.handCount > 0 && (
        <div className="seat-cards" title={`${player.name} 手牌 ${player.handCount} 张`}>
          {Array.from({ length: Math.min(player.handCount, 8) }, (_, i) => (
            <span key={i} className="seat-cardback" />
          ))}
        </div>
      )}
      {/* 本轮打出的牌：常驻显示到轮末 */}
      {roundPlay && (
        <div className="seat-play">
          <ComboBadge combo={roundPlay} small />
        </div>
      )}
      <div className="seat-bubble">
        {showPassed && <span className="seat-passed">{STR.game.passed}</span>}
      </div>
    </div>
  );
}
