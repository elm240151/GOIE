// 15× 种子化全流程稳定性模拟：随机角色/人数/起手，随机合法出牌与技能答复，
// 每步断言牌守恒（全池 216 = 公共三副 162 + 辛歼独立牌堆/弃牌 54），结束断言恰一个赢家。
import { defaultRules } from '../shared/src/config';
import { listPlayable } from '../shared/src/engine/combos';
import { GameEngine, type EnginePlayer } from '../shared/src/engine/engine';
import { mulberry32 } from '../shared/src/engine/rng';
import { loadAllRoles } from '../shared/src/roles/loader.node';
import { listRoles } from '../shared/src/roles/registry';

const ROUNDS = 15;
const STEP_CAP = 30000;

function totalCards(engine: GameEngine): number {
  // 白盒守恒 216 = 公共三副 162 + 辛歼独立牌堆/弃牌 54（无辛歼时私有池为空）。
  // 快照口径不可用：辛歼手牌数对他人才发 -1、私有池张数只有本人可见
  const e = engine as unknown as {
    hands: Map<string, { length: number }>;
    held: Map<string, { cards: { length: number }[] }>;
    pancakes: Map<string, { length: number }>;
    deck: { length: number };
    discarded: { length: number };
    privateDeck: { length: number };
    privateDiscard: { length: number };
  };
  const s = engine.snapshotFor('p0');
  const hands = [...e.hands.values()].reduce((x, h) => x + h.length, 0);
  const held = [...e.held.values()].reduce((x, gs) => x + gs.reduce((y, g) => y + g.cards.length, 0), 0);
  const pancakes = [...e.pancakes.values()].reduce((x, cs) => x + cs.length, 0);
  return (
    hands +
    held +
    pancakes +
    (s.table ? s.table.cards.length : 0) +
    e.deck.length +
    e.discarded.length +
    s.revealed.length + // 翻牌池（判定挂起期间）
    s.tableSide.length + // 边牌（再问补打等明置桌旁）
    s.stagedDiscards.reduce((x, se) => x + se.cards.length, 0) + // 弃牌暂存区（本回合公开弃置，轮末进弃牌堆）
    e.privateDeck.length +
    e.privateDiscard.length
  );
}

