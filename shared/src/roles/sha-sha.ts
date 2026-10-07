// 角色：煞蔱 Sharry —— 技能【约等】+【直播】。
// 【约等】每回合（轮）限一次，两个触发点（弃权不消耗，生效才消耗）：
//   A. 你压别人的手牌时（本手出牌者是你且上一手有归属者且不是你——归属改写后视作别人打出则不触发）；
//   B. 你拥有牌权时（轮末你最后出牌：该回合相当于出了 0 张牌，不用摸牌即可发动，2026-10-06 用户确认）。
//   效果：收回你刚打的那一手牌（桌面回退上一手、桌旁边牌随弃）→ 与一名你选定的角色均分手牌（合洗随机分，
//   你拿 ⌊X/2⌋、对方拿其余，X 为双方手牌总数；2026-10-07 用户修正：由你选人，不再随机）→
//   从你下家继续接牌（引擎 yueDengRevert）。
//   非亡语（2026-10-06 用户裁定）：打光压出最后一手直接获胜，约等不再询问。
// 【直播】每当你打出大于一张的牌后有人压你的牌，你可选择一项（可放弃、不限次）：
//   ①交给对方一张牌（手牌 ≥2 时才有此选项，不能给出最后一张）②令对方摸两张牌。
import type { AskAnswer, HookContext, HookResult, RoleDef } from './types';

interface ShaShaState {
  /** 本回合是否已发动约等（生效才消耗） */
  yueDengUsed: boolean;
  /** 约等确认已答 yes、正在等待选人（pickTarget） */
  yueDengPick: boolean;
  /** 障目再入：'yue-deng' = 约等目标待门控、'zhi-bo' = 直播待门控 */
  gate: 'yue-deng' | 'zhi-bo' | null;
  /** 障目再入：门控中的目标玩家 */
  gateTarget: string | null;
  /** 直播阶段机：'choice' = 选择一项中、'give' = 选牌交给对方中 */
  zhiboStage: 'choice' | 'give' | null;
  /** 直播目标（压牌者） */
  zhiboTarget: string | null;
}

const nameOf = (ctx: HookContext, id: string): string =>
  ctx.game.players().find((p) => p.id === id)?.name ?? id;

/** 约等选人询问（候选：其他未淘汰、非血压保护玩家） */
function yueDengPickAsk(ctx: HookContext, st: ShaShaState): HookResult {
  const candidates = ctx.game
    .players()
    .filter((p) => p.id !== ctx.self.id && !ctx.game.eliminated(p.id) && !ctx.game.bpProtected(p.id))
    .map((p) => p.id);
  if (candidates.length === 0) return { ok: false, reason: '【约等】没有可均分的对象' };
  st.yueDengPick = true;
  return {
    ok: true,
    ask: {
      kind: 'pickTarget',
      prompt: '【约等】选择均分对象（你拿 ⌊X/2⌋、对方拿其余，X 为双方手牌总数）',
      targetCandidates: candidates,
    },
  };
}

/** 约等选人回答：非法/弃权（含超时）= 约等放弃、不消耗 */
function yueDengPickAnswer(ctx: HookContext, st: ShaShaState, a: AskAnswer): HookResult | void {
  st.yueDengPick = false;
  const t = a.targetPlayerId;
  if (!t || t === ctx.self.id || ctx.game.eliminated(t) || ctx.game.bpProtected(t)) return;
  return submitYueDeng(ctx, st, t);
}

/** 约等确认后：对选定对象障目门控 → 提交 modify.yueDeng */
function submitYueDeng(ctx: HookContext, st: ShaShaState, t: string): HookResult {
  st.gate = 'yue-deng';
  st.gateTarget = t;
  const cont = (): HookResult => {
    const tid = st.gateTarget!;
    st.gate = null;
    st.gateTarget = null;
    st.yueDengUsed = true; // 生效才消耗（障目猜错不消耗）
    return { ok: true, modify: { yueDeng: { targetId: tid } } };
  };
  const g = ctx.game.zhangMuCheck(ctx.self.id, t, 'yue-deng', cont);
  if (g) {
    if (st.gate && !('ask' in g)) {
      st.gate = null;
      st.gateTarget = null; // 障目已封锁（猜错后对他人发动）：技能失效
    }
    return g;
  }
  return cont();
}

