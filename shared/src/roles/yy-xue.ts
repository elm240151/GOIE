// 角色：第五席 雪灾天使 —— 技能【巨石】。
// 有人打出"压一切"的牌时（正序单 2/对 2、倒序单 3/对 3、炸弹、首席的 Q、橐驼的单王/对王），
//   你可以声明一个花色进行判定：翻一张牌，花色一致则驱逐该出牌者（淘汰），你获得牌权；
//   失败则判定牌摸回（本回合不计手牌上限）。
// 每场游戏至多判定（玩家人数 + 2）次。可选发动；判定优先于该出牌者获胜。
// 触发按实体牌判定（答疑改点不影响触发）；倒序镜像按"打出这一手时"的牌序（洄游先判后切）。
// 判定中的王按颜色算双花色（小王 ♠♣、大王 ♥♦，2026-10-03 用户确认）。
import { isJoker, jokerSuits, RANK_2, RANK_3, SUITS } from '../cards';
import type { RoleDef } from './types';

interface YyXueState {
  /** 已使用判定次数（每场游戏上限：玩家人数 + 2） */
  used: number;
}

const yyXue: RoleDef = {
  id: 'yy-xue',
  seatOrder: 5,
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
    return { used: 0 };
  },
  hooks: {
    onPlayInterrupt(ctx, played) {
      const owner = ctx.game.roundLastPlayerId()!;
      if (owner === ctx.self.id) return;
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
      const state = ctx.state as YyXueState;
      if (state.used >= ctx.game.players().length + 2) return; // 判定次数用尽
      if (!ctx.answer) {
        return {
          ok: true,
          ask: {
            kind: 'suit',
            prompt: `是否发动【巨石】驱逐 ${ownerName}？请声明花色（翻到该花色即驱逐，弃权不消耗次数，本场还可判定 ${ctx.game.players().length + 2 - state.used} 次）`,
            options: [...SUITS],
          },
        };
      }
      const choice = ctx.answer.choice ?? '';
      if (choice === 'decline' || !(SUITS as readonly string[]).includes(choice)) return; // 放弃/非法
      state.used++;
      const top = ctx.game.revealTop(1, '巨石判定');
      const card = top[0]!;
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
    },
  },
};

export default yyXue;
