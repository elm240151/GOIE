// 角色：末席 肖亡 —— 技能【观股】。
// 当你拥有牌权（一轮最后出牌者）时，摸牌改为展示 5 张：
// 红色多于黑色 → 大涨：每人 1 张（按座位序从自己开始，展示顺序发放，多出的弃置）；
// 否则（含平局）→ 大跌：自己从展示牌中自选 2 张拿走。
import { cardColor } from '../cards';
import type { RoleDef } from './types';

interface ZechengState {
  /** 大跌选牌阶段暂存的展示牌 id（询问恢复时复用，避免重复翻牌） */
  revealedIds: number[] | null;
}

const zecheng: RoleDef = {
  id: 'zecheng',
  seatOrder: 8,
  name: '末席 肖亡',
  skills: [
    { id: 'guan-gu', name: '观股', description: '拥有牌权时摸牌改为展示 5 张：红多大涨每人 1 张，否则大跌自己拿 2 张。' },
  ],
  setup(): ZechengState {
    return { revealedIds: null };
  },
  hooks: {
    onRoundEnd(ctx, lastPlayerId) {
      if (lastPlayerId !== ctx.self.id) return;
      const st = ctx.state as ZechengState;
      const a = ctx.answer;
      if (!a) {
        return { ok: true, ask: { kind: 'confirm', prompt: '是否发动【观股】？展示 5 张：红多则大涨，否则大跌' } };
      }
      if (a.choice === 'decline') {
        // 弃权（含超时自动弃权）：弃置已展示的判定牌，按正常摸牌处理——不清空会触发引擎守恒断言
        if (st.revealedIds) {
          ctx.game.discardRevealed();
          st.revealedIds = null;
          ctx.game.announce('zecheng', 'guan-gu', '【观股】弃权，判定牌弃置');
        }
        return;
      }
      // 大跌选牌阶段：复用已展示的牌
      if (st.revealedIds) {
        const takeIds = a.cardIds?.filter((id) => st.revealedIds!.includes(id)) ?? [];
        ctx.game.giveRevealed(ctx.self.id, takeIds);
        ctx.game.discardRevealed();
        st.revealedIds = null;
        ctx.game.announce('zecheng', 'guan-gu', '【观股】大跌！拿走 2 张');
        return { ok: true, modify: { suppressDraw: true } };
      }
      // 展示 5 张（revealTop 会广播给所有人；大跌选牌阶段靠快照 revealed 池继续公开）
      const top = ctx.game.revealTop(5, '观股');
      st.revealedIds = top.map((c) => c.id);
      const reds = top.filter((c) => cardColor(c) === 'red').length;
      if (reds > top.length - reds) {
        // 大涨：按座位序从自己开始每人 1 张，多出的弃置
        const seats = [ctx.self.id, ...ctx.game.players().map((p) => p.id).filter((id) => id !== ctx.self.id)];
        let i = 0;
        for (const pid of seats) {
          if (i >= top.length) break;
          ctx.game.giveRevealed(pid, [top[i]!.id]);
          i++;
        }
        ctx.game.discardRevealed();
        st.revealedIds = null;
        ctx.game.announce('zecheng', 'guan-gu', '【观股】大涨！每人 1 张');
        return { ok: true, modify: { suppressDraw: true } };
      }
      // 大跌：自己选 2 张
      return {
        ok: true,
        ask: { kind: 'pickCards', prompt: '【观股】大跌！自选 2 张拿走', cards: top, min: 2, max: 2 },
      };
    },
  },
};

export default zecheng;
