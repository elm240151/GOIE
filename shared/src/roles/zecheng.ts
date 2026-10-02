// 角色：末席 肖亡 —— 技能【观股】。
// 当你拥有牌权（一轮最后出牌者）时，摸牌改为展示 5 张：
// 红色多于黑色 → 大涨：每人 1 张，从自己开始按座位序依次自选（弃权/超时自动拿剩余最小牌），多出的弃置；
// 否则（含平局）→ 大跌：自己从展示牌中自选 2 张拿走。
import { cardColor } from '../cards';
import type { Card } from '../cards';
import type { RoleDef } from './types';

interface ZechengState {
  /** 判定展示阶段：当前展示池（公开信息）；null = 无进行中判定 */
  pool: Card[] | null;
  /** 大涨自选队列：ids = 从自己开始按座位序；next = 当前轮到者下标 */
  boom: { ids: string[]; next: number } | null;
}

const zecheng: RoleDef = {
  id: 'zecheng',
  seatOrder: 8,
  name: '末席 肖亡',
  skills: [
    { id: 'guan-gu', name: '观股', description: '拥有牌权时摸牌改为展示 5 张：红多大涨每人 1 张（依次自选，弃权/超时拿最小），否则大跌自己拿 2 张。' },
  ],
  setup(): ZechengState {
    return { pool: null, boom: null };
  },
  hooks: {
    onRoundEnd(ctx, lastPlayerId) {
      if (lastPlayerId !== ctx.self.id) return;
      const st = ctx.state as ZechengState;
      const a = ctx.answer;
      if (!a) {
        return { ok: true, ask: { kind: 'confirm', prompt: '是否发动【观股】？展示 5 张：红多则大涨，否则大跌' } };
      }
      // 大涨自选进行中：处理当前被询问者的选择（弃权/超时 → 自动拿剩余最小牌）
      if (st.boom && st.pool) {
        const pid = st.boom.ids[st.boom.next]!;
        const chosen = (a.cardIds ?? []).filter((id) => st.pool!.some((c) => c.id === id)).slice(0, 1);
        let card: Card;
        if (chosen.length > 0) {
          card = st.pool.find((c) => c.id === chosen[0]!)!;
        } else {
          // 弃权/超时/非法答案：自动给剩余最小的牌（点数升序，同点数按花色升序）
          card = [...st.pool].sort((x, y) => (x.rank !== y.rank ? x.rank - y.rank : x.suit - y.suit))[0]!;
          const name = ctx.game.players().find((p) => p.id === pid)?.name ?? pid;
          ctx.game.announce('zecheng', 'guan-gu', `【观股】${name} 未选，自动获得最小牌`);
        }
        ctx.game.giveRevealed(pid, [card.id]);
        st.pool = st.pool.filter((c) => c.id !== card.id);
        st.boom.next++;
        if (st.boom.next < st.boom.ids.length && st.pool.length > 0) {
          // 下一位自选（弃权/超时同路径：自动拿最小并继续）
          return {
            ok: true,
            ask: { kind: 'pickCards', prompt: '【观股】大涨！自选 1 张（弃权/超时自动拿最小牌）', cards: [...st.pool], min: 1, max: 1, askPlayerId: st.boom.ids[st.boom.next]! },
          };
        }
        // 队列走完（或牌已分完）：多出的弃置
        if (st.pool.length > 0) ctx.game.discardRevealed();
        st.pool = null;
        st.boom = null;
        ctx.game.announce('zecheng', 'guan-gu', '【观股】大涨！每人 1 张');
        return { ok: true, modify: { suppressDraw: true } };
      }
      // 大跌选牌阶段：复用已展示的牌
      if (st.pool) {
        if (a.choice === 'decline') {
          // 弃权（含超时自动弃权）：弃置已展示的判定牌，按正常摸牌处理——不清空会触发引擎守恒断言
          ctx.game.discardRevealed();
          st.pool = null;
          ctx.game.announce('zecheng', 'guan-gu', '【观股】弃权，判定牌弃置');
          return;
        }
        const takeIds = a.cardIds?.filter((id) => st.pool!.some((c) => c.id === id)) ?? [];
        ctx.game.giveRevealed(ctx.self.id, takeIds);
        ctx.game.discardRevealed();
        st.pool = null;
        ctx.game.announce('zecheng', 'guan-gu', '【观股】大跌！拿走 2 张');
        return { ok: true, modify: { suppressDraw: true } };
      }
      // 确认阶段弃权 → 正常摸牌
      if (a.choice === 'decline') return;
      // 同意：展示 5 张（revealTop 会广播给所有人；展示池随快照继续公开）
      const top = ctx.game.revealTop(5, '观股');
      st.pool = [...top];
      const reds = top.filter((c) => cardColor(c) === 'red').length;
      if (reds > top.length - reds) {
        // 大涨：从自己开始按座位序依次自选 1 张，弃权/超时自动拿剩余最小牌，多出的弃置
        const ids = [ctx.self.id, ...ctx.game.players().map((p) => p.id).filter((id) => id !== ctx.self.id)];
        st.boom = { ids, next: 0 };
        return {
          ok: true,
          ask: { kind: 'pickCards', prompt: '【观股】大涨！自选 1 张（弃权/超时自动拿最小牌）', cards: [...top], min: 1, max: 1, askPlayerId: ids[0]! },
        };
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
