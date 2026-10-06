// 角色：楠王 —— 技能【旺旺】+【回味】。
// 【旺旺】（亡语）每回合（轮）限一次：有人压你的牌时可对其做花色判定：翻一张牌，**非红桃** →
//   其进入成功班，摸 3 张手牌。触发 = 引擎桌面归属者是你时被响应（归属改写后视作你的牌被压同样触发；
//   插队压的是响应者的牌，不会指向你）。
//   亡语 = 打断钩子在获胜判定之前——压牌者即使打光了手牌，判定成功摸到 3 张也无法立即获胜；
//   判定失败（红桃，大王按 ♥♦ 算红桃）则照常获胜。判定牌一律弃置（成功失败都是）；王按颜色双花色。
//   弃权不消耗；发动即消耗（判定牌弃置、成败无关）；牌堆已空视为未判定、不消耗；
//   与巨石同场旺旺先判（priority 100，2026-10-03 用户确认）：判定成功后巨石照常驱逐
//   （刚摸的牌一并进弃牌堆）、失败或放弃则压牌者带着摸到的牌继续。
// 【回味】锁定技：你压牌时，被压者摸牌，张数 = 两人所打牌点数总和差的绝对值，至多 3 张。
//   点数计算（2026-10-03 用户确认）：2 记 2、A 记 1、其余按牌面（J=11 Q=12 K=13）；
//   王当百搭按所当点数、单王/对王视为无穷（差必封顶 3）。加的牌不豁免手牌上限。
import { isJoker, jokerSuits, pointValue } from '../cards';
import type { Combo } from '../engine/combos';
import type { HookContext, HookResult, RoleDef } from './types';

interface KingNanState {
  /** 本回合是否已判定过旺旺（每回合限一次：弃权不消耗，发动即消耗） */
  judgedThisRound: boolean;
  /** 障目再入：待门控的技能与目标（旺旺压牌者 / 回味被压者） */
  gate: { skillId: 'wang-wang' | 'hui-wei'; targetId: string } | null;
}

/** 旺旺判定流程（障目门控通过后执行）：翻牌非红桃 → 压牌者摸 3 张 */
function wangWangJudge(ctx: HookContext, st: KingNanState, owner: string): HookResult | void {
  st.judgedThisRound = true; // 发动即消耗（判定牌一律弃置，成败无关）
  const top = ctx.game.revealTop(1, '旺旺判定');
  const card = top[0];
  const name = ctx.game.players().find((p) => p.id === owner)?.name ?? owner;
  if (!card) {
    ctx.game.discardRevealed();
    ctx.game.announce('king-nan', 'wang-wang', '【旺旺】牌堆已空，无法判定');
    return;
  }
  const isHeart = isJoker(card) ? jokerSuits(card).includes(1) : card.suit === 1;
  ctx.game.discardRevealed(); // 判定牌一律弃置
  if (isHeart) {
    ctx.game.announce('king-nan', 'wang-wang', `【旺旺】判定失败（红桃），${name} 不受影响`);
    return { ok: true };
  }
  ctx.game.draw(owner, 3);
  ctx.game.announce('king-nan', 'wang-wang', `【旺旺】判定成功！${name} 进入成功班，摸 3 张手牌`);
  return { ok: true };
}

/** 回味效果（障目门控通过后执行）：被压者摸 |点数差| 张，至多 3 */
function huiWeiEffect(ctx: HookContext, _st: KingNanState, played: Combo, target: string): HookResult | void {
  const prev = ctx.game.prevTable();
  if (!prev) return;
  const n = Math.min(3, Math.abs(comboPoints(played) - comboPoints(prev)));
  if (n <= 0) return;
  ctx.game.draw(target, n);
  const name = ctx.game.players().find((p) => p.id === target)?.name ?? target;
  ctx.game.announce('king-nan', 'hui-wei', `【回味】${name} 回味无穷，摸 ${n} 张手牌`);
}

/** 一手牌的点数总和（回味）：2 记 2、A 记 1、其余按牌面；王当百搭按所当点数，单王/对王视为无穷 */
function comboPoints(combo: Combo): number {
  if (combo.type === 'singleJoker' || combo.type === 'jokerPair') return Infinity;
  return combo.cards.reduce((sum, c) => {
    if (isJoker(c)) {
      const r = combo.resolved.find((x) => x.cardId === c.id);
      return sum + pointValue(r?.rank ?? c.rank);
    }
    return sum + pointValue(c.rank);
  }, 0);
}

