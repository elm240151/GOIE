// 角色：组长 —— 技能【处分】【温柔】。
// 【处分】有人压你的牌时（插队也算；归属改写后视作你的牌被压同样触发——同旺旺口径）选择一项：
//   检讨（压牌者立即摸 2 张手牌，不限次）/ 休学（压牌者下回合整轮不得出牌；若其轮末成为牌权拥有者，
//   由你取而代之——复用引擎 curseNextRound，施加者 = 组长；每局至多 X 次，X = 人数）/ 放弃（不消耗）。
//   非亡语（2026-10-06 用户确认）：压牌者打光手牌即胜，处分不触发（引擎亡语门控自动处理）。
// 【温柔】每局 X 次（X = 人数，弃权不消耗）：回合（轮）开始时发动（无论谁起牌——2026-10-06 用户确认），
//   自选 Y（任意值，受手牌上限 20 与人数约束）→ 多摸 Y 张 + 依次标记至多 Y 名其他成员为「宝贝」
//   （不能标自己，可提前结束）；宝贝本回合无条件不得响应组长的出牌——压牌/插队/吃饼/狂吠/翻面/
//   茄汤成炸/讲题代打等一切出牌类技能响应全禁（引擎守卫），改判/判定/增益类不受影响；轮末自动解除。
import type { RoleDef } from './types';

interface ZuZhangState {
  /** 温柔已用次数（每局 X 次，弃权不消耗） */
  wenrouUsed: number;
  /** 休学已用次数（每局 X 次，弃权不消耗） */
  xiuxueUsed: number;
  /** 温柔进行中：已确认 Y、已摸牌，剩余待标宝贝数（null = 未进行） */
  babiesLeft: number | null;
}

