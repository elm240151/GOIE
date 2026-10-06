// 角色：硝烟 —— 技能【讲题】【血压】。
// 【讲题】每回合（轮）限一次：轮到硝烟出牌（起牌或接牌）且未被禁打时发动——摸 1 张 → 指定任意
//   一名其他玩家（含被诅咒者；不能指定自己）替他出牌。代打者按正常管牌规则打（起牌时领出、
//   接牌时压桌面牌）；打出则视作硝烟打出（归属改写：轮转从硝烟下家继续、判定对硝烟生效）；
//   未能打出（弃权/超时）→ 代打者选择一项：令硝烟弃置一张牌（硝烟自选弃哪张）或其从牌堆摸一张牌。
//   结算后硝烟仍可继续出牌（讲题不算硝烟出牌动作；失败后仍可出）。
//   讲题本质是硝烟出牌（2026-10-06 用户确认）：硝烟本人被禁打/抽你限制/为宝贝时不能发动
//   （stage-0 与引擎 resolveProxyPlay 均走 playGateBlocked）；代打者本人被诅咒/罚站仍可代打
//   （讲题强制代打优先于禁打）；温柔「宝贝」也不得代打组长的牌（resolveProxyPlay 守卫）。
// 【血压】锁定技（引擎守卫 RoleDef.bloodPressure）：手牌 ≥8 时其余人的技能一律不能对硝烟生效
//   （含增益，引擎各技能守卫 bpProtected）；禁打对其无效（playBanned 豁免）；动态生效。
import type { RoleDef } from './types';

interface XiaoYanState {
  /** 本回合是否已发动讲题（每回合限一次，发动即消耗；轮末重置） */
  jiangtiUsed: boolean;
  /** 讲题阶段：0 = 未进行；1 = 已摸牌待选代打者；2 = 已发出代打请求；3 = 等待惩罚选择；4 = 等硝烟自选弃牌 */
  stage: number;
  /** 代打者 id */
  proxyId: string;
}

