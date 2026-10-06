// 技能询问弹窗：按询问类型渲染（确认/选花色/选项/选牌/选目标/插队），带倒计时。
// 询问完整载荷由服务端定向发送（game:skill-ask），超时服务端自动按弃权处理。
// 退场两阶段：store 清空后先淡出 0.25s 再卸载（新询问到达立即恢复；快照驱动关闭逻辑在 store）。
import { useEffect, useMemo, useState } from 'react';
import type { Card as CardT, SkillAsk } from '@gdys/shared';
import { useStore } from '../store';
import { STR } from '../strings';
import Card from './Card';

/** 倒计时（秒）：用询问自带超时毫秒数 */
function useAskCountdown(ask: SkillAsk | null): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!ask?.timeoutMs) {
      setLeft(null);
      return;
    }
    const deadline = Date.now() + ask.timeoutMs;
    setLeft(Math.max(0, Math.ceil(ask.timeoutMs / 1000)));
    const t = setInterval(() => {
      const l = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(l);
      if (l <= 0) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
  }, [ask]);
  return left;
}

/** 选牌网格（pickCards / 插队用手牌）；hidden = 盲抽只看牌背（如骚骚摸对面牌） */
function PickGrid({
  cards,
  picked,
  onToggle,
  hidden,
}: {
  cards: readonly CardT[];
  picked: number[];
  onToggle: (id: number) => void;
  hidden?: boolean;
}) {
  return (
    <div className="ask-cards">
      {cards.map((c) =>
        hidden ? (
          <button
            key={c.id}
            type="button"
            className={`cardback ${picked.includes(c.id) ? 'cardback-selected' : ''}`}
            onClick={() => onToggle(c.id)}
            title={STR.game.cardBack}
          />
        ) : (
          <Card key={c.id} card={c} selected={picked.includes(c.id)} onClick={() => onToggle(c.id)} />
        )
      )}
    </div>
  );
}

export default function SkillAskModal() {
  const ask = useStore((s) => s.skillAsk);
  const snap = useStore((s) => s.snap);
  const myId = useStore((s) => s.myId);
  const answerSkill = useStore((s) => s.answerSkill);
  const left = useAskCountdown(ask);

  // 退场两阶段：淡出期间继续渲染最后一份询问（last），0.25s 后卸载
  const [last, setLast] = useState<SkillAsk | null>(ask);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (ask) {
      setLast(ask);
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
  }, [ask]);

  const myHand = useMemo(
    () => snap?.players.find((p) => p.id === myId)?.hand ?? [],
    [snap, myId],
  );
  const [picked, setPicked] = useState<number[]>([]);

  // 每次新询问重置选择
  const askKey = ask?.askId ?? '';
  useEffect(() => {
    setPicked([]);
  }, [askKey]);

  if (!last || last.askId === '') return null;

  const min = last.min ?? 1;
  const max = last.max ?? myHand.length;

  const toggle = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const answer = (payload: { choice?: string; cardIds?: number[]; targetPlayerId?: string }) =>
    void answerSkill({ askId: last.askId, ...payload });

  let body: React.ReactNode;
  let canSubmit = false;

  switch (last.kind) {
    case 'confirm':
      body = null;
      canSubmit = true;
      break;
    case 'suit':
    case 'choice':
      body = (
        <div className="ask-options">
          {(last.options ?? []).map((o) => (
            <button key={o} className="btn btn-primary ask-option" onClick={() => answer({ choice: o })}>
              {o}
            </button>
          ))}
        </div>
      );
      break;
    case 'pickCards': {
      const cards = last.cards ?? myHand;
      body = <PickGrid cards={cards} picked={picked} onToggle={toggle} hidden={last.hidden} />;
      canSubmit = picked.length >= min && picked.length <= max;
      break;
    }
    case 'pickTarget':
      body = (
        <div className="ask-options">
          {(last.targetCandidates ?? []).map((pid) => {
            const p = snap?.players.find((x) => x.id === pid);
            return (
              <button key={pid} className="btn btn-primary ask-option" onClick={() => answer({ targetPlayerId: pid })}>
                {p ? STR.game.pickTargetLabel.replace('{name}', p.name).replace('{n}', String(p.handCount)) : pid}
              </button>
            );
          })}
        </div>
      );
      break;
    case 'cutIn':
      body = <PickGrid cards={myHand} picked={picked} onToggle={toggle} />;
      canSubmit = picked.length > 0;
      break;
    case 'selfFollow':
      // 狂吠：从自己手牌选组合压自己打出的牌
      body = <PickGrid cards={myHand} picked={picked} onToggle={toggle} />;
      canSubmit = picked.length > 0;
      break;
    case 'proxyPlay':
      // 讲题（硝烟）代打：从自己手牌选牌打出（视作硝烟打出）；不出 = 弃权走惩罚
      body = <PickGrid cards={myHand} picked={picked} onToggle={toggle} />;
      canSubmit = picked.length > 0;
      break;
  }

  // pickTarget 无弃权按钮（历史行为）；declineAllowed: false 的询问（讲题惩罚、法音弃牌、处分等
  // 对别人产生的效果）不可弃权——服务端同样按默认作答兜底（2026-10-06 用户确认）
  const showDecline = last.kind !== 'pickTarget' && last.declineAllowed !== false;

  return (
    <div className={`modal-overlay overlay-in ${closing ? 'overlay-closing' : ''}`}>
      <div className={`modal ask-modal modal-in ${closing ? 'modal-closing' : ''}`}>
        <div className="ask-head">
          <span className="ask-title">⚡ {STR.game.skillAsk}</span>
          {left !== null && <span className={`ask-countdown ${left <= 5 ? 'ask-urgent' : ''}`}>{left}s</span>}
        </div>
        <p className="ask-prompt">{last.prompt}</p>
        {last.kind === 'cutIn' && <p className="ask-hint">{STR.game.cutInHint}</p>}
        {last.kind === 'selfFollow' && <p className="ask-hint">{STR.game.selfFollowHint}</p>}
        {last.kind === 'proxyPlay' && <p className="ask-hint">{STR.game.proxyPlayHint}</p>}
        {last.kind === 'pickCards' && (
          <p className="ask-hint">
            {(last.hidden ? STR.game.pickHiddenHint : STR.game.pickHint)
              .replace('{n}', String(picked.length))
              .replace('{min}', String(min))
              .replace('{max}', String(max))}
          </p>
        )}
        {body}
        <div className="ask-actions">
          {showDecline && (
            <button className="btn btn-secondary" onClick={() => answer({ choice: 'decline' })}>
              {last.kind === 'proxyPlay' ? STR.game.declineProxy : STR.game.decline}
            </button>
          )}
          {last.kind === 'confirm' && (
            <button className="btn btn-primary" onClick={() => answer({ choice: 'yes' })}>
              {STR.game.confirm}
            </button>
          )}
          {(last.kind === 'cutIn' || last.kind === 'selfFollow' || last.kind === 'proxyPlay') && (
            <button className="btn btn-primary" disabled={!canSubmit} onClick={() => answer({ choice: 'yes', cardIds: picked })}>
              {STR.game.confirm}
            </button>
          )}
          {last.kind === 'pickCards' && (
            <button className="btn btn-primary" disabled={!canSubmit} onClick={() => answer({ cardIds: picked })}>
              {STR.game.submit}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