const zuZhang: RoleDef = {
  id: 'zu-zhang',
  name: '组长',
  skills: [
    {
      id: 'chu-fen',
      name: '处分',
      description:
        '有人压你的牌时选择一项：检讨（压牌者立即摸 2 张，不限次）/ 休学（压牌者下回合整轮不得出牌，若其轮末获得牌权则由你取而代之；每局至多 X 次，X = 人数）/ 放弃（不消耗）。',
    },
    {
      id: 'wen-rou',
      name: '温柔',
      description:
        '每局 X 次（X = 人数）：回合开始时自选 Y，多摸 Y 张并令至多 Y 名成员成为「宝贝」（本回合不得响应你的出牌）。',
    },
  ],
  setup(): ZuZhangState {
    return { wenrouUsed: 0, xiuxueUsed: 0, babiesLeft: null };
  },
  hooks: {
    onPlayInterrupt(ctx) {
      // 触发 = 有人压组长的牌（插队也算；归属改写后视作压的是组长的牌同样触发）
      const owner = ctx.game.roundLastPlayerId()!;
      if (ctx.game.prevTableOwnerId() !== ctx.self.id) return;
      if (ctx.game.eliminated(owner)) return; // 防御：目标已不在场则不询问
      if (ctx.game.bpProtected(owner)) return; // 血压（硝烟）全挡：技能不能对压牌者生效
      const st = ctx.state as ZuZhangState;
      const a = ctx.answer;
      const x = ctx.game.players().length;
      const options = ['检讨：压牌者摸 2 张手牌'];
      if (st.xiuxueUsed < x) options.push('休学：压牌者下回合整轮不得出牌');
      options.push('放弃');
      const name = ctx.game.players().find((p) => p.id === owner)?.name ?? owner;
      if (!a) {
        return {
          ok: true,
          ask: {
            kind: 'choice',
            prompt: `【处分】${name} 压了你的牌，选择一项：`,
            options,
            declineAllowed: false, // 放弃已是显式选项，去掉多余弃权按钮（2026-10-06 用户确认；超时按第一项）
          },
        };
      }
      const choice = a.choice ?? '';
      if (choice.startsWith('检讨')) {
        ctx.game.draw(owner, 2);
        ctx.game.announce('zu-zhang', 'chu-fen', `【处分】${name} 被要求检讨，摸 2 张手牌`);
        return { ok: true };
      }
      if (choice.startsWith('休学')) {
        st.xiuxueUsed++;
        ctx.game.curseNextRound(owner); // 施加者 = 组长：下回合整轮不得出牌；其轮末获牌权则由组长取而代之
        ctx.game.announce('zu-zhang', 'chu-fen', `【处分】${name} 被休学，下回合整轮不得出牌`);
        return { ok: true };
      }
      return; // 放弃不消耗
    },
    onTurnStart(ctx) {
      if (ctx.game.eliminated(ctx.self.id)) return;
      if (ctx.game.turnPlayerId() !== ctx.game.roundLeaderId()) return;
      if (ctx.game.table()) return; // 只在回合（轮）开始时：桌面为空 = 新一轮起牌；轮回到自己时桌面非空不再问
      const st = ctx.state as ZuZhangState;
      const a = ctx.answer;
      const x = ctx.game.players().length;
      // 标宝贝阶段：回答目标 → 标记；弃权/超时 → 提前结束
      if (st.babiesLeft != null) {
        if (
          a?.targetPlayerId &&
          a.targetPlayerId !== ctx.self.id &&
          !ctx.game.eliminated(a.targetPlayerId) &&
          !ctx.game.isBaby(a.targetPlayerId)
        ) {
          ctx.game.markBaby(a.targetPlayerId);
          st.babiesLeft--;
          const name = ctx.game.players().find((p) => p.id === a.targetPlayerId)?.name ?? a.targetPlayerId;
          ctx.game.announce('zu-zhang', 'wen-rou', `【温柔】${name} 被标为「宝贝」`);
        } else {
          st.babiesLeft = null;
          ctx.game.announce('zu-zhang', 'wen-rou', '【温柔】标记结束');
          return { ok: true };
        }
        if (st.babiesLeft <= 0) {
          st.babiesLeft = null;
          return { ok: true };
        }
        const candidates = ctx.game
          .players()
          .filter((p) => p.id !== ctx.self.id && !ctx.game.eliminated(p.id) && !ctx.game.isBaby(p.id))
          .map((p) => p.id);
        if (candidates.length === 0) {
          st.babiesLeft = null;
          return { ok: true };
        }
        return {
          ok: true,
          ask: {
            kind: 'pickTarget',
            prompt: `【温柔】再标一名「宝贝」（还可标 ${st.babiesLeft} 名；弃权提前结束）`,
            targetCandidates: candidates,
          },
        };
      }
      if (st.wenrouUsed >= x) return;
      if (!a) {
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt: `【温柔】回合开始：是否发动？自选 Y：多摸 Y 张并令至多 Y 名成员成为「宝贝」（本回合不得响应你的出牌）。每局限 ${x} 次（已用 ${st.wenrouUsed}），弃权不消耗`,
          },
        };
      }
      if (a.choice === 'decline') return; // 弃权不消耗
      if (a.choice === 'yes') {
        // Y 任意值：受手牌上限 20 与人数约束（标宝贝不能标自己）
        const maxY = Math.min(
          20 - ctx.self.handCount,
          ctx.game.players().filter((p) => p.id !== ctx.self.id && !ctx.game.eliminated(p.id)).length
        );
        if (maxY < 1) {
          ctx.game.announce('zu-zhang', 'wen-rou', '【温柔】手牌已满或没有其他成员，无法发动');
          return { ok: true };
        }
        return {
          ok: true,
          ask: {
            kind: 'choice',
            prompt: '【温柔】选择 Y（多摸 Y 张并标至多 Y 名宝贝）：',
            options: Array.from({ length: maxY }, (_, i) => `${i + 1}`),
          },
        };
      }
      const y = Number(a.choice);
      if (!Number.isInteger(y) || y < 1) return; // 防御：非法答案
      st.wenrouUsed++; // 发动即消耗
      ctx.game.draw(ctx.self.id, y);
      ctx.game.announce('zu-zhang', 'wen-rou', `【温柔】多摸 ${y} 张牌`);
      st.babiesLeft = y;
      const candidates = ctx.game
        .players()
        .filter((p) => p.id !== ctx.self.id && !ctx.game.eliminated(p.id))
        .map((p) => p.id);
      if (candidates.length === 0) {
        st.babiesLeft = null;
        return { ok: true };
      }
      return {
        ok: true,
        ask: {
          kind: 'pickTarget',
          prompt: `【温柔】标记一名「宝贝」（还可标 ${y} 名；弃权提前结束）`,
          targetCandidates: candidates,
        },
      };
    },
  },
};

export default zuZhang;
