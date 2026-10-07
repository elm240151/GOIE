// 角色：第五席 雪灾天使 —— 技能【巨石】。
// 有人打出"压一切"的牌时（正序单 2/对 2、倒序单 3/对 3、炸弹、首席的 Q、橐驼的单王/对王），
//   你可以声明一个花色进行判定：翻一张牌，花色一致则驱逐该出牌者（淘汰），你获得牌权；
//   失败则判定牌摸回（本回合不计手牌上限）。
// 每场游戏至多判定（玩家人数 + 2）次。可选发动；判定优先于该出牌者获胜。
// 触发按实体牌判定（答疑改点不影响触发）；倒序镜像按"打出这一手时"的牌序（洄游先判后切）。
// 判定中的王按颜色算双花色（小王 ♠♣、大王 ♥♦，2026-10-03 用户确认）。
// 询问顺序（2026-10-07 用户反馈）：先确认是否发动 → 障目猜手牌数 → 再声明花色 → 最后翻牌判定。
import { isJoker, jokerSuits, RANK_2, RANK_3, SUITS } from '../cards';
import type { HookContext, HookResult, RoleDef } from './types';

interface YyXueState {
  /** 已使用判定次数（每场游戏上限：玩家人数 + 2） */
  used: number;
  /** 障目再入：待门控的技能与目标（花色在门控通过后另行询问） */
  gate: { skillId: 'ju-shi'; targetId: string } | null;
  /** 花色询问挂起：确认发动 + 障目通过后，待声明花色 */
  suitPending: { targetId: string } | null;
}

/** 巨石判定流程（确认发动 + 障目门控 + 花色声明之后执行）：翻牌对花色，成功驱逐该出牌者并夺权 */
function juShiJudge(ctx: HookContext, st: YyXueState, owner: string, choice: string): HookResult | void {
  st.used++;
  const top = ctx.game.revealTop(1, '巨石判定');
  const card = top[0]!;
  const ownerName = ctx.game.players().find((p) => p.id === owner)?.name ?? owner;
  // 判定中的王按颜色算双花色（小王 ♠♣、大王 ♥♦），不再"翻到王必然失败"（2026-10-03 用户确认）
  const hit = isJoker(card)
    ? jokerSuits(card).some((s) => SUITS[s] === choice)
    : SUITS[card.suit] === choice;
  if (hit) {
    ctx.game.discardRevealed();
    ctx.game.announce('yy-xue', 'ju-shi', `【巨石】判定成功！驱逐 ${ownerName}，雪灾天使获得牌权`);
    return { ok: true, modify: { eliminate: [owner], seizeLead: true } };
  }
  // 判定失败：判定牌摸回（takeRevealed 豁免本回合手牌上限）
  ctx.game.takeRevealed(ctx.self.id, [card.id]);
  ctx.game.discardRevealed();
  ctx.game.announce('yy-xue', 'ju-shi', '【巨石】判定失败，判定牌摸回');
}

/** 巨石花色询问（确认发动且障目通过后）：声明花色进行判定，弃权不消耗判定次数 */
function juShiAskSuit(ctx: HookContext, st: YyXueState, owner: string): HookResult | void {
  const ownerName = ctx.game.players().find((p) => p.id === owner)?.name ?? owner;
  st.suitPending = { targetId: owner };
  return {
    ok: true,
    ask: {
      kind: 'suit',
      prompt: `【巨石】请声明花色驱逐 ${ownerName}（翻到该花色即驱逐；弃权不消耗判定次数，本场还可判定 ${ctx.game.players().length + 2 - st.used} 次）`,
      options: [...SUITS],
    },
  };
}

