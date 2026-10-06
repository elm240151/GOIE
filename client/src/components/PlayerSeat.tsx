// 座位：头像+名字、手牌数/上限、角色名、起牌标、询问中、诅咒两级标、掉线标、
// 回合高亮+倒计时、过牌气泡；title 展示上/下家方位（倒序互换）；
// 可点击（onView）弹角色技能查看（「别人的技能也能看到」）。
import { useEffect, useMemo, useState } from 'react';
import { getRole, type GameSnapshot } from '@gdys/shared';
import { handLimitOf, useStore } from '../store';
import { STR } from '../strings';

interface Props {
  player: GameSnapshot['players'][number];
  isMe: boolean;
  /** 剩余秒数（仅轮到该座位时显示） */
  turnLeft?: number | null;
  /** 点击座位查看该玩家的角色技能（缺省不可点） */
  onView?: () => void;
}

export default function PlayerSeat({ player, isMe, turnLeft, onView }: Props) {
  const snap = useStore((s) => s.snap);
  const passedAt = useStore((s) => s.passedAt);
  const myId = useStore((s) => s.myId);
  const curseActiveIds = useStore((s) => s.curseActiveIds);
  const isTurn = snap?.turnPlayerId === player.id && snap?.phase === 'playing';
  const role = getRole(player.roleId);

  // 过牌气泡两阶段：入场弹起 → 2.2s 淡出 → 2.6s 卸载
  const passedTs = passedAt[player.id];
  const [passedPhase, setPassedPhase] = useState<'in' | 'out' | 'gone'>('gone');
  useEffect(() => {
    if (!passedTs) return;
    setPassedPhase('in');
    const t1 = setTimeout(() => setPassedPhase('out'), 2200);
    const t2 = setTimeout(() => setPassedPhase('gone'), 2600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [passedTs]);

  // 摸牌反馈：手牌数 pop + 牌背堆微弹 0.8s
  const drawnTs = useStore((s) => s.drawnAt[player.id]);
  const [drawnPop, setDrawnPop] = useState(false);
  useEffect(() => {
    if (!drawnTs) return;
    setDrawnPop(true);
    const t = setTimeout(() => setDrawnPop(false), 800);
    return () => clearTimeout(t);
  }, [drawnTs]);

  // 淘汰：座位抖动 + 红闪 1.2s（随后常驻灰态）
  const eliminatedTs = useStore((s) => s.eliminatedAt[player.id]);
  const [elimPop, setElimPop] = useState(false);
  useEffect(() => {
    if (!eliminatedTs) return;
    setElimPop(true);
    const t = setTimeout(() => setElimPop(false), 1200);
    return () => clearTimeout(t);
  }, [eliminatedTs]);

  // 尖叫（苗条）扣置：点击徽章显示悬浮提示（类型 + 张数，牌面不可见），2.5s 自隐
  const [heldTip, setHeldTip] = useState(false);
  useEffect(() => {
    if (!heldTip) return;
    const t = setTimeout(() => setHeldTip(false), 2500);
    return () => clearTimeout(t);
  }, [heldTip]);

  // 方位（按席位序 ±1 计上家/下家，倒序互换；2 人局互为上下家，其余「对面」）
  const directionTitle = useMemo(() => {
    if (!snap) return undefined;
    const list = snap.players;
    if (list.length < 3) return STR.game.seatAdjacent;
    const mi = list.findIndex((p) => p.id === myId);
    const pi = list.findIndex((p) => p.id === player.id);
    if (mi < 0 || pi < 0) return undefined;
    const d = (pi - mi + list.length) % list.length;
    if (d === 1) return snap.orderReversed ? STR.game.seatPrev : STR.game.seatNext;
    if (d === list.length - 1) return snap.orderReversed ? STR.game.seatNext : STR.game.seatPrev;
    return STR.game.seatAcross;
  }, [snap, myId, player.id]);

  const isLeader = snap?.roundLeaderId === player.id && snap?.phase === 'playing' && !player.eliminated;
  const isAsked = snap?.pendingAsk?.playerId === player.id;
  // 诅咒两级标：本回合生效实标、下一轮生效半透明（基线区分逻辑见 store.applySnapshot）
  const curseActive = !player.eliminated && curseActiveIds.includes(player.id);
  const cursePending =
    !player.eliminated && !curseActive && (snap?.cursedPlayerIds.includes(player.id) ?? false);
  const title = onView ? [directionTitle, STR.game.viewSkills].filter(Boolean).join('｜') : directionTitle;

  return (
    <div
      className={`seat ${isTurn ? 'seat-turn' : ''} ${isMe ? 'seat-me' : ''} ${player.eliminated ? 'seat-eliminated' : ''} ${elimPop ? 'seat-shake' : ''} ${onView ? 'seat-clickable' : ''}`}
      title={title}
      onClick={onView}
    >
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
        <span className="seat-role">{role?.name ?? STR.game.seatRoleUnknown}</span>
        <span className={`seat-handcount ${drawnPop ? 'seat-handcount-pop' : ''}`}>
          {player.handCount >= 0 ? `×${player.handCount}/${handLimitOf(player.roleId)}` : `×${STR.game.handUnknown}`}
        </span>
        {isLeader && <span className="seat-leader">{STR.game.seatLeader}</span>}
        {isAsked && <span className="seat-asking">{STR.game.seatAsking}</span>}
        {curseActive && (
          <span className="seat-curse" title={STR.game.curseActiveTitle}>
            {STR.game.curseBadge}
          </span>
        )}
        {cursePending && (
          <span className="seat-curse seat-curse-pending" title={STR.game.cursePendingTitle}>
            {STR.game.curseBadge}
          </span>
        )}
        {!player.eliminated && (snap?.roundBannedIds.includes(player.id) ?? false) && (
          <span className="seat-curse seat-jianxi" title={STR.game.jianxiTitle}>
            {STR.game.jianxiBadge}
          </span>
        )}
        {player.pancakeCount > 0 && (
          <span className="seat-pancake" title={STR.game.pancakeTitle}>
            {STR.game.pancakeBadge.replace('{n}', String(player.pancakeCount))}
          </span>
        )}
        {!player.eliminated && player.heldCount > 0 && (
          <span
            className="seat-held"
            title={STR.game.heldBadge}
            onClick={(ev) => {
              ev.stopPropagation();
              setHeldTip((v) => !v);
            }}
          >
            🪧×{player.heldCount}
          </span>
        )}
        {player.eliminated && <span className="seat-offline">{STR.game.eliminated}</span>}
        {!player.connected && !player.eliminated && <span className="seat-offline">{STR.room.offlineBadge}</span>}
      </div>
      {/* 牌背堆：直观显示手牌张数（最多叠 8 张，其余看 ×N；辛歼神秘手牌数 -1 不显示） */}
      {!player.eliminated && player.handCount > 0 && (
        <div
          className={`seat-cards ${drawnPop ? 'seat-cards-pop' : ''}`}
          title={STR.game.seatHandTitle.replace('{name}', player.name).replace('{n}', String(player.handCount))}
        >
          {Array.from({ length: Math.min(player.handCount, 8) }, (_, i) => (
            <span key={i} className="seat-cardback" />
          ))}
        </div>
      )}
      <div className="seat-bubble">
        {passedPhase !== 'gone' && (
          <span className={`seat-passed ${passedPhase === 'out' ? 'seat-passed-out' : ''}`}>{STR.game.passed}</span>
        )}
        {heldTip && (
          <span className="seat-held-tip">
            <b>{STR.game.heldTipTitle.replace('{name}', player.name)}</b>
            {player.heldGroups.map((g, i) => (
              <em key={i}>
                {STR.game.heldGroupLine
                  .replace('{kind}', g.kind === 'fanwen' ? STR.game.heldFanwen : STR.game.heldJianjiaoji)
                  .replace('{n}', String(g.count))}
              </em>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