/** 障目再入（约等猜牌/摸牌答案）：猜中后提交 modify.yueDeng */
function yueDengGate(ctx: HookContext, st: ShaShaState): HookResult | null {
  if (st.gate !== 'yue-deng') return null;
  const g = ctx.game.zhangMuCheck(ctx.self.id, st.gateTarget, 'yue-deng', () => {
    const t = st.gateTarget!;
    st.gate = null;
    st.gateTarget = null;
    st.yueDengUsed = true; // 生效才消耗（障目猜错不消耗）
    return { ok: true, modify: { yueDeng: { targetId: t } } };
  });
  if (g) {
    if (st.gate && !('ask' in g)) {
      st.gate = null;
      st.gateTarget = null; // 障目猜错/已封锁：清残留门控（防下次钩子误入再问）
    }
    return g;
  }
  st.gate = null;
  st.gateTarget = null;
  return { ok: true }; // 防御：门控放行（不应到达）
}

/** 直播选择询问（可放弃；手牌 ≤1 时没有给牌选项——不能给出最后一张） */
function zhiBoAsk(ctx: HookContext, st: ShaShaState): HookResult {
  const canGive = ctx.game.handOf(ctx.self.id).length > 1;
  return {
    ok: true,
    ask: {
      kind: 'choice',
      prompt: `【直播】${nameOf(ctx, st.zhiboTarget!)} 压了你的牌（捣乱）：选择一项`,
      options: canGive ? ['交给对方一张牌', '令对方摸两张牌'] : ['令对方摸两张牌'],
      declineAllowed: true,
    },
  };
}

/** 直播选择/给牌阶段再入 */
function zhiBoFlow(ctx: HookContext, st: ShaShaState, beater: string): HookResult | void {
  const a = ctx.answer;
  if (st.zhiboStage === 'give') {
    // 给牌阶段（不可放弃：选了给就必须给）
    st.zhiboStage = null;
    const hand = ctx.game.handOf(ctx.self.id);
    const card = hand.find((c) => c.id === a?.cardIds?.[0]) ?? hand[0];
    if (!card || hand.length <= 1) return; // 防御：不能给出最后一张
    ctx.game.giveFrom(ctx.self.id, [card.id]);
    ctx.game.giveTo(beater, [card]);
    ctx.game.announce('sha-sha', 'zhi-bo', `【直播】${ctx.self.name} 把一张牌交给 ${nameOf(ctx, beater)}`);
    return;
  }
  // 'choice' 阶段
  st.zhiboStage = null;
  if (a?.choice !== '交给对方一张牌' && a?.choice !== '令对方摸两张牌') return; // 放弃
  if (a.choice === '令对方摸两张牌') {
    ctx.game.draw(beater, 2);
    ctx.game.announce('sha-sha', 'zhi-bo', `【直播】${nameOf(ctx, beater)} 捣乱被罚，摸两张牌`);
    return;
  }
  st.zhiboStage = 'give';
  return {
    ok: true,
    ask: {
      kind: 'pickCards',
      prompt: `【直播】选择一张牌交给 ${nameOf(ctx, beater)}（不能给出最后一张）`,
      cards: [...ctx.game.handOf(ctx.self.id)],
      min: 1,
      max: 1,
      declineAllowed: false,
    },
  };
}