async function main() {
  await loadAllRoles();
  const pool = listRoles();
  let games = 0;
  let totalSteps = 0;
  for (let seed = 1; seed <= ROUNDS; seed++) {
    const rng = mulberry32(seed * 7919 + 13);
    const n = 3 + Math.floor(rng() * 4); // 3-6 人
    const chosen = [...pool].sort(() => rng() - 0.5).slice(0, n);
    const players: EnginePlayer[] = chosen.map((r, i) => ({ id: `p${i}`, name: `玩家${i}`, roleId: r.id }));
    const engine = new GameEngine(defaultRules, players, {
      rng,
      startPlayerId: `p${Math.floor(rng() * n)}`,
      roles: new Map(chosen.map((r) => [r.id, r])),
    });
    engine.start();

    let steps = 0;
    const trace: string[] = [];
    // 守恒目标：无辛歼 162（公共三副）、有辛歼 216（+ 独立 54）
    const expected = chosen.some((r) => r.mystic) ? 216 : 162;
    while (steps < STEP_CAP) {
      steps++;
      if (totalCards(engine) !== expected) {
        const s = engine.snapshotFor('p0');
        console.log('守恒破坏现场 seed=', seed, 'step=', steps, '实际=', totalCards(engine));
        console.log('players:', s.players.map((p) => `${p.id}: ${p.handCount}手${p.pancakeCount}饼${p.heldCount}扣`).join(' '), 'table:', s.table?.cards.length, 'deck:', s.deckCount, 'discard:', s.discardCount, 'revealed:', s.revealed.length);
        console.log('trace:', trace.join(' '));
        throw new Error(`牌守恒破坏 seed=${seed} step=${steps}`);
      }
      const s0 = engine.snapshotFor('p0');
      const ask = s0.pendingAsk;
      trace.push(`${steps}:${ask ? `${ask.kind}${ask.askId}→${ask.playerId}「${(ask as { prompt?: string }).prompt?.slice(0, 12)}」` : `t${s0.turnPlayerId}`}`);
      if (trace.length > 30) trace.shift();
      if (ask) {
        const full = engine.currentAsk(ask.playerId) ?? ask; // 完整载荷（候选牌/目标等）走定向接口
        const pid = ask.playerId;
        const decline = () => {
          const r = engine.resolveAsk(pid, { askId: ask.askId, choice: 'decline' });
          if (!r.ok) throw new Error(`无法弃权 seed=${seed} step=${steps} kind=${ask.kind}`);
        };
        if (full.kind === 'confirm') {
          // 随机接受（含吐饼吃饼确认、抽你、巨石等）
          const r = engine.resolveAsk(pid, { askId: ask.askId, choice: rng() < 0.5 ? 'yes' : 'decline' });
          if (!r.ok) decline();
        } else if (full.kind === 'pickCards' || full.kind === 'selfFollow' || full.kind === 'cutIn') {
          // 提交候选前 min 张（吃饼亮牌/倒置、狂吠连压、插队均合法；提交被拒则弃权）
          const cards = full.cards ?? [];
          if (cards.length >= (full.min ?? 1)) {
            const nPick = full.min ?? 1;
            const r = engine.resolveAsk(pid, { askId: ask.askId, choice: 'yes', cardIds: cards.slice(0, nPick).map((c) => c.id) });
            if (!r.ok) decline();
          } else {
            decline();
          }
        } else if (full.kind === 'pickTarget') {
          const t = full.targetCandidates ?? [];
          const target = t[Math.floor(rng() * t.length)];
          const r = engine.resolveAsk(pid, { askId: ask.askId, targetPlayerId: target });
          if (!r.ok) decline();
        } else {
          // suit / choice（巨石花色、答疑点数等）：随机选第一项或弃权
          decline();
        }
        continue;
      }
      if (s0.phase !== 'playing') break; // 终局（发牌期无询问时会在此跳出）
      const turnId = s0.turnPlayerId;
      const snap = engine.snapshotFor(turnId);
      const me = snap.players.find((p) => p.id === turnId)!;
      const hand = me.hand;
      if (hand.length === 0) throw new Error(`0 手未判胜 seed=${seed} step=${steps} turn=${turnId}（引擎应已判空手获胜）`);
      // 留 2 禁止收尾豁免（辛歼【神秘】：单 2/对 2 可打完收尾）与引擎同口径
      const liu2Exempt = (engine as unknown as { liu2ExemptFor(id: string): boolean }).liu2ExemptFor(turnId);
      const legal = listPlayable(hand, snap.table, defaultRules, snap.orderReversed, engine.soloJokerAllowed(turnId), liu2Exempt);
      if (legal.length === 0) {
        trace[trace.length - 1] += '过';
        engine.pass(turnId);
        continue;
      }
      // 随机一组合法牌打出（或随机过牌，除非领出不能过）
      const combo = legal[Math.floor(rng() * legal.length)]!;
      const r = engine.playCards(turnId, combo.cards.map((c) => c.id));
      if (!r.ok) {
        // 被技能/限制否决 → 尝试其余组合，都失败则过（领出不能过则换组合策略）
        let ok = false;
        for (const c of legal) {
          if (engine.playCards(turnId, c.cards.map((x) => x.id)).ok) {
            ok = true;
            break;
          }
        }
        if (!ok) {
          const p = engine.pass(turnId);
          if (!p.ok) throw new Error(`卡死：seed=${seed} step=${steps} 领出/过牌均被拒`);
        }
      } else {
        trace[trace.length - 1] += '出';
      }
      const sAfter = engine.snapshotFor('p0');
      if (sAfter.roundLeaderId !== snap.roundLeaderId) trace[trace.length - 1] += '⚑';
    }
    const fin = engine.snapshotFor('p0');
    if (fin.phase !== 'finished') {
      console.log('卡死现场 seed=', seed, 'steps=', steps);
      console.log(
        'players:',
        fin.players.map((p) => `${p.id}:${p.handCount}手${p.pancakeCount}饼${p.heldCount}扣${p.eliminated ? "淘" : ""}`).join(' ')
      );
      console.log('turn:', fin.turnPlayerId, 'table:', fin.table?.type, fin.table?.rank, 'deck:', fin.deckCount, 'discard:', fin.discardCount, 'rev:', fin.orderReversed, 'ask:', fin.pendingAsk ? `${fin.pendingAsk.kind}→${fin.pendingAsk.playerId}` : '无');
      console.log('最近 30 步:', trace.join(' '));
      throw new Error(`超步数未结束 seed=${seed}`);
    }
    if (totalCards(engine) !== expected) throw new Error(`终局牌守恒破坏 seed=${seed}`);
    const winners = fin.players.filter((p) => p.eliminated === false && fin.winnerId === p.id).length;
    if (fin.winnerId && winners !== 1) throw new Error(`赢家异常 seed=${seed}`);
    games++;
    totalSteps += steps;
    console.log(`seed=${seed}: ${n} 人 ${steps} 步，赢家=${fin.winnerId ?? '流局'}，角色=${chosen.map((r) => r.id).join(',')}`);
  }
  console.log(`✅ ${games} 局全部稳定结束（平均 ${Math.round(totalSteps / games)} 步）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