const yyXue: RoleDef = {
  id: 'yy-xue',
  seatOrder: 5,
  // 亡语（2026-10-05 用户定稿）：巨石在出牌者打光手牌后仍可判定驱逐（优先于其获胜）
  deathrattleHooks: ['onPlayInterrupt'],
  name: '第五席 雪灾天使',
  skills: [
    {
      id: 'ju-shi',
      name: '巨石',
      description:
        '有人打出压一切的牌（正序 2/对 2、倒序 3/对 3、炸弹、首席的 Q、橐驼的单王与对王）时可声明花色判定，翻到该花色即驱逐该玩家并夺权，失败则判定牌摸回。判定中的王按颜色算 ♠♣/♥♦。',
    },
  ],
  setup(): YyXueState {
    return { used: 0, gate: null, suitPending: null };
  },
  hooks: {
    onPlayInterrupt(ctx, played) {
      const owner = ctx.game.roundLastPlayerId()!;
      const st = ctx.state as YyXueState;
      // 障目再入（巨石猜牌/摸牌答案）：门控通过后先声明花色再判定（2026-10-07 用户反馈）
      if (st.gate?.skillId === 'ju-shi') {
        const { targetId } = st.gate;
        const g = ctx.game.zhangMuCheck(ctx.self.id, targetId, 'ju-shi', () => {
          st.gate = null;
          return juShiAskSuit(ctx, st, targetId);
        });
        if (g) {
          if (st.gate && !('ask' in g)) st.gate = null; // 障目猜错/已封锁：清残留门控（防下次钩子误入再问）
          return g;
        }
        st.gate = null;
        return; // 防御
      }
      // 花色答案再入：校验后执行判定（弃权/非法不消耗次数）
      if (st.suitPending) {
        const { targetId } = st.suitPending;
        st.suitPending = null;
        const choice = ctx.answer?.choice ?? '';
        if (choice === 'decline' || !(SUITS as readonly string[]).includes(choice)) return;
        return juShiJudge(ctx, st, targetId, choice);
      }
      if (owner === ctx.self.id) return;
      if (ctx.game.bpProtected(owner)) return; // 血压（硝烟）全挡：技能不能对打出者生效（含驱逐）
      const ownerName = ctx.game.players().find((p) => p.id === owner)?.name ?? owner;
      const ownerRole = ctx.game.players().find((p) => p.id === owner)?.roleId;
      // 按实体牌判定：答疑（修勾）改点只改判定点数，不改变"打出的是 2"这一事实——
      // 对 2 即使被答疑改点，巨石仍可判定（避免触发与否取决于钩子执行顺序）
      // 倒序镜像（2026-10-03 用户确认）：按"打出这一手时"的牌序取压一切的牌（3 触发、2 不触发）
      const rev = ctx.game.lastPlayOrderReversed();
      const bigRank = rev ? RANK_3 : RANK_2;
      const trigger =
        (played.type === 'single' && played.cards[0]!.rank === bigRank) ||
        (played.type === 'pair' && played.cards.every((c) => isJoker(c) || c.rank === bigRank)) ||
        played.type === 'bomb' ||
        played.type === 'singleJoker' || // 橐驼单王：带"2 性质"压一切单张，正倒序都触发（2026-10-03 用户确认）
        played.type === 'jokerPair' || // 橐驼对王：压一切对子，正倒序都触发（2026-10-03 用户确认）
        (played.type === 'single' && played.cards[0]!.rank === 12 && ownerRole === 'skywalker'); // 首席的 Q（倒序同样压一切单张）
      if (!trigger) return;
      if (st.used >= ctx.game.players().length + 2) return; // 判定次数用尽
      if (!ctx.answer) {
        // 2026-10-07 用户反馈：先问是否发动，发动后（障目猜牌）再声明花色，最后才翻牌判定
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt: `是否发动【巨石】驱逐 ${ownerName}？（发动后先声明花色再翻牌判定，翻到该花色即驱逐；本场还可判定 ${ctx.game.players().length + 2 - st.used} 次，弃权不消耗）`,
          },
        };
      }
      if (ctx.answer.choice !== 'yes') return; // 放弃：不消耗判定次数
      // 障目门控（指向性：判定对象为辛歼时先猜手牌数；猜错不消耗判定次数）
      st.gate = { skillId: 'ju-shi', targetId: owner };
      const g = ctx.game.zhangMuCheck(ctx.self.id, owner, 'ju-shi', () => {
        st.gate = null;
        return juShiAskSuit(ctx, st, owner);
      });
      if (g) {
        if (st.gate && !('ask' in g)) st.gate = null; // 障目已封锁（猜错后对他人发动）：清残留门控
        return g;
      }
      st.gate = null;
      return juShiAskSuit(ctx, st, owner); // 直接放行
    },
  },
};

export default yyXue;
