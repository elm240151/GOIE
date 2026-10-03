// 角色：第五席 雪灾天使 —— 技能【巨石】。
// 有人打出单 2 / 对 2 / 炸弹（或首席的 Q）时，你可以声明一个花色进行判定：
// 翻一张牌，花色一致则驱逐该出牌者（淘汰），你获得牌权；失败则判定牌摸回（本回合不计手牌上限）。
// 每场游戏至多判定（玩家人数 + 2）次。可选发动；判定优先于该出牌者获胜。
import { isJoker, SUITS } from '../cards';
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
    { id: 'ju-shi', name: '巨石', description: '有人出 2（含首席的 Q）或炸弹时可声明花色判定，一致则驱逐该玩家并夺权，失败则判定牌摸回。' },
  ],
  setup(): YyXueState {
    return { used: 0 };
  },
  hooks: {
    onPlayInterrupt(ctx, played) {
      const owner = ctx.game.roundLastPlayerId()!;
      if (owner === ctx.self.id) return;
      const ownerRole = ctx.game.players().find((p) => p.id === owner)?.roleId;
      const trigger =
        (played.type === 'single' && played.rank === 15) ||
        (played.type === 'pair' && played.rank === 15) ||
        played.type === 'bomb' ||
        (played.type === 'single' && played.rank === 12 && ownerRole === 'skywalker'); // 首席的 Q
      if (!trigger) return;
      const state = ctx.state as YyXueState;
      if (state.used >= ctx.game.players().length + 2) return; // 判定次数用尽
      if (!ctx.answer) {
        return {
          ok: true,
          ask: {
            kind: 'suit',
            prompt: `是否发动【巨石】驱逐 ${owner}？请声明花色（翻到该花色即驱逐，本场还可判定 ${ctx.game.players().length + 2 - state.used} 次）`,
            options: [...SUITS],
          },
        };
      }
      const choice = ctx.answer.choice ?? '';
      if (choice === 'decline' || !(SUITS as readonly string[]).includes(choice)) return; // 放弃/非法
      state.used++;
      const top = ctx.game.revealTop(1, '巨石判定');
      const card = top[0]!;
      const hit = !isJoker(card) && SUITS[card.suit] === choice;
      if (hit) {
        ctx.game.discardRevealed();
        ctx.game.announce('yy-xue', 'ju-shi', `【巨石】判定成功！驱逐 ${owner}，雪灾天使获得牌权`);
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