const shaSha: RoleDef = {
  id: 'sha-sha',
  priority: 80,
  // 约等/直播均非亡语（2026-10-06 用户裁定：打光压出最后一手直接获胜、不再询问）
  name: '煞蔱',
  skills: [
    {
      id: 'yue-deng',
      name: '约等',
      description:
        '每回合一次：你压别人的手牌时，或你拥有牌权时（本回合相当于出了 0 张牌、不用摸牌），可收回刚打的那一手牌（桌面退回被压的一手），选择一名角色与其均分手牌（你拿 ⌊X/2⌋、对方拿其余），从你下家继续接牌。弃权不消耗。',
    },
    {
      id: 'zhi-bo',
      name: '直播',
      description:
        '每当你打出大于一张的牌后有人压你的牌，你可选择一项：交给对方一张牌（不能给出最后一张），或令对方摸两张牌。',
    },
  ],
  setup(): ShaShaState {
    return { yueDengUsed: false, yueDengPick: false, gate: null, gateTarget: null, zhiboStage: null, zhiboTarget: null };
  },
  hooks: {
    afterPlay(ctx) {
      const st = ctx.state as ShaShaState;
      if (ctx.game.eliminated(ctx.self.id)) return;
      const g0 = yueDengGate(ctx, st);
      if (g0) return g0;
      const a = ctx.answer;
      if (a) {
        // 约等确认/选人回答（无门控时才会走到这里）
        if (st.yueDengPick) return yueDengPickAnswer(ctx, st, a);
        if (a.choice !== 'yes') return; // 弃权不消耗
        return yueDengPickAsk(ctx, st);
      }
      st.yueDengPick = false; // 防御：新触发重置选人残留
      if (st.yueDengUsed) return;
      // 触发 A：本手出牌者是她（归属改写后视作别人打出则不触发），压的是别人的手牌
      if (ctx.game.roundLastPlayerId() !== ctx.self.id) return;
      const beaten = ctx.game.prevTableOwnerId();
      if (beaten == null || beaten === ctx.self.id) return;
      if (!ctx.game.prevTable()) return;
      if (ctx.game.eliminated(beaten)) return; // 防御
      return {
        ok: true,
        ask: {
          kind: 'confirm',
          prompt: `【约等】是否收回刚打的这手牌，与一名你选定的角色均分手牌？（你拿 ⌊X/2⌋、对方拿其余，X 为双方手牌总数；收回后从你下家继续接牌）`,
        },
      };
    },
    onRoundEnd(ctx, lastId) {
      const st = ctx.state as ShaShaState;
      if (ctx.game.eliminated(ctx.self.id)) return;
      const g0 = yueDengGate(ctx, st);
      if (g0) return g0;
      if (lastId !== ctx.self.id) return;
      if (st.yueDengUsed) return;
      const a = ctx.answer;
      if (a) {
        // 约等确认/选人回答（无门控时才会走到这里）
        if (st.yueDengPick) return yueDengPickAnswer(ctx, st, a);
        if (a.choice !== 'yes') return; // 弃权不消耗
        return yueDengPickAsk(ctx, st);
      }
      st.yueDengPick = false; // 防御：新触发重置选人残留
      // 触发 B：拥有牌权（该回合出了 0 张牌，不用摸牌即可发动）
      return {
        ok: true,
        ask: {
          kind: 'confirm',
          prompt:
            '【约等】你拥有牌权（本回合相当于出了 0 张牌）：是否收回本回合打出的手牌，与一名你选定的角色均分手牌？（不用摸牌；收回后从你下家继续接牌）',
        },
      };
    },
    onPlayInterrupt(ctx) {
      const st = ctx.state as ShaShaState;
      if (ctx.game.eliminated(ctx.self.id)) return;
      const beater = ctx.game.roundLastPlayerId()!;
      const a = ctx.answer;
      // 障目再入（直播猜牌/摸牌答案）：猜中后进入选择询问
      if (st.gate === 'zhi-bo') {
        const g = ctx.game.zhangMuCheck(ctx.self.id, st.gateTarget, 'zhi-bo', () => {
          st.gate = null;
          st.gateTarget = null;
          return zhiBoAsk(ctx, st); // 续跑：进入选择询问
        });
        if (g) {
          if (st.gate && !('ask' in g)) {
            st.gate = null;
            st.gateTarget = null;
            st.zhiboStage = null;
            st.zhiboTarget = null; // 障目猜错/已封锁：直播失效
          }
          return g;
        }
        st.gate = null;
        st.gateTarget = null;
        return zhiBoAsk(ctx, st); // 防御
      }
      if (a) return zhiBoFlow(ctx, st, beater); // 选择/给牌阶段再入
      // 新手：重置上一手遗留
      st.zhiboStage = null;
      st.zhiboTarget = null;
      // 触发：有人压我打出的 ≥2 张的牌
      if (ctx.game.prevTableOwnerId() !== ctx.self.id) return;
      const prev = ctx.game.prevTable();
      if (!prev || prev.cards.length <= 1) return;
      if (beater === ctx.self.id) return;
      if (ctx.game.eliminated(beater)) return; // 防御
      if (ctx.game.bpProtected(beater)) return; // 血压（硝烟）全挡：技能不能对压牌者生效
      // 障目门控（目标锁定压牌者）→ 选择询问
      st.gate = 'zhi-bo';
      st.gateTarget = beater;
      st.zhiboStage = 'choice';
      st.zhiboTarget = beater;
      const g = ctx.game.zhangMuCheck(ctx.self.id, beater, 'zhi-bo', () => {
        st.gate = null;
        st.gateTarget = null;
        return zhiBoAsk(ctx, st); // 猜中：进入选择询问
      });
      if (g) {
        if (st.gate && !('ask' in g)) {
          st.gate = null;
          st.gateTarget = null;
          st.zhiboStage = null;
          st.zhiboTarget = null; // 障目已封锁（猜错后对他人发动）：直播失效
        }
        return g;
      }
      st.gate = null;
      st.gateTarget = null;
      return zhiBoAsk(ctx, st); // 直接放行
    },
    onTurnStart(ctx) {
      // 新一轮的第一个回合（轮首 roundLastPlayerId 为空）：约等每回合限一次重置
      if (!ctx.answer && ctx.game.roundLastPlayerId() === null) {
        (ctx.state as ShaShaState).yueDengUsed = false;
      }
    },
  },
};

export default shaSha;