const kingNan: RoleDef = {
  id: 'king-nan',
  // 亡语同场顺序（2026-10-03 用户确认）：旺旺先于巨石判定（priority 降序）
  priority: 100,
  // 亡语（2026-10-05 用户定稿）：只有旺旺在压牌者打光手牌后仍可触发；回味（锁定技）非亡语，打光即结束
  deathrattleHooks: ['onPlayInterrupt'],
  name: '楠王',
  skills: [
    {
      id: 'wang-wang',
      name: '旺旺',
      description:
        '（亡语）每回合一次：有人压你的牌时可判定（翻一张牌，非红桃 → 其进入成功班摸 3 张手牌，打光手牌也无法立即获胜；判定牌弃置；王按颜色算 ♠♣/♥♦）。弃权不消耗。',
    },
    {
      id: 'hui-wei',
      name: '回味',
      locked: true,
      description:
        '你压牌时，被压者摸牌，张数 = 两人所打牌点数总和差的绝对值，至多 3 张（2 记 2、A 记 1；王当百搭按所当点数，单王/对王差必封顶 3）。',
    },
  ],
  setup(): KingNanState {
    return { judgedThisRound: false, gate: null };
  },
  hooks: {
    onPlayInterrupt(ctx, _played) {
      const owner = ctx.game.roundLastPlayerId()!;
      if (ctx.game.prevTableOwnerId() !== ctx.self.id) return; // 只对压我牌的人
      if (ctx.game.eliminated(owner)) return; // 防御：目标已不在场则不判定
      if (ctx.game.bpProtected(owner)) return; // 血压（硝烟）全挡：技能不能对压牌者生效（含增益）
      const st = ctx.state as KingNanState;
      // 障目再入（旺旺猜牌/摸牌答案）：门控通过后照常判定
      if (st.gate?.skillId === 'wang-wang') {
        const { targetId } = st.gate;
        const g = ctx.game.zhangMuCheck(ctx.self.id, targetId, 'wang-wang', () => {
          st.gate = null;
          return wangWangJudge(ctx, st, targetId);
        });
        if (g) {
          if (st.gate && !('ask' in g)) st.gate = null; // 障目猜错/已封锁：清残留门控（防下次钩子误入再问）
          return g;
        }
        st.gate = null;
        return; // 防御
      }
      const a = ctx.answer;
      if (!a) {
        if (st.judgedThisRound) return;
        if (ctx.game.deckCount() === 0) return; // 牌堆已空：视为未判定，不消耗
        const name = ctx.game.players().find((p) => p.id === owner)?.name ?? owner;
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt: `【旺旺】是否判定压你牌的 ${name}？翻一张牌，非红桃 → 其进入成功班摸 3 张手牌（亡语：打光了手牌也无法立即获胜；红桃则无事发生）。判定牌弃置，王按颜色算 ♠♣/♥♦；每回合限一次，弃权不消耗`,
          },
        };
      }
      if (st.judgedThisRound) return; // 防御：同轮重复回答
      if (a.choice !== 'yes') return; // 弃权不消耗
      // 障目门控（指向性：压牌者为辛歼时先猜手牌数；猜错不消耗次数）
      st.gate = { skillId: 'wang-wang', targetId: owner };
      const g = ctx.game.zhangMuCheck(ctx.self.id, owner, 'wang-wang', () => {
        st.gate = null;
        return wangWangJudge(ctx, st, owner);
      });
      if (g) {
        if (st.gate && !('ask' in g)) st.gate = null; // 障目已封锁（猜错后对他人发动）：清残留门控
        return g;
      }
      st.gate = null;
      return wangWangJudge(ctx, st, owner); // 直接放行
    },
    afterPlay(ctx, played) {
      // 锁定技：不询问。触发 = 楠王压牌（本手出牌者是楠王——afterPlay 对全场每个角色的每次出牌都会跑，
      // 不守出牌者会把「别人压别人」也当成回味：2026-10-05 用户实机发现修勾狂吠自压每手都触发）；
      // 压牌 = 本手出牌前桌面有归属者且不是自己（起牌不触发）
      if (ctx.game.roundLastPlayerId() !== ctx.self.id) return;
      const target = ctx.game.prevTableOwnerId();
      if (target == null || target === ctx.self.id) return;
      if (ctx.game.eliminated(target)) return;
      if (ctx.game.bpProtected(target)) return; // 血压（硝烟）全挡：技能不能对被压者生效（含增益）
      const prev = ctx.game.prevTable();
      if (!prev) return;
      const st = ctx.state as KingNanState;
      // 障目再入（回味猜牌/摸牌答案）：门控通过后照常给牌（回味名义锁定但按非锁定门控，2026-10-06 用户确认）
      if (st.gate?.skillId === 'hui-wei') {
        const { targetId } = st.gate;
        const g = ctx.game.zhangMuCheck(ctx.self.id, targetId, 'hui-wei', () => {
          st.gate = null;
          return huiWeiEffect(ctx, st, played, targetId);
        });
        if (g) {
          if (st.gate && !('ask' in g)) st.gate = null; // 障目猜错/已封锁：清残留门控（防下次钩子误入再问）
          return g;
        }
        st.gate = null;
        return; // 防御
      }
      const n = Math.min(3, Math.abs(comboPoints(played) - comboPoints(prev)));
      if (n <= 0) return;
      // 障目门控（指向性：被压者为辛歼时先猜手牌数）
      st.gate = { skillId: 'hui-wei', targetId: target };
      const g = ctx.game.zhangMuCheck(ctx.self.id, target, 'hui-wei', () => {
        st.gate = null;
        return huiWeiEffect(ctx, st, played, target);
      });
      if (g) {
        if (st.gate && !('ask' in g)) st.gate = null; // 障目已封锁（猜错后对他人发动）：清残留门控
        return g;
      }
      st.gate = null;
      return huiWeiEffect(ctx, st, played, target); // 直接放行
    },
    onRoundEnd(ctx) {
      (ctx.state as KingNanState).judgedThisRound = false; // 每回合（轮）限一次
    },
  },
};

export default kingNan;