const xiaoYan: RoleDef = {
  id: 'xiao-yan',
  name: '硝烟',
  bloodPressure: true,
  skills: [
    {
      id: 'jiang-ti',
      name: '讲题',
      description:
        '每回合限一次：轮到你的回合且未被禁打时，摸 1 张并指定一人替你出牌（其打出视作你打出）；其未能打出则选择：令你弃置一张牌或他自己摸一张牌。结算后你仍可继续出牌。',
    },
    {
      id: 'xue-ya',
      name: '血压',
      locked: true,
      description: '锁定技：手牌 ≥8 时其余人的技能一律不能对你生效（含增益），禁打无效。',
    },
  ],
  setup(): XiaoYanState {
    return { jiangtiUsed: false, stage: 0, proxyId: '' };
  },
  hooks: {
    onTurnStart(ctx) {
      if (ctx.game.eliminated(ctx.self.id)) return;
      if (ctx.game.turnPlayerId() !== ctx.self.id) return; // 轮到硝烟出牌时
      const st = ctx.state as XiaoYanState;
      const a = ctx.answer;
      // 防御：无回答的重新调用 = 新一次轮到（上一手讲题已成功出牌、钩子链未续跑），阶段归零
      if (!a) st.stage = 0;
      const selfName = ctx.self.name;
      const proxyName = () =>
        ctx.game.players().find((p) => p.id === st.proxyId)?.name ?? st.proxyId;
      // 阶段 1：选代打者
      if (st.stage === 1) {
        const target = a?.targetPlayerId;
        if (!target || target === ctx.self.id || ctx.game.eliminated(target)) {
          st.stage = 0;
          ctx.game.announce('xiao-yan', 'jiang-ti', '【讲题】未指定代打者，放弃');
          return { ok: true };
        }
        st.proxyId = target;
        st.stage = 2;
        return {
          ok: true,
          ask: {
            kind: 'proxyPlay',
            askPlayerId: target,
            prompt: `【讲题】${selfName} 指定你替他出牌：选牌打出（按正常管牌规则，打出视作他打出），弃权则选择惩罚`,
          },
        };
      }
      // 阶段 2：代打结果（成功出牌时钩子链不续跑；重跑 = 弃权/超时，即未能打出）
      if (st.stage === 2) {
        st.stage = 3;
        return {
          ok: true,
          ask: {
            kind: 'choice',
            askPlayerId: st.proxyId,
            prompt: `【讲题】${proxyName()} 未能替你出牌，选择一项：`,
            options: [`令${selfName}弃置一张牌（由其自选）`, '你从牌堆摸一张牌'],
            declineAllowed: false, // 惩罚二选一必须作答（2026-10-06 用户确认：对别人产生的效果不能弃权；超时按第一项）
          },
        };
      }
      // 阶段 3：惩罚选择
      if (st.stage === 3) {
        const choice = a?.choice ?? '';
        st.stage = 0;
        if (choice.startsWith('令')) {
          const hand = [...ctx.game.handOf(ctx.self.id)];
          if (hand.length === 0) {
            ctx.game.announce('xiao-yan', 'jiang-ti', '【讲题】硝烟已无手牌可弃');
            return { ok: true };
          }
          st.stage = 4;
          return {
            ok: true,
            ask: {
              kind: 'pickCards',
              prompt: `【讲题】${proxyName()} 选择令你弃置一张牌——自选要弃的牌（超时自动弃置第一张）：`,
              cards: hand,
              min: 1,
              max: 1,
              declineAllowed: false, // 惩罚弃牌必须执行（2026-10-06 用户确认；超时自动弃第一张）
            },
          };
        }
        if (choice.startsWith('你从牌堆')) {
          ctx.game.draw(st.proxyId, 1);
          ctx.game.announce('xiao-yan', 'jiang-ti', `【讲题】${proxyName()} 选择从牌堆摸一张牌`);
        }
        // 结算后硝烟仍可继续出牌（本钩子返回后轮到硝烟，无其它改动）
        return { ok: true };
      }
      // 阶段 4：硝烟自选弃牌
      if (st.stage === 4) {
        st.stage = 0;
        const ids = (a?.cardIds ?? []).filter((id) => ctx.game.handOf(ctx.self.id).some((c) => c.id === id));
        if (ids.length > 0) {
          ctx.game.discardFromHand(ctx.self.id, ids.slice(0, 1));
          ctx.game.announce('xiao-yan', 'jiang-ti', '【讲题】硝烟弃置了一张牌');
        }
        return { ok: true };
      }
      // 阶段 0：询问是否发动
      if (st.jiangtiUsed) return;
      // 讲题本质是硝烟出牌（2026-10-06 用户确认）：硝烟本人被技能影响不允许出牌则不能发动——
      // 禁打（血压 ≥8 自动豁免）/抽你响应限制/宝贝守卫统一走引擎出牌门控
      if (ctx.game.playGateBlocked(ctx.self.id)) return;
      if (!a) {
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt:
              '【讲题】轮到你了：是否发动？摸 1 张并指定一人替你出牌（其打出视作你打出；未能打出则其选择：令你弃 1 张或其摸 1 张）。每回合限一次，弃权不消耗',
          },
        };
      }
      if (a.choice !== 'yes') return; // 弃权不消耗
      st.jiangtiUsed = true; // 发动即消耗
      ctx.game.draw(ctx.self.id, 1);
      st.stage = 1;
      const candidates = ctx.game
        .players()
        .filter((p) => p.id !== ctx.self.id && !ctx.game.eliminated(p.id))
        .map((p) => p.id);
      if (candidates.length === 0) {
        st.stage = 0;
        ctx.game.announce('xiao-yan', 'jiang-ti', '【讲题】没有其他成员可代打');
        return { ok: true };
      }
      return {
        ok: true,
        ask: { kind: 'pickTarget', prompt: '【讲题】指定一人替你出牌：', targetCandidates: candidates },
      };
    },
    onRoundEnd(ctx) {
      const st = ctx.state as XiaoYanState;
      st.jiangtiUsed = false;
      st.stage = 0;
    },
  },
};

export default xiaoYan;
