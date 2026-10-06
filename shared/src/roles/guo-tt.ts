// 角色：橐驼 —— 技能【地坛】+【诅咒】。
// 【地坛】每回合（轮）限一次，当别人（不含自己）打出 ≥3 张的牌型（炸弹/顺子/连对）时，
//   可进行判定：翻一张牌，花色与这手牌中任意一张相同 → 使其处于红楼梦之中，
//   下回合（轮）不得出牌（不能起牌/响应/插队/狂吠/补打，轮到他自动过，照常摸牌）；
//   若其获得本回合牌权（轮末最后出牌者），由橐驼取而代之（摸牌 + 起新回合）。
//   弃权不消耗次数；判定失败消耗次数且判定牌弃置。
//   判定中的王按颜色算双花色（小王 ♠♣、大王 ♥♦，打出的牌里与翻出的判定牌都是；2026-10-03 用户确认）。
// 【诅咒】锁定技：你的王可以直接打出——单王（点数视作无穷）压过一切单张（正序含 2、倒序含 3），
//   对王（双王）压过一切对子（正序含对 2、倒序含对 3），都只有炸弹能压（王压不了王），
//   正倒序一致（倒序下无穷小才是最大的，与用户确认 2026-10-03）。
import { isJoker, jokerSuits } from '../cards';
import type { Combo } from '../engine/combos';
import type { HookContext, HookResult, RoleDef } from './types';

interface GuoTTState {
  /** 本回合是否已判定（每回合限一次：弃权不消耗，失败消耗） */
  judgedThisRound: boolean;
  /** 障目再入：待门控的判定目标 */
  gate: { skillId: 'di-tan'; targetId: string } | null;
}

/** 地坛判定流程（障目门控通过后执行）：翻牌对花色，中则目标下回合不得出牌 */
function diTanJudge(ctx: HookContext, st: GuoTTState, played: Combo, owner: string): HookResult | void {
  const top = ctx.game.revealTop(1, '地坛判定');
  const card = top[0];
  const name = ctx.game.players().find((p) => p.id === owner)?.name ?? owner;
  if (!card) {
    // 牌堆已空无法翻牌：视为未判定，不消耗次数
    ctx.game.discardRevealed();
    ctx.game.announce('guo-tt', 'di-tan', '【地坛】牌堆已空，无法判定');
    return;
  }
  st.judgedThisRound = true; // 判定失败同样消耗
  // 判定中的王按颜色算双花色：打出的牌里的王提供 ♠♣/♥♦，翻出的判定牌是王同样按双花色（2026-10-03 用户确认）
  const playedSuits = new Set<number>(played.cards.flatMap((c) => (isJoker(c) ? jokerSuits(c) : [c.suit])));
  const revealedSuits = isJoker(card) ? jokerSuits(card) : [card.suit];
  const hit = revealedSuits.some((s) => playedSuits.has(s));
  ctx.game.discardRevealed();
  if (hit) {
    ctx.game.curseNextRound(owner);
    ctx.game.announce('guo-tt', 'di-tan', `【地坛】判定成功！${name} 陷入红楼梦：下回合不得出牌`);
    return { ok: true };
  }
  ctx.game.announce('guo-tt', 'di-tan', '【地坛】判定失败，本回合不能再次判定');
}

const guoTT: RoleDef = {
  id: 'guo-tt',
  name: '橐驼',
  // 诅咒：单王/对王可直接打出（引擎按此解锁：压一切单张/对子、只有炸弹能压，正倒序一致）
  soloJoker: true,
  skills: [
    {
      id: 'di-tan',
      name: '地坛',
      description:
        '每回合限一次：别人打出 ≥3 张牌时你可判定（翻一张牌，花色与其中任意一张相同即中，王按颜色算 ♠♣/♥♦），使其下回合不得出牌；若其获得本回合牌权，你取而代之。弃权不消耗，失败消耗。',
    },
    {
      id: 'zu-zhou',
      name: '诅咒',
      locked: true,
      description:
        '你的王可以直接打出：单王压过一切单张（正序含 2、倒序含 3），对王压过一切对子（正序含对 2、倒序含对 3），只有炸弹能压。',
    },
  ],
  setup(): GuoTTState {
    return { judgedThisRound: false, gate: null };
  },
  hooks: {
    onPlayInterrupt(ctx, played) {
      if (played.length < 3) return; // 只对 ≥3 张的牌型（炸弹/顺子/连对）
      const owner = ctx.game.roundLastPlayerId()!;
      const st = ctx.state as GuoTTState;
      // 障目再入（地坛猜牌/摸牌答案）：门控通过后照常判定
      if (st.gate?.skillId === 'di-tan') {
        const { targetId } = st.gate;
        const g = ctx.game.zhangMuCheck(ctx.self.id, targetId, 'di-tan', () => {
          st.gate = null;
          return diTanJudge(ctx, st, played, targetId);
        });
        if (g) {
          if (st.gate && !('ask' in g)) st.gate = null; // 障目猜错/已封锁：清残留门控（防下次钩子误入再问）
          return g;
        }
        st.gate = null;
        return; // 防御
      }
      if (owner === ctx.self.id) return; // 仅他人（2026-10-03 与用户确认）
      if (ctx.game.eliminated(owner)) return;
      if (ctx.game.bpProtected(owner)) return; // 血压（硝烟）全挡：技能不能对打出者生效
      const a = ctx.answer;
      if (!a) {
        if (st.judgedThisRound) return;
        const name = ctx.game.players().find((p) => p.id === owner)?.name ?? owner;
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt: `【地坛】是否判定 ${name} 打出的这手牌（${played.label}）？翻一张牌，花色与其中任意一张相同则其下回合不得出牌（王按颜色算 ♠♣/♥♦；每回合限一次，弃权不消耗）`,
          },
        };
      }
      if (st.judgedThisRound) return; // 防御：同轮重复回答
      if (a.choice !== 'yes') return; // 弃权不消耗
      // 障目门控（指向性：判定对象为辛歼时先猜手牌数；猜错不消耗次数）
      st.gate = { skillId: 'di-tan', targetId: owner };
      const g = ctx.game.zhangMuCheck(ctx.self.id, owner, 'di-tan', () => {
        st.gate = null;
        return diTanJudge(ctx, st, played, owner);
      });
      if (g) {
        if (st.gate && !('ask' in g)) st.gate = null; // 障目已封锁（猜错后对他人发动）：清残留门控
        return g;
      }
      st.gate = null;
      return diTanJudge(ctx, st, played, owner); // 直接放行
    },
    onRoundEnd(ctx) {
      (ctx.state as GuoTTState).judgedThisRound = false; // 每回合（轮）限一次
    },
  },
};

export default guoTT;
