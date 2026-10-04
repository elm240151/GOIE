// 角色：惰戈 —— 技能【亢奋】【法音】。
// 【亢奋】锁定技（引擎 RoleDef.exciteOnPlay 标志，无需询问）：场上有人打出的手牌点数和 ≥20 时
//   （点数和 = 牌面点数：2 记 2、A 记 1、J=11、Q=12、K=13；王按所当点数、单王/对王视为无穷——
//   2026-10-04 用户确认），该手牌在打出那一刻即视作惰戈打出：海棠洄游等实际出牌者技能不触发、
//   接牌轮转从惰戈下家继续（原出牌者不跳过、仍可接）、巨石/地坛等判定对惰戈生效、
//   轮末无人再接则惰戈获得牌权、打完手牌仍按实际出牌者获胜；惰戈淘汰后失效。
//   适用于一切「打出」（正常出牌/插队/狂吠连压/翻面接/茄汤强制炸弹）。
// 【法音】每当惰戈打出的牌（含亢奋归属的牌）中至少两种不同花色（王算其包含的两种花色）时，
//   惰戈可选择一位角色（含自己）弃置一张牌——被弃者自选弃哪张（弃置进弃牌堆）；
//   惰戈手牌 ≤3 时不能选自己（仍可选别人）；每次打出都可触发，无次数限制；弃权/超时无事发生。
import { isJoker, jokerSuits } from '../cards';
import type { RoleDef } from './types';

interface DuoGeState {
  /** 法音阶段二选定的弃牌目标（多阶段重跑复用） */
  target: string | null;
}

const duoGe: RoleDef = {
  id: 'duo-ge',
  name: '惰戈',
  // 高于阿色（900）：亢奋归属的手被再问二次改写前，法音先按「惰戈打出」触发（打出那一刻的口径）
  priority: 950,
  // 亢奋锁定技：点数和 ≥20 的手牌打出那一刻归属改写（引擎按此标志在提交路径自动改写）
  exciteOnPlay: true,
  skills: [
    {
      id: 'kang-fen',
      name: '亢奋',
      locked: true,
      description:
        '锁定技：有人打出的手牌点数和 ≥20（2 记 2、A 记 1，王按所当点数，单王/对王视为无穷）时，该手牌打出那一刻即视为你打出：不触发实际出牌者的技能，接牌从你的下家继续（原出牌者仍可接），判定对你生效，轮末牌权归你，打完仍按实际出牌者获胜。',
    },
    {
      id: 'fa-yin',
      name: '法音',
      description:
        '每当你打出的牌中有至少两种不同花色（王算两种花色），可选择一位角色弃置一张牌（被弃者自选弃哪张）。你手牌 ≤3 时不能选自己。',
    },
  ],
  setup(): DuoGeState {
    return { target: null };
  },
  hooks: {
    afterPlay(ctx, combo) {
      if (ctx.game.eliminated(ctx.self.id)) return;
      // 只对算自己打出的手生效（自己实际打出 + 亢奋归属）
      if (ctx.game.roundLastPlayerId() !== ctx.self.id) return;
      // 至少两种不同花色（王按包含花色双计：小王 ♠♣、大王 ♥♦）
      const suits = new Set<number>();
      for (const c of combo.cards) {
        for (const s of isJoker(c) ? jokerSuits(c) : [c.suit]) suits.add(s);
      }
      if (suits.size < 2) return;
      const st = ctx.state as DuoGeState;
      const a = ctx.answer;
      if (!a) {
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt: '是否发动【法音】？选择一位角色弃置一张牌（被弃者自选弃哪张；你手牌 ≤3 时不能选自己）',
          },
        };
      }
      if (a.choice === 'decline') {
        st.target = null; // 弃权/超时：无事发生（法音无次数限制；重置阶段二残留，防污染下次询问）
        return;
      }
      if (!st.target) {
        // 阶段二：选目标（含自己；自己手牌 ≤3 时不可选自己）
        const t = a.targetPlayerId;
        if (t) {
          const th = ctx.game.handOf(t);
          const okT = !ctx.game.eliminated(t) && th.length > 0 && (t !== ctx.self.id || th.length > 3);
          if (!okT) return; // 防御：非法目标视为弃权
          st.target = t;
        } else {
          const candidates = ctx.game
            .players()
            .filter((p) => !ctx.game.eliminated(p.id) && ctx.game.handOf(p.id).length > 0)
            .filter((p) => p.id !== ctx.self.id || ctx.game.handOf(ctx.self.id).length > 3)
            .map((p) => p.id);
          if (candidates.length === 0) return; // 无人可弃（防御）
          return {
            ok: true,
            ask: {
              kind: 'pickTarget',
              prompt: '【法音】选择一位角色弃置一张牌（被弃者自选弃哪张）',
              targetCandidates: candidates,
            },
          };
        }
      }
      // 阶段三：被弃者自选一张弃（目标是自己则问自己；弃权/超时无事发生）
      if (!a.cardIds) {
        const hand = ctx.game.handOf(st.target);
        if (hand.length === 0) {
          st.target = null;
          return;
        }
        return {
          ok: true,
          ask: {
            kind: 'pickCards',
            prompt: '【法音】请弃置一张牌（弃权/超时则无事发生）',
            cards: [...hand],
            min: 1,
            max: 1,
            askPlayerId: st.target,
          },
        };
      }
      const target = st.target;
      st.target = null;
      const hand = ctx.game.handOf(target);
      const card = hand.find((c) => c.id === a.cardIds![0]);
      if (!card) return; // 防御：牌不在其手牌
      ctx.game.discardFromHand(target, [card.id]);
      const name = ctx.game.players().find((p) => p.id === target)?.name ?? target;
      ctx.game.announce('duo-ge', 'fa-yin', `${name} 弃置一张牌`);
    },
  },
};

export default duoGe;
