// 重连与掉线兜底：身份令牌 + 掉线超时自动过/自动出。
import { randomUUID } from 'node:crypto';
import { listPlayable, type ActionResult, type GameEngine, type RuleConfig } from '@gdys/shared';

/** 生成玩家身份令牌（重连凭证，重连时校验） */
export function generatePlayerSecret(): string {
  return randomUUID();
}

/** 掉线兜底：能过则过；起牌者必须出 → 自动出最小可出组合（确定性） */
export function autoPlayFallback(engine: GameEngine, playerId: string, cfg: RuleConfig): ActionResult | null {
  const r = engine.pass(playerId);
  if (r.ok) return r;
  const snap = engine.snapshotFor(playerId);
  const hand = snap.players.find((p) => p.id === playerId)?.hand ?? null;
  if (!hand) return null;
  // 单王（橐驼诅咒）候选：掉线的橐驼起牌只剩王时也要能自动打出
  const combos = listPlayable(hand, snap.table, cfg, snap.orderReversed, engine.soloJokerAllowed(playerId));
  if (combos.length === 0) return null;
  return engine.playCards(playerId, combos[0]!.cards.map((c) => c.id));
}
