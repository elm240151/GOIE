// 游戏桌：对手座位 + 中央牌区 + 手牌扇形点选 + 实时牌型预览 + 终局弹窗。
import { useEffect, useMemo, useState } from 'react';
import { defaultRules, getRole, parseCombo, rankLabel, validateFlipResponse, type Card as CardT } from '@gdys/shared';
import { useStore } from '../store';
import { STR, TURN_SECONDS } from '../strings';
import { beatReason, finishHint, invalidReason } from '../beatHint';
import Card from '../components/Card';
import ComboBadge from '../components/ComboBadge';
import Hand from '../components/Hand';
import PlayerSeat from '../components/PlayerSeat';
import SkillAskModal from '../components/SkillAskModal';
import Toast from '../components/Toast';

export default function GameTable() {
  const room = useStore((s) => s.room);
  const snap = useStore((s) => s.snap);
  const myId = useStore((s) => s.myId);
  const connected = useStore((s) => s.connected);
  const selectedCardIds = useStore((s) => s.selectedCardIds);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const play = useStore((s) => s.play);
  const pass = useStore((s) => s.pass);
  const rematch = useStore((s) => s.rematch);
  const leaveRoom = useStore((s) => s.leaveRoom);
  const tablePlayerId = useStore((s) => s.tablePlayerId);
  const tableSideCards = useStore((s) => s.tableSideCards);
  const useSkillAction = useStore((s) => s.useSkillAction);
  const revealed = useStore((s) => s.revealed);
  const roundPlays = useStore((s) => s.roundPlays);
  const handOrder = useStore((s) => s.handOrder);
  const organize = useStore((s) => s.organize);
  const toggleOrganize = useStore((s) => s.toggleOrganize);
  const sortHand = useStore((s) => s.sortHand);
  const swapHand = useStore((s) => s.swapHand);
  const clearSelection = useStore((s) => s.clearSelection);
  const toast = useStore((s) => s.toast);
  const enteredCardIds = useStore((s) => s.enteredCardIds);
  const flippedCardId = useStore((s) => s.flippedCardId);
  const toggleFlipSelect = useStore((s) => s.toggleFlipSelect);
  const peekedHand = useStore((s) => s.peekedHand);
  const closePeek = useStore((s) => s.closePeek);

  // 回合倒计时（以快照的 turnPlayerId 变化为基准）
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (snap?.turnPlayerId) {
      setDeadline(Date.now() + TURN_SECONDS * 1000);
      setNow(Date.now());
    }
  }, [snap?.turnPlayerId, snap?.phase]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const turnLeft = deadline > 0 ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;

  const players = snap?.players ?? [];
  const me = players.find((p) => p.id === myId);
  const opponents = players.filter((p) => p.id !== myId);
  const myTurn = snap?.phase === 'playing' && snap?.turnPlayerId === myId;
  const myHand: readonly CardT[] = me?.hand ?? [];
  const myPlay = myId ? roundPlays[myId] : undefined;
  const myRole = getRole(me?.roleId ?? '');
  const finished = room?.phase === 'finished';

  // 实时预览：所选牌 → parseCombo（与服务端同一套解析器；倒序随快照；单王按角色解锁）；
  // 端庄（轴承）翻面选中时走翻面接牌校验（与服务端同一套 validateFlipResponse）
  const rev = snap?.orderReversed ?? false;
  const canFlip = myTurn && !finished && !!myRole?.canFlipResponse && snap?.table !== null;
  const preview = useMemo(() => {
    const selected = myHand.filter((c) => selectedCardIds.includes(c.id));
    if (flippedCardId != null && snap?.table) {
      if (selected.length === 0) return { selected, combo: null, hint: STR.game.flipPickCards };
      const res = validateFlipResponse(
        snap.table,
        snap.prevTable ?? null,
        flippedCardId,
        selected,
        defaultRules,
        rev,
        myRole?.soloJoker
      );
      if (!res.ok) return { selected, combo: null, hint: res.reason };
      return { selected, combo: res.combo, hint: null };
    }
    if (selected.length === 0) return { selected, combo: null, hint: null };
    const combo = parseCombo(selected, defaultRules, rev, myRole?.soloJoker);
    if (!combo) return { selected, combo: null, hint: invalidReason(selected) };
    const finish = finishHint(combo, myHand.length, rev);
    const warn = finish ?? beatReason(combo, snap?.table ?? null, rev);
    return { selected, combo, hint: warn ? STR.game.beatWarn.replace('{hint}', warn) : null };
  }, [myHand, selectedCardIds, flippedCardId, snap?.table, snap?.prevTable, rev, myRole]);

  // 答疑改点：桌面牌型标签已按新点数重写（金色主显），小标展示原牌型（按实体牌重解析）
  const originalTableLabel =
    snap?.tableRankNote && snap?.table ? (parseCombo(snap.table.cards, defaultRules, rev)?.label ?? '') : '';

  const isLeader = snap?.table === null;
  const turnPlayer = snap?.turnPlayerId ? players.find((p) => p.id === snap.turnPlayerId) : null;
  const tableOwner = snap?.table ? players.find((p) => p.id === tablePlayerId) : null;

  // 主动技按钮（角色声明 skillActions，通用渲染）
  const skillActions = useMemo(() => {
    if (!me || finished) return [];
    return (getRole(me.roleId)?.skillActions ?? []).filter((a) =>
      a.when === 'myTurn' ? myTurn : myTurn && snap?.table !== null
    );
  }, [me, finished, myTurn, snap?.table]);

  // 我的技能说明（点开可读；当前可发动的高亮）
  const activeSkillIds = useMemo(() => new Set(skillActions.map((a) => a.skillId)), [skillActions]);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  // 整理手牌模式：点第一张选中，点第二张交换
  const [organizeSel, setOrganizeSel] = useState<number | null>(null);
  const onOrganizeTap = (cardId: number) => {
    if (organizeSel === null) setOrganizeSel(cardId);
    else if (organizeSel === cardId) setOrganizeSel(null);
    else {
      swapHand(organizeSel, cardId);
      setOrganizeSel(null);
    }
  };

  // 过按钮防误触：已选牌时第一次点过只清选牌，3s 内再点才真正过牌
  const [passArmed, setPassArmed] = useState(false);
  useEffect(() => {
    if (!passArmed) return;
    const t = setTimeout(() => setPassArmed(false), 3000);
    return () => clearTimeout(t);
  }, [passArmed]);
  // 语境变化（换回合/桌面变化/新询问/开整理）→ 立即解除
  useEffect(() => {
    setPassArmed(false);
  }, [snap?.turnPlayerId, snap?.table, snap?.pendingAsk?.askId, snap?.phase, organize]);
  // 重新选牌 → 解除（杜绝"选好牌后误点一次就过"）
  useEffect(() => {
    if (selectedCardIds.length > 0) setPassArmed(false);
  }, [selectedCardIds]);
  const onPassClick = () => {
    if (passArmed && selectedCardIds.length === 0) {
      setPassArmed(false);
      void pass();
      return;
    }
    if (selectedCardIds.length > 0) {
      clearSelection();
      setPassArmed(true);
      toast('info', STR.game.passAgain);
      return;
    }
    void pass();
  };

  return (
    <div className="screen game">
      <Toast />

      <header className="game-top">
        <button className="btn btn-ghost" onClick={leaveRoom}>
          {STR.game.leave}
        </button>
        <span className="game-code">{room?.code ?? ''}</span>
        <span className="game-counts">
          <em>{STR.game.discard.replace('{n}', String(snap?.discardCount ?? 0))}</em>
        </span>
      </header>

      <div className="game-opponents">
        {opponents.map((p) => (
          <PlayerSeat
            key={p.id}
            player={p}
            isMe={false}
            turnLeft={snap?.turnPlayerId === p.id ? turnLeft : null}
          />
        ))}
      </div>

      <div className="game-table">
        {/* 中央牌堆：卡背叠（5 张封顶）+ 张数；顶部牌背随张数变化脉冲（摸牌反馈） */}
        {!finished && (
          <div className="deck-zone" title={STR.game.deckLeft.replace('{n}', String(snap?.deckCount ?? 0))}>
            <div className="deck-stack">
              {(snap?.deckCount ?? 0) > 0 ? (
                Array.from({ length: Math.min(snap?.deckCount ?? 0, 5) }, (_, i) => (
                  <span
                    key={i === 0 ? `top-${snap?.deckCount ?? 0}` : `under-${i}`}
                    className={`deck-back${i === 0 ? ' deck-back-top' : ''}`}
                  />
                ))
              ) : (
                <span className="deck-back deck-back-empty" />
              )}
            </div>
            <em className="deck-count">{STR.game.deckLeft.replace('{n}', String(snap?.deckCount ?? 0))}</em>
          </div>
        )}

        {snap?.table ? (
          <>
            <div className="table-owner">{tableOwner ? `${tableOwner.name} 出了` : '上一手'}</div>
            <div className="table-row">
              <ComboBadge
                combo={snap.table}
                retagged={!!snap.tableRankNote}
                onCardClick={canFlip ? toggleFlipSelect : undefined}
                flippedCardId={canFlip ? flippedCardId : null}
              />
              {snap.tableRankNote && (
                <span className="retag-badge" title={STR.game.retagTitle}>
                  {STR.game.retagFrom.replace('{label}', originalTableLabel)}
                </span>
              )}
              {tableSideCards.length > 0 && (
                <div className="table-side">
                  {tableSideCards.map((c) => (
                    <Card key={c.id} card={c} faceDown={(snap?.tableSideHidden ?? []).includes(c.id)} />
                  ))}
                </div>
              )}
            </div>
            {canFlip && (
              <div className="flip-hint">
                {flippedCardId != null
                  ? STR.game.flipPicked.replace(
                      '{label}',
                      rankLabel(snap.table.cards.find((c) => c.id === flippedCardId)!.rank)
                    )
                  : STR.game.flipHint}
              </div>
            )}
          </>
        ) : (
          <div className="table-empty">{finished ? '' : STR.game.tableEmpty}</div>
        )}
        {!finished && rev && (
          <div className="order-badge" title="海棠洄游：整条牌序反转中">{STR.game.orderReversed}</div>
        )}
        <div className={`table-turn ${myTurn ? 'table-turn-me' : ''}`}>
          {finished
            ? ''
            : myTurn
              ? STR.game.yourTurn
              : turnPlayer
                ? STR.game.turnOf.replace('{name}', turnPlayer.name)
                : STR.game.waiting}
        </div>

        {/* 公开判定/展示牌：所有玩家可见，逐张亮出（张数封顶，避免亮全手牌时挤爆桌面） */}
        {revealed && revealed.cards.length > 0 && (
          <div className="reveal-panel">
            <span className="reveal-label">
              {STR.game.revealPanel.replace('{purpose}', revealed.purpose)}
              {revealed.cards.length > 12 && (
                <em className="reveal-more">（共 {revealed.cards.length} 张）</em>
              )}
            </span>
            <div className="reveal-cards">
              {revealed.cards.slice(0, 12).map((c, i) => (
                <div key={c.id} className="reveal-slot" style={{ animationDelay: `${Math.min(i, 6) * 0.4}s` }}>
                  <Card card={c} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="game-bottom">
        <div className="my-bar">
          <span className="my-name">
            {me?.name}
            <em className="tag">{getRole(me?.roleId ?? '')?.name ?? ''}</em>
          </span>
          <span className="my-handcount">
            ×{me?.handCount ?? 0}/{defaultRules.hand.limit}
          </span>
          {myPlay && (
            <span className="my-play">
              <ComboBadge combo={myPlay} small />
            </span>
          )}
          {myTurn && turnLeft !== null && (
            <span className={`my-countdown ${turnLeft <= 5 ? 'urgent' : ''}`}>⏱ {turnLeft}s</span>
          )}
        </div>

        {/* 我的技能：写在角色边上，可点开阅读；可发动时高亮 */}
        {myRole && myRole.skills.length > 0 && (
          <div className="my-skills">
            {myRole.skills.map((s) => {
              const active = !finished && activeSkillIds.has(s.id);
              const expanded = expandedSkill === s.id;
              return (
                <div key={s.id} className={`my-skill ${active ? 'my-skill-active' : ''}`}>
                  <button
                    type="button"
                    className="my-skill-chip"
                    onClick={() => setExpandedSkill(expanded ? null : s.id)}
                  >
                    【{s.name}】
                    {active && <em className="my-skill-ready">{STR.game.skillReady}</em>}
                    {s.locked && <em className="my-skill-locked">{STR.room.lockedSkill}</em>}
                  </button>
                  {expanded && <div className="my-skill-desc">{s.description}</div>}
                </div>
              );
            })}
          </div>
        )}

        <div className="preview-bar">
          {preview.combo ? (
            <>
              <ComboBadge combo={preview.combo} small />
              {preview.hint && <span className="preview-warn">{preview.hint}</span>}
            </>
          ) : preview.hint ? (
            <span className="preview-error">{preview.hint}</span>
          ) : (
            <span className="preview-empty">{myTurn ? '点选手牌（王可补缺）' : ''}</span>
          )}
        </div>

        {/* 整理手牌：开关 + 快捷排序 */}
        <div className="organize-bar">
          <button
            type="button"
            className={`btn btn-ghost btn-small ${organize ? 'organize-on' : ''}`}
            onClick={() => {
              setOrganizeSel(null);
              toggleOrganize();
            }}
          >
            🃏{STR.game.organize}
          </button>
          {organize && (
            <>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => sortHand('rank')}>
                {STR.game.sortRank}
              </button>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => sortHand('suit')}>
                {STR.game.sortSuit}
              </button>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => sortHand('color')}>
                {STR.game.sortColor}
              </button>
              <span className="organize-hint">{STR.game.organizeHint}</span>
            </>
          )}
        </div>

        <Hand
          cards={myHand}
          order={handOrder}
          selectedIds={organize && organizeSel !== null ? [organizeSel] : selectedCardIds}
          onToggle={myTurn && !finished ? (organize ? onOrganizeTap : toggleSelect) : undefined}
          enteredIds={enteredCardIds}
        />

        <div className="game-actions">
          <button
            className="btn btn-primary btn-big"
            disabled={!myTurn || finished || !preview.combo}
            onClick={() => void play()}
          >
            {STR.game.play}
          </button>
          <button
            className={`btn btn-big ${passArmed ? 'btn-warn' : 'btn-secondary'}`}
            disabled={!myTurn || finished || isLeader}
            onClick={onPassClick}
          >
            {isLeader ? STR.game.cannotPassLeader : passArmed ? STR.game.passConfirm : STR.game.pass}
          </button>
        </div>

        {skillActions.length > 0 && (
          <div className="skill-actions">
            {skillActions.map((a) => (
              <button key={a.skillId} className="btn btn-gold" onClick={() => void useSkillAction(a.skillId)}>
                ⚡{a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <SkillAskModal />

      {finished && room && <FinishedModal />}

      {peekedHand && <PeekModal />}

      {!connected && (
        <div className="reconnect-overlay">
          <div className="reconnect-box">{STR.game.reconnect}</div>
        </div>
      )}
    </div>
  );
}

/** 窃笑（轴承）：私密查看目标手牌的弹窗（服务端定向发我，其余人不可见） */
function PeekModal() {
  const peekedHand = useStore((s) => s.peekedHand)!;
  const snap = useStore((s) => s.snap);
  const closePeek = useStore((s) => s.closePeek);
  const targetName = snap?.players.find((p) => p.id === peekedHand.targetId)?.name ?? '对方';
  return (
    <div className="modal-overlay" onClick={closePeek}>
      <div className="modal peek-modal" onClick={(ev) => ev.stopPropagation()}>
        <h2 className="peek-title">{STR.game.peekTitle.replace('{name}', targetName)}</h2>
        <div className="peek-cards">
          {peekedHand.cards.map((c) => (
            <Card key={c.id} card={c} />
          ))}
        </div>
        <button type="button" className="btn btn-primary" onClick={closePeek}>
          {STR.game.peekClose}
        </button>
      </div>
    </div>
  );
}

/** 终局弹窗：胜负 + 记分表 + 再来一局投票 */
function FinishedModal() {
  const room = useStore((s) => s.room)!;
  const myId = useStore((s) => s.myId);
  const rematch = useStore((s) => s.rematch);
  const leaveRoom = useStore((s) => s.leaveRoom);
  const winner = room.players.find((p) => p.id === room.winnerId);
  const voted = room.rematchVotes.includes(myId);
  const votedCount = room.rematchVotes.length;
  const total = room.players.length;

  return (
    <div className="modal-overlay">
      <div className="modal finish-modal">
        <h2 className={winner ? 'finish-win' : 'finish-draw'}>
          {winner ? STR.game.winnerTitle.replace('{name}', winner.name) : STR.game.drawTitle}
        </h2>
        <h3>{STR.game.scoreTitle}</h3>
        <table className="score-table">
          <thead>
            <tr>
              <th>{STR.scoreboard.players}</th>
              <th>±</th>
              <th>{STR.game.totalLabel}</th>
            </tr>
          </thead>
          <tbody>
            {room.players.map((p) => (
              <tr key={p.id} className={p.id === room.winnerId ? 'score-row-winner' : ''}>
                <td>
                  {p.name}
                  <em className="score-role">{getRole(p.roleId)?.name ?? ''}</em>
                </td>
                <td className={p.id === room.winnerId ? 'score-plus' : 'score-minus'}>
                  {room.scoreDeltas?.[p.id] ?? 0}
                </td>
                <td>{room.totals[p.id] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="finish-actions">
          <button className="btn btn-primary btn-big" disabled={voted} onClick={() => void rematch()}>
            {voted ? STR.game.rematchVoted.replace('{voted}', String(votedCount)).replace('{total}', String(total)) : STR.game.rematch}
          </button>
          <button className="btn btn-ghost" onClick={leaveRoom}>
            {STR.game.leaveRoom}
          </button>
        </div>
        {votedCount > 0 && !voted && (
          <p className="finish-votes">
            {STR.game.rematchWaiting.replace('{voted}', String(votedCount)).replace('{total}', String(total))}
          </p>
        )}
      </div>
    </div>
  );
}
