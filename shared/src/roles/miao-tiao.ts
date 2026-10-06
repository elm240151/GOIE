// 角色：苗条 —— 技能【苗条】【尖叫】。
// 【苗条】锁定技：打出 n 种不同花色的牌 → 摸 n 张（出牌后立即，每次出牌都触发；王双计——
//   小王 ♠♣、大王 ♥♦；归属改写后不算自己打出——看 roundLastPlayerId；打光手牌时引擎亡语门控
//   自动跳过本技能，直接进入获胜判定）。
// 【尖叫】(亡语) 每局 X+2 次（X = 人数；成功扣置才消耗次数，弃权/收回/非法提交不消耗）：每回合（轮）
//   开始前扣置手牌——范文（至多 4 张花色互不相同）/ 尖叫鸡（至多 3 张花色相同、点数无要求）；
//   扣置后手牌 ≥1；扣置牌也算手牌（手牌 + 扣置 > 上限即淘汰——引擎 checkHandLimit 同口径）。
//   已有扣置牌未收回时不询问（扣置牌跨回合保留）；非法提交提示重新选牌（重发询问，不消耗次数）。
//   触发：后续第一个打出其中花色（范文，王双花色参与匹配；一次打出几种被扣花色摸回几张对应、
//   剩余继续等下一个）或其中点数（尖叫鸡，一次发完三张）的牌的人摸回对应扣置牌——发给实际
//   打出者（引擎 lastPlayPhysicalId，归属改写前）；亡语：打光手牌的这手牌触发时先摸回、不能
//   即刻获胜；苗条打出会打光的手牌时自动收回全部扣置牌（不消耗次数）。苗条可查看扣置牌、
//   任意时刻收回（主动技按钮 anyTime）。
import type { Card, CardRank } from '../cards';
import { isJoker, jokerSuits } from '../cards';
import type { HeldGroup, RoleDef } from './types';

interface MiaoTiaoState {
  /** 尖叫已扣置次数（每局 X+2 次；扣置行为消耗） */
  jianjiaoUsed: number;
  /** 扣置流程阶段：'idle' = 未进行；'pick' = 已选类型、等选牌 */
  holdStage: 'idle' | 'pick';
  /** 已选扣置类型 */
  holdKind: 'fanwen' | 'jianjiaoji' | null;
}

/** 范文合法性：至多 4 张且花色互不相同（王双花色参与） */
function fanwenValid(cards: Card[]): boolean {
  if (cards.length < 1 || cards.length > 4) return false;
  const suits = new Set<number>();
  for (const c of cards) {
    for (const s of jokerSuitsOf(c)) {
      if (suits.has(s)) return false;
      suits.add(s);
    }
  }
  return true;
}

/** 尖叫鸡合法性：至多 3 张且至少共享一种花色（王双花色参与） */
function jianjiaoValid(cards: Card[]): boolean {
  if (cards.length < 1 || cards.length > 3) return false;
  const sets = cards.map((c) => new Set<number>(jokerSuitsOf(c)));
  const first = [...sets[0]!];
  return first.some((s) => sets.every((set) => set.has(s)));
}

function jokerSuitsOf(c: Card): number[] {
  return isJoker(c) ? jokerSuits(c) : [c.suit];
}

