// 游戏桌：对手座位 + 中央牌区 + 手牌扇形点选 + 实时牌型预览 + 终局弹窗。
import { useEffect, useMemo, useRef, useState } from 'react';
import { defaultRules, getRole, isJoker, ouYaCovers, parseCombo, rankLabel, validateFlipResponse, type Card as CardT, type Combo, type Rank } from '@gdys/shared';
import { handLimitOf, useStore } from '../store';
import { STR, TURN_SECONDS } from '../strings';
import { beatReason, finishHint, invalidReason } from '../beatHint';
import Banner from '../components/Banner';
import Card from '../components/Card';
import ComboBadge from '../components/ComboBadge';
import Hand from '../components/Hand';
import PlayerSeat from '../components/PlayerSeat';
import RevealPanel from '../components/RevealPanel';
import RoundHistory from '../components/RoundHistory';
import SkillAskModal from '../components/SkillAskModal';
import Toast from '../components/Toast';

/** 按解析顺序还原一手牌的实体牌面（王标出所当点数，与 ComboBadge 同口径）——中央暂存区用真实牌面展示 */
function comboFaces(combo: Combo): { card: CardT; asRank?: Rank }[] {
  return combo.resolved.map((r) => {
    const c = combo.cards.find((x) => x.id === r.cardId)!;
    return isJoker(c) ? { card: c, asRank: r.rank as Rank } : { card: c };
  });
}

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
  const stagedDiscards = useStore((s) => s.stagedDiscards);
  const useSkillAction = useStore((s) => s.useSkillAction);
  const revealed = useStore((s) => s.revealed);
  const roundPlayLog = useStore((s) => s.roundPlayLog);
  const judgedCards = useStore((s) => s.judgedCards);
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
  const turnSeq = useStore((s) => s.turnSeq);

  // 回合倒计时（以 turnSeq 为基准：同一玩家连续两轮持牌权也会重置；无轮次/终局清零）
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now());

  // 尖叫（苗条）：查看扣置牌弹窗（点手牌上方的扣置牌背堆打开）
  const [heldViewOpen, setHeldViewOpen] = useState(false);

  // 我被淘汰：底部操作区抖动 1.2s
  const myElimTs = useStore((s) => (myId ? s.eliminatedAt[myId] : undefined));
  const [myElimPop, setMyElimPop] = useState(false);
  useEffect(() => {
    if (!myElimTs) return;
    setMyElimPop(true);
    const t = setTimeout(() => setMyElimPop(false), 1200);
    return () => clearTimeout(t);
  }, [myElimTs]);
  useEffect(() => {
    if (snap?.phase === 'playing' && snap?.turnPlayerId) {
      setDeadline(Date.now() + TURN_SECONDS * 1000);
      setNow(Date.now());
    } else {
      setDeadline(0);
    }
  }, [snap?.turnPlayerId, snap?.phase, turnSeq]);
  // 只在有倒计时时运行 interval（无轮次零定时器零重渲染）
  useEffect(() => {
    if (!deadline) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [deadline]);
  const turnLeft = deadline > 0 ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;

  const players = snap?.players ?? [];
  const me = players.find((p) => p.id === myId);
  const opponents = players.filter((p) => p.id !== myId);
  const myTurn = snap?.phase === 'playing' && snap?.turnPlayerId === myId;
  const myHand: readonly CardT[] = me?.hand ?? [];
  const myRole = getRole(me?.roleId ?? '');
  const finished = room?.phase === 'finished';

  // 中央暂存区（线下打牌感）：本回合所有打过的牌（含刚出的当前一手）+ 判定牌；
  // 回合结束统一弃置（roundPlayLog/judgedCards 随 round:ended 清空）；
  // 重连首快照日志为空时补当前桌面一手（谁出的由出牌记录条展示，暂存区不标名字）
  const pileEntries =
    snap?.table && roundPlayLog.length === 0
      ? [{ playerId: tablePlayerId ?? '', combo: snap.table }]
      : roundPlayLog;

  // 暂存区新增牌时滚到最底（新打的牌在摊开区的末尾，超高一屏时可滚动）
  const pileRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pileRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [pileEntries.length, judgedCards.length]);

  // 实时预览：所选牌 → parseCombo（与服务端同一套解析器；倒序随快照；单王按角色解锁）；
  // 端庄（轴承）翻面选中时走翻面接牌校验（与服务端同一套 validateFlipResponse）
  const rev = snap?.orderReversed ?? false;
  const canFlip = myTurn && !finished && !!myRole?.canFlipResponse && snap?.table !== null;
  const preview = useMemo((): {
    selected: readonly CardT[];
    combo: ReturnType<typeof parseCombo>;
    hint: string | null;
    ouYa?: boolean;
    pancake?: boolean;
  } => {
    const selected = myHand.filter((c) => selectedCardIds.includes(c.id));
    // 温柔（组长）：我是宝贝且桌面是组长的牌 → 不能出（服务端同口径拒绝；预览提示、出牌按钮禁用）
    const babyBlocked =
      myTurn &&
      !!snap?.table &&
      snap.babyIds.includes(myId) &&
      snap.tableOwnerId != null &&
      snap.tableOwnerId === snap.babyOwnerId;
    if (babyBlocked) return { selected, combo: null, hint: STR.game.preview.babyBlocked };
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
    // 呕哑（玊）：接牌时包含桌面全部实际点数的任意合法牌型——无视管牌规则，「压不过」不再是警告
    if (warn && !finish && myRole?.ouYa && snap?.table && ouYaCovers(combo, snap.table)) {
      return { selected, combo, hint: STR.game.ouYaHint, ouYa: true };
    }
    // 吐饼（R.F）：无牌权响应时只能打 2/3 或炸弹——恰好接上的牌请走吃饼询问（金色 = 技能提示）
    const rfRank = rev ? 3 : 15;
    if (
      myRole?.pancake &&
      snap?.table &&
      tablePlayerId !== myId &&
      combo.type !== 'bomb' &&
      !((combo.type === 'single' || combo.type === 'pair') && combo.rank === rfRank)
    ) {
      return { selected, combo, hint: STR.game.rfRestrict.replace('{rank}', rev ? '3' : '2'), pancake: true };
    }
    // 压不过但端庄可翻面 → 附翻面提示（防止没点桌面牌直接出导致「用不出」）
    const tip = warn && canFlip ? STR.game.flipSuggest : '';
    return { selected, combo, hint: warn ? STR.game.beatWarn.replace('{hint}', warn) + tip : null };
  }, [myHand, selectedCardIds, flippedCardId, snap?.table, snap?.prevTable, rev, myRole, canFlip, tablePlayerId, myTurn, myId, snap?.babyIds, snap?.babyOwnerId, snap?.tableOwnerId]);

  // 答疑改点：桌面牌型标签已按新点数重写（金色主显），小标展示原牌型（按实体牌重解析）
  const originalTableLabel =
    snap?.tableRankNote && snap?.table ? (parseCombo(snap.table.cards, defaultRules, rev)?.label ?? '') : '';

  const isLeader = snap?.table === null;
  const noPass = snap?.pancakeNoPass === true; // 吐饼（R.F）：吃过饼后轮到自己不能过
  const turnPlayer = snap?.turnPlayerId ? players.find((p) => p.id === snap.turnPlayerId) : null;

  // 主动技按钮（角色声明 skillActions，通用渲染）
  const skillActions = useMemo(() => {
    if (!me || finished) return [];
    return (getRole(me.roleId)?.skillActions ?? []).filter((a) => {
      // hidden：不在按钮行渲染（苗条查看/收回扣置牌走手牌上方扣置区弹窗）
      if (a.hidden) return false;
      // 见习/反力矩（陈正）：仅拥有牌权（起牌回合）时显示
      if (a.onlyWhenLeader && snap?.roundLeaderId !== me.id) return false;
      return a.when === 'myTurn' ? myTurn : myTurn && snap?.table !== null;
    });
  }, [me, finished, myTurn, snap?.table, snap?.roundLeaderId]);

  // 我的技能说明（点开可读；当前可发动的高亮）
  const activeSkillIds = useMemo(() => new Set(skillActions.map((a) => a.skillId)), [skillActions]);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  // 查看别人技能的弹窗（点对手座位打开）
  const [roleViewPlayer, setRoleViewPlayer] = useState<string | null>(null);

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
      <Banner />

      <header className="game-top">
        <button className="btn btn-ghost" onClick={leaveRoom}>
          {STR.game.leave}
        </button>
        <span className="game-code">{room?.code ?? ''}</span>
        <span className="game-counts">
          <em>{STR.game.discard.replace('{n}', String(snap?.discardCount ?? 0))}</em>
        </span>
      </header>

      {/* 对手座位（点击可查看其角色技能） */}
      <div className="game-opponents">
        {opponents.map((p) => (
          <PlayerSeat
            key={p.id}
            player={p}
            isMe={false}
            turnLeft={snap?.turnPlayerId === p.id ? turnLeft : null}
            onView={() => setRoleViewPlayer(p.id)}
          />
        ))}
      </div>

      <div className="game-table">
        {/* 本回合出牌记录条：每一手牌按时间序展示，回合结束统一弃置 */}
        <RoundHistory />
        {/* 中央牌堆：卡背叠（5 张封顶）+ 张数；顶部牌背随张数变化脉冲（摸牌反馈）；
            辛歼（神秘）本人另有独立牌堆/弃牌堆并排显示（只对本人可见） */}
        {!finished && (
          <div className="deck-row">
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
              <em className="deck-count deck-count-pop" key={snap?.deckCount ?? 0}>
                {STR.game.deckLeft.replace('{n}', String(snap?.deckCount ?? 0))}
              </em>
            </div>
            {(snap?.privateDeckCount != null || snap?.privateDiscardCount != null) && (
              <div className="deck-zone private-zone" title={STR.game.privateZoneTitle}>
                <div className="deck-stack">
                  {(snap?.privateDeckCount ?? 0) > 0 ? (
                    Array.from({ length: Math.min(snap?.privateDeckCount ?? 0, 5) }, (_, i) => (
                      <span
                        key={i === 0 ? `ptop-${snap?.privateDeckCount ?? 0}` : `punder-${i}`}
                        className={`deck-back${i === 0 ? ' deck-back-top' : ''}`}
                      />
                    ))
                  ) : (
                    <span className="deck-back deck-back-empty" />
                  )}
                </div>
                <em className="deck-count">{STR.game.privateDeck.replace('{n}', String(snap?.privateDeckCount ?? 0))}</em>
                <em className="deck-count">{STR.game.privateDiscard.replace('{n}', String(snap?.privateDiscardCount ?? 0))}</em>
              </div>
            )}
          </div>
        )}

        {snap?.table ? (
          <>
            {/* 中央暂存区（线下打牌感）：本回合所有打过的牌以真实牌面摊在场上——含刚出的当前一手
                （最新一手金框高亮，可点选翻面），谁出的看边上出牌记录条；回合结束统一弃置 */}
            {(pileEntries.length > 0 || judgedCards.length > 0) && (
              <div className="table-pile" ref={pileRef} title={STR.game.pileTitle}>
                {pileEntries.map((entry, i) => {
                  const latest = i === pileEntries.length - 1;
                  // 答疑改点：最新一手主显改点后的新点数 label（金色），原牌型由旁边小标展示
                  const latestRetagged = latest && !!snap.tableRankNote;
                  return (
                    <div
                      key={entry.combo.cards[0]!.id}
                      className={latest ? 'table-pile-item table-pile-item-latest' : 'table-pile-item'}
                    >
                      <div className="table-pile-cards">
                        {comboFaces(entry.combo).map((f) => (
                          <Card
                            key={f.card.id}
                            card={f.card}
                            asRank={f.asRank}
                            onClick={latest && canFlip ? () => toggleFlipSelect(f.card.id) : undefined}
                            faceDown={latest && flippedCardId === f.card.id}
                          />
                        ))}
                        {latest && tableSideCards.length > 0 && (
                          <span className="table-side">
                            {tableSideCards.map((c) => (
                              <Card key={c.id} card={c} faceDown={(snap?.tableSideHidden ?? []).includes(c.id)} />
                            ))}
                          </span>
                        )}
                      </div>
                      <span className={`table-pile-label${latestRetagged ? ' table-pile-label-retagged' : ''}`}>
                        {latestRetagged ? (snap?.table?.label ?? entry.combo.label) : entry.combo.label}
                      </span>
                      {latest && snap.tableRankNote && (
                        <span
                          className="retag-badge"
                          title={STR.game.retagTitleNote
                            .replace('{rank}', rankLabel(snap.tableRankNote.rank as Rank))
                            .replace('{label}', originalTableLabel)}
                        >
                          {STR.game.retagFrom.replace('{label}', originalTableLabel)}
                        </span>
                      )}
                    </div>
                  );
                })}
                {judgedCards.length > 0 && (
                  <div className="table-pile-judged" title={STR.game.judgedTitle}>
                    <span className="table-pile-name">{STR.game.judgedLabel}</span>
                    <div className="table-pile-cards">
                      {judgedCards.map((c) => (
                        <Card key={c.id} card={c} />
                      ))}
                    </div>
                  </div>
                )}
                {stagedDiscards.length > 0 && (
                  <div className="table-pile-judged" title={STR.game.discardStageTitle}>
                    <span className="table-pile-name">{STR.game.discardStageLabel}</span>
                    {stagedDiscards.map((e) => (
                      <div className="table-pile-discard" key={e.cards[0]!.id}>
                        <span className="table-pile-discard-owner">
                          {snap?.players.find((p) => p.id === e.playerId)?.name ?? ''}
                        </span>
                        <div className="table-pile-cards">
                          {e.cards.map((c) => (
                            <Card key={c.id} card={c} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
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
          <div className="order-badge" title={STR.game.orderBadgeTitle}>{STR.game.orderReversed}</div>
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

        {/* 公开判定/展示牌：所有玩家可见，逐张亮出（张数封顶，避免亮全手牌时挤爆桌面）；退场淡出 */}
        <RevealPanel revealed={revealed} />
      </div>

      {/* 出牌记录侧条：桌面端（≥1000px）右侧竖排；移动端隐藏（用牌桌顶部横条） */}
      <RoundHistory variant="side" />

      <div className="game-bottom">
        <div className={`my-bar ${myElimPop ? 'my-bar-shake' : ''}`}>
          <span className="my-name">
            {me?.name}
            <em className="tag">{getRole(me?.roleId ?? '')?.name ?? ''}</em>
          </span>
          <span className="my-handcount">
            ×{me?.handCount ?? 0}/{handLimitOf(me?.roleId ?? '')}
          </span>
          {(me?.pancakeCount ?? 0) > 0 && (
            <span className="my-pancake" title={STR.game.pancakeTitle}>
              {STR.game.pancakeBadge.replace('{n}', String(me?.pancakeCount ?? 0))}
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
              // 被动技（无按钮）剩余次数：chip 直接标（2026-10-07 用户反馈），0 = 灰显
              const remaining = s.remaining ? s.remaining(me!.roleState, players.length) : null;
              const exhausted = remaining === 0;
              return (
                <div key={s.id} className={`my-skill ${active ? 'my-skill-active' : ''}`}>
                  <button
                    type="button"
                    className={`my-skill-chip ${exhausted ? 'my-skill-exhausted' : ''}`}
                    title={exhausted ? STR.game.skillUsedUp : undefined}
                    onClick={() => setExpandedSkill(expanded ? null : s.id)}
                  >
                    【{s.name}】
                    {remaining != null && remaining > 0 && (
                      <em className="my-skill-left">{STR.game.skillLeft.replace('{n}', String(remaining))}</em>
                    )}
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
              {preview.hint && (
                <span className={preview.ouYa || preview.pancake ? 'preview-ouya' : 'preview-warn'}>{preview.hint}</span>
              )}
            </>
          ) : preview.hint ? (
            <span className="preview-error">{preview.hint}</span>
          ) : (
            <span className="preview-empty">{myTurn ? STR.game.handPickHint : ''}</span>
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

        {/* 尖叫（苗条）扣置区：手牌上方牌背堆（张数 + 类型），点开查看/收回 */}
        {me && (me.heldCount ?? 0) > 0 && (
          <div className="my-held" title={STR.game.heldViewHint} onClick={() => setHeldViewOpen(true)}>
            <span className="my-held-label">{STR.game.heldBadge}</span>
            <div className="my-held-cards">
              {Array.from({ length: Math.min(me.heldCount, 8) }, (_, i) => (
                <span key={i} className="my-held-cardback" />
              ))}
            </div>
            <span className="my-held-count">×{me.heldCount}</span>
          </div>
        )}

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
            disabled={!myTurn || finished || isLeader || noPass}
            onClick={onPassClick}
          >
            {noPass
              ? STR.game.rfNoPass.replace('{rank}', rev ? '3' : '2')
              : isLeader
                ? STR.game.cannotPassLeader
                : passArmed
                  ? STR.game.passConfirm
                  : STR.game.pass}
          </button>
        </div>

        {skillActions.length > 0 && (
          <div className="skill-actions">
            {skillActions.map((a) => {
              // 次数类技能（2026-10-07 用户反馈）：按钮直接标剩余次数；用尽灰显
              const remaining = a.remaining ? a.remaining(me!.roleState, players.length) : null;
              const exhausted = remaining === 0;
              return (
                <button
                  key={a.skillId}
                  className="btn btn-gold"
                  disabled={exhausted}
                  title={exhausted ? STR.game.skillUsedUp : undefined}
                  onClick={() => void useSkillAction(a.skillId)}
                >
                  ⚡{a.label}
                  {remaining != null && remaining > 0 ? STR.game.skillLeft.replace('{n}', String(remaining)) : ''}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <SkillAskModal />

      {finished && room && <FinishedModal />}

      <PeekModal />

      <RoleViewModal playerId={roleViewPlayer} onClose={() => setRoleViewPlayer(null)} />

      <HeldViewModal open={heldViewOpen} onClose={() => setHeldViewOpen(false)} />

      {!connected && (
        <div className="reconnect-overlay">
          <div className="reconnect-box">{STR.game.reconnect}</div>
        </div>
      )}
    </div>
  );
}

/** 窃笑（轴承）：私密查看目标手牌的弹窗（服务端定向发我，其余人不可见）；退场淡出 0.25s */
function PeekModal() {
  const peekedHand = useStore((s) => s.peekedHand);
  const snap = useStore((s) => s.snap);
  const closePeek = useStore((s) => s.closePeek);
  const [last, setLast] = useState(peekedHand);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (peekedHand) {
      setLast(peekedHand);
      setClosing(false);
      return;
    }
    if (!last) return;
    setClosing(true);
    const t = setTimeout(() => {
      setLast(null);
      setClosing(false);
    }, 250);
    return () => clearTimeout(t);
  }, [peekedHand]);
  if (!last) return null;
  const targetName = snap?.players.find((p) => p.id === last.targetId)?.name ?? STR.game.opponentFallback;
  return (
    <div className={`modal-overlay overlay-in ${closing ? 'overlay-closing' : ''}`} onClick={closePeek}>
      <div className={`modal peek-modal modal-in ${closing ? 'modal-closing' : ''}`} onClick={(ev) => ev.stopPropagation()}>
        <h2 className="peek-title">{STR.game.peekTitle.replace('{name}', targetName)}</h2>
        <div className="peek-cards">
          {last.cards.map((c) => (
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

/** 别人的角色技能（点对手座位打开）：角色名 + 技能名/说明（锁定技标注） */
function RoleViewModal({ playerId, onClose }: { playerId: string | null; onClose: () => void }) {
  const snap = useStore((s) => s.snap);
  if (!playerId) return null;
  const player = snap?.players.find((p) => p.id === playerId);
  const role = getRole(player?.roleId ?? '');
  if (!player || !role) return null;
  return (
    <div className="modal-overlay overlay-in" onClick={onClose}>
      <div className="modal role-view-modal modal-in" onClick={(ev) => ev.stopPropagation()}>
        <h2 className="role-view-title">
          {STR.game.roleTitle.replace('{name}', player.name).replace('{role}', role.name)}
        </h2>
        {role.skills.map((s) => (
          <div key={s.id} className="role-skill-block">
            <div className="role-skill">
              【{s.name}】{s.locked ? STR.room.lockedSkill : ''}
            </div>
            <div className="role-desc">{s.description}</div>
          </div>
        ))}
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {STR.game.peekClose}
        </button>
      </div>
    </div>
  );
}

/** 尖叫（苗条）：查看自己的扣置牌——牌面摊开 + 收回（全部收回手牌）/ 放回（保持扣置） */
function HeldViewModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const snap = useStore((s) => s.snap);
  const myId = useStore((s) => s.myId);
  const useSkillAction = useStore((s) => s.useSkillAction);
  const me = snap?.players.find((p) => p.id === myId);
  const held = me?.held ?? null;
  const heldCount = me?.heldCount ?? 0;
  const pendingAsk = snap?.pendingAsk ?? null;
  // 收回成功后扣置归零 → 自动关闭
  useEffect(() => {
    if (open && heldCount === 0) onClose();
  }, [open, heldCount]);
  if (!open || !held || held.length === 0) return null;
  return (
    <div className="modal-overlay overlay-in" onClick={onClose}>
      <div className="modal held-modal modal-in" onClick={(ev) => ev.stopPropagation()}>
        <h2 className="peek-title">{STR.game.heldViewTitle}</h2>
        {held.map((g, i) => (
          <div key={i} className="held-group">
            <span className="held-group-kind">
              {STR.game.heldGroupLine
                .replace('{kind}', g.kind === 'fanwen' ? STR.game.heldFanwen : STR.game.heldJianjiaoji)
                .replace('{n}', String(g.cards.length))}
            </span>
            <div className="peek-cards">
              {g.cards.map((c) => (
                <Card key={c.id} card={c} />
              ))}
            </div>
          </div>
        ))}
        <div className="held-actions">
          <button
            type="button"
            className="btn btn-primary"
            title={pendingAsk ? STR.game.heldAskBusy : STR.game.heldTakeBackHint}
            disabled={pendingAsk !== null}
            onClick={() => void useSkillAction('jian-jiao')}
          >
            {STR.game.heldTakeBack}
          </button>
          <button type="button" className="btn btn-ghost" title={STR.game.heldPutBackHint} onClick={onClose}>
            {STR.game.heldPutBack}
          </button>
        </div>
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
    <div className="modal-overlay overlay-in">
      <div className="modal finish-modal modal-in">
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