const miaoTiao: RoleDef = {
  id: 'miao-tiao',
  name: '苗条',
  skills: [
    {
      id: 'miao-tiao',
      name: '苗条',
      locked: true,
      description: '锁定技：打出 n 种不同花色的牌 → 摸 n 张（王双计）。',
    },
    {
      id: 'jian-jiao',
      name: '尖叫',
      description:
        '每局 X+2 次：回合开始前扣置手牌（范文至多 4 张花色互异 / 尖叫鸡至多 3 张花色相同），已有扣置牌未收回时不再询问；后续第一个打出其中花色或点数的牌的人摸回对应扣置牌；可任意时刻查看/收回。',
    },
  ],
  // hidden：不在主动技按钮行渲染（查看/收回走手牌上方扣置区弹窗）；动作入口保留供弹窗收回调用
  skillActions: [{ skillId: 'jian-jiao', when: 'myTurn', anyTime: true, hidden: true, label: '查看/收回扣置牌' }],
  deathrattleHooks: ['onPlayInterrupt'],
  setup(): MiaoTiaoState {
    return { jianjiaoUsed: 0, holdStage: 'idle', holdKind: null };
  },
  hooks: {
    afterPlay(ctx, played) {
      if (ctx.game.eliminated(ctx.self.id)) return;
      if (ctx.game.roundLastPlayerId() !== ctx.self.id) return; // 归属改写后不算我打出
      const suits = new Set<number>();
      for (const c of played.cards) {
        for (const s of jokerSuitsOf(c)) suits.add(s);
      }
      const n = suits.size;
      if (n < 1) return;
      ctx.game.draw(ctx.self.id, n);
      ctx.game.announce('miao-tiao', 'miao-tiao', `【苗条】打出 ${n} 种花色，摸 ${n} 张牌`);
    },
    onPlayInterrupt(ctx, played) {
      const physical = ctx.game.lastPlayPhysicalId();
      if (!physical) return;
      const groups = ctx.game.heldGroups();
      // 亡语：苗条自己打光了手牌且有扣置 → 自动收回全部（不消耗次数；手牌非空 → 不获胜）
      if (physical === ctx.self.id && ctx.game.handOf(ctx.self.id).length === 0 && groups.length > 0) {
        ctx.game.takeHeldBack();
        ctx.game.announce('miao-tiao', 'jian-jiao', '【尖叫】打光了手牌，自动收回全部扣置牌');
        return;
      }
      if (groups.length === 0) return;
      if (ctx.game.eliminated(physical)) return;
      if (ctx.game.bpProtected(physical)) return; // 血压全挡：技能不能对其生效（含增益摸牌）
      const playedSuits = new Set<number>();
      for (const c of played.cards) {
        for (const s of jokerSuitsOf(c)) playedSuits.add(s);
      }
      const playedRanks = new Set<CardRank>();
      for (const c of played.cards) {
        if (isJoker(c)) {
          const rep = played.resolved.find((r) => r.cardId === c.id)?.rank;
          if (rep !== undefined) playedRanks.add(rep);
        } else {
          playedRanks.add(c.rank);
        }
      }
      const name = ctx.game.players().find((p) => p.id === physical)?.name ?? physical;
      for (const g of groups) {
        if (g.kind === 'fanwen') {
          const matched = g.cards.filter((c) => jokerSuitsOf(c).some((s) => playedSuits.has(s)));
          if (matched.length > 0) {
            ctx.game.giveHeldTo(physical, matched.map((c) => c.id));
            ctx.game.announce('miao-tiao', 'jian-jiao', `【尖叫】${name} 打出范文花色，摸回 ${matched.length} 张扣置牌`);
          }
        } else {
          // 尖叫鸡：打出被扣点数 → 一次发完该组（王本身无固定点数，不参与点数触发）
          const matched = g.cards.filter((c) => !isJoker(c) && playedRanks.has(c.rank));
          if (matched.length > 0) {
            ctx.game.giveHeldTo(physical, g.cards.map((c) => c.id));
            ctx.game.announce('miao-tiao', 'jian-jiao', `【尖叫】${name} 打出尖叫鸡点数，摸回全部 ${g.cards.length} 张扣置牌`);
          }
        }
      }
    },
    onTurnStart(ctx) {
      if (ctx.game.eliminated(ctx.self.id)) return;
      if (ctx.game.turnPlayerId() !== ctx.game.roundLeaderId()) return;
      if (ctx.game.table()) return; // 只在回合（轮）开始前：桌面为空 = 新一轮起牌；轮回到自己时桌面非空不再问
      const st = ctx.state as MiaoTiaoState;
      const a = ctx.answer;
      const total = ctx.game.players().length + 2;
      // 选牌阶段：校验并扣置
      if (st.holdStage === 'pick') {
        const kind = st.holdKind!;
        const hand = [...ctx.game.handOf(ctx.self.id)];
        const ids = (a?.cardIds ?? []).filter((id) => hand.some((c) => c.id === id));
        if (ids.length === 0) {
          // 选牌阶段放弃：回到类型选择（可改选另一种类型或最终放弃；不消耗次数）
          st.holdStage = 'idle';
          st.holdKind = null;
          const options: string[] = [];
          if (hand.length >= 2) options.push('范文（至多 4 张花色互不相同）');
          options.push('尖叫鸡（至多 3 张花色相同）');
          options.push('放弃');
          return {
            ok: true,
            ask: { kind: 'choice', prompt: '【尖叫】选择扣置类型：', options },
          };
        }
        const cards = ids.map((id) => hand.find((c) => c.id === id)!);
        const ok = (kind === 'fanwen' ? fanwenValid : jianjiaoValid)(cards);
        if (!ok || cards.length >= hand.length) {
          // 非法提交（或扣后手牌为空）：不消耗次数，提示重新选牌（重发询问）
          ctx.game.announce(
            'miao-tiao',
            'jian-jiao',
            `【尖叫】所选牌不合要求，请重新选择（${kind === 'fanwen' ? '范文花色互不相同' : '尖叫鸡花色相同'}，且扣置后手牌 ≥1）`
          );
          const max = Math.min(kind === 'fanwen' ? 4 : 3, hand.length - 1);
          return {
            ok: true,
            ask: {
              kind: 'pickCards',
              prompt: `【尖叫】请重新选择要扣置的 ${kind === 'fanwen' ? '范文（花色互不相同）' : '尖叫鸡（花色相同）'} 牌（至多 ${max} 张）：`,
              cards: hand,
              min: 1,
              max,
            },
          };
        }
        st.jianjiaoUsed++; // 成功扣置才消耗次数
        st.holdStage = 'idle';
        st.holdKind = null;
        ctx.game.holdCards(kind, ids);
        ctx.game.announce(
          'miao-tiao',
          'jian-jiao',
          `【尖叫】扣置 ${cards.length} 张${kind === 'fanwen' ? '范文' : '尖叫鸡'}`
        );
        return { ok: true };
      }
      if (st.jianjiaoUsed >= total) return;
      if (ctx.game.heldGroups().length > 0) return; // 已有扣置牌（跨回合保留）→ 不再询问
      if (!a) {
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt: `【尖叫】回合开始前：是否扣置手牌？（本局还可扣置 ${total - st.jianjiaoUsed} 次；弃权不消耗）`,
          },
        };
      }
      if (a.choice === 'decline') return; // 弃权不消耗
      if (a.choice === 'yes') {
        const hand = ctx.game.handOf(ctx.self.id);
        const options: string[] = [];
        if (hand.length >= 2) options.push('范文（至多 4 张花色互不相同）');
        options.push('尖叫鸡（至多 3 张花色相同）');
        options.push('放弃');
        return {
          ok: true,
          ask: { kind: 'choice', prompt: '【尖叫】选择扣置类型：', options },
        };
      }
      const choice = a.choice ?? '';
      const kind = choice.startsWith('范文') ? 'fanwen' : choice.startsWith('尖叫鸡') ? 'jianjiaoji' : null;
      if (!kind) return; // 放弃（不消耗）
      st.holdStage = 'pick'; // 次数在选牌成功扣置时才消耗
      st.holdKind = kind;
      const hand = [...ctx.game.handOf(ctx.self.id)];
      const max = Math.min(kind === 'fanwen' ? 4 : 3, hand.length - 1); // 扣置后手牌 ≥1
      return {
        ok: true,
        ask: {
          kind: 'pickCards',
          prompt: `【尖叫】选择要扣置的 ${kind === 'fanwen' ? '范文（花色互不相同）' : '尖叫鸡（花色相同）'} 牌（至多 ${max} 张）：`,
          cards: hand,
          min: 1,
          max,
        },
      };
    },
    onSkillAction(ctx, req) {
      const groups: HeldGroup[] = ctx.game.heldGroups();
      if (groups.length === 0) return { ok: false, reason: '没有扣置牌' };
      const ids = (req.cardIds ?? []).filter((id) => groups.some((g) => g.cards.some((c) => c.id === id)));
      let n = 0;
      if (ids.length > 0) {
        ctx.game.takeHeldBack(ids);
        n = ids.length;
      } else {
        n = groups.reduce((s, g) => s + g.cards.length, 0);
        ctx.game.takeHeldBack();
      }
      ctx.game.announce('miao-tiao', 'jian-jiao', `【尖叫】收回 ${n} 张扣置牌`);
      return { ok: true };
    },
  },
};

export default miaoTiao;
