# 角色开发规范（★ 未来工作核心文件）

**加一个角色 = 在 `shared/src/roles/` 放一个文件（`export default RoleDef`），零其他改动。** node/client 两个 loader 自动发现，注册表校验唯一性。19 个已实现角色就是最好的模板（见文末表）。**只有前 8 席角色名字带「第 X 席」前缀并填 `seatOrder`（1=首席…8=末席）；之后的角色名字不带席位前缀、不填 seatOrder**（按注册序排在已编号角色之后，阿色即如此）。带席位前缀的角色记得填 `seatOrder`（1=首席…），选角列表按席位序展示。

## RoleDef 接口（shared/src/roles/types.ts）

```ts
interface RoleDef {
  id: string;                 // kebab-case 唯一（注册表校验，重复报错）
  seatOrder?: number;         // 席位顺序：选角列表展示排序（1=首席…8=末席）；只有前 8 席填，之后的角色不填（排在已编号角色之后）
  name: string;               // 中文角色名，如 '首席 杰杰一世'
  skills: SkillDef[];         // 技能列表（1-4 个）：{ id, name, description, locked? }
  maxPerRoom?: number;        // 同一房间最多几人选，默认 1
  priority?: number;          // 钩子执行顺序：大者先，同优先级按座位序（确定性）
  hooks?: Partial<RoleHooks>; // 用到哪些钩子写哪些
  deathrattleHooks?: (keyof RoleHooks)[]; // 亡语（2026-10-05 用户定稿）：出牌者打光手牌后仍可触发的钩子白名单。未标注的 afterPlay/onPlayInterrupt 钩子在打光那一刻被引擎跳过（游戏立即结束）。目前标注 ['onPlayInterrupt'] 的有楠王旺旺、雪灾巨石、陈正（五连鞭+压腿）；除非用户明确说是亡语，否则不要标注
  setup?(ctx: RoleSetupContext): unknown; // 角色私有状态：JSON 安全，随快照同步
  skillActions?: SkillActionDef[]; // 客户端技能按钮：{ skillId, when:'myTurn'|'following', onlyWhenLeader?, anyTime?, hidden?, label }，通用渲染。onlyWhenLeader（陈正见习/反力矩）：只有拥有牌权（本回合起牌者）时按钮可用、引擎同样校验；hidden（苗条尖叫）：不在按钮行渲染（交互改由其他 UI 承担），但引擎动作入口保留
  canCutIn?: boolean;         // 可插队响应（无名）——引擎提供插队机制，角色只挂标志；加牌 X = 响应牌中与被压牌同花色的真牌点数总和（点数 = 牌面点数：2 记 2、A 记 1、J=11、Q=12、K=13，2026-10-06 用户确认；王不参与），引擎 matchSuitDrawX 统一计算；被亢奋归属改写的手（roundLastPlayerId 不再是无名）不触发加牌（引擎按 owner 的 canCutIn 守卫）
  canSelfFollow?: boolean;    // 出牌后立刻压自己打出的牌，可连压到放弃/压不了（修勾狂吠）——引擎在出牌后询问（selfFollow ask），角色只挂标志；留 X 禁止收尾与插队同一套过滤
  flipsOrderOnPlay?: boolean; // 每次出牌（含插队，按物理出牌者计）切换一次牌序正↔倒（海棠洄游）；每轮开始恢复正序。挂上后引擎自动：本手按切换前顺序判定（先判后切）、切换后把桌面牌型按新牌序重新解析（倒序 rank = 最高点数，保证跨序比较用同一约定）、快照携带 orderReversed
  soloJoker?: boolean;        // 王直接打出（橐驼诅咒）：该角色的王可直接作为单张/一对打出——引擎解锁单王牌型（type 'singleJoker'，rank 编码 16、label「王」）：正序/倒序都压过一切单张（含 2/3），只有炸弹能压；以及对王牌型（type 'jokerPair'，rank 编码 16、label「对王」，2026-10-03 用户确认）：压一切对子（正序含对 2、倒序含对 3），只有炸弹能压、王压不了王，正倒序一致；预览/枚举（listPlayable 第 5 参）与解析（parseCombo 第 4 参）都要传此标志
  canFlipResponse?: boolean;  // 翻面接牌（轴承端庄）：游戏提交 `{cardIds, flippedCardId}` 时走引擎 playFlipResponse——纯函数 validateFlipResponse（combos.ts，服务端判定与客户端预览共用）校验两种翻面（桌面单张翻整手接上一手 / 桌面多张翻一张按剩余接），非法剩余打后继（每张剩余牌按原牌型中所当点数 ±1：正序 +1、倒序 −1，王按所当点数、响应可用王补缺）或炸弹，后继桌面为特殊牌型 type 'gap'（label「翻面接 X」、只有炸弹能压）；翻面牌留在 tableSide 并以牌背展示（tableSideHidden）；角色只挂标志 + 客户端按标志开放交互
  exciteOnPlay?: boolean;    // 亢奋（惰戈，锁定技无需询问）：点数和 ≥20 的手牌在打出那一刻归属改写为自己——引擎在四个提交路径（commitPlay/commitFlipPlay/commitSelfFollow/commitCutIn）开头自动改写：exciteOwnerFor 判定（点数和 = 牌面点数 2 记 2/A 记 1/J=11/Q=12/K=13，王按所当点数，单王/对王视为无穷；自己淘汰或自己打出 → null）→ 若有效则不触发实际出牌者的 flipsOrderOnPlay 切换、attributeTable(effOwner) 发 table:attributed。适用于一切打出（正常出牌/插队/狂吠连压/翻面接/茄汤强制）；接牌轮转从归属者下家继续（原出牌者不跳过）、判定（巨石/地坛等）对归属者生效、轮末牌权归归属者、打完按物理出牌者获胜；插队受害者仍是归属改写前捕获的旧桌面所有者
  doubleSupply?: boolean;    // 两倍（玊，锁定技无需询问）：初始手牌、手牌上限、所有从牌堆的摸牌数量 ×2——统一在 rawDraw 内翻倍（发牌/轮末补摸/一切技能摸牌全走 rawDraw：初始手牌先手 6×2=12、其余 5×2=10）；checkHandLimit 上限同样 ×2（20×2=40，超出照常淘汰）；拿回特定牌（takeRevealed）与别人给牌（giveRevealed）不走 rawDraw、不翻倍（2026-10-04 用户确认）
  ouYa?: boolean;            // 呕哑（玊，校验层放行、无需询问）：轮到自己接牌时，可打出包含桌面那一手牌全部实际点数的任意合法牌型、无视管牌规则——playCards 校验层 ouYaLegal = ouYaCovers(combo, tableCombo)（combos.ts：按实体牌判定 table.resolved 逐张实际所当点数，答疑改点不改实体、与巨石同口径；王按所当点数；单王/对王桌面 resolved 无穷无实际点数 → 空集不可发动；起牌无桌面不可发动）；其余流程（获胜/判定/插队/留 X 禁止收尾）照常；无次数限制
  pancake?: boolean;         // 吐饼（R.F，特殊响应但**不算出牌**）：任何人每次出牌后（物理出牌者 ≠ R.F，含插队/狂吠每手/翻面接；归属改写不改物理出牌者）最先询问 R.F——先于狂吠/插队，每手限问一次、无上限；可「吃饼」：①自选一组恰好接上的牌公开亮出（留在手中，cards:revealed purpose 吐饼亮牌）→ ② rawDraw N（N=桌面张数，手牌上限淘汰照常）→ ③ 自选 N 张倒置成饼（pancake:flipped 只公开张数、永久牌背、任何人不可看不可用）；饼数 ≥ 手牌数 → 立即获胜——**2026-10-06 用户定稿：不看来因、除非有亡语**：引擎统一 checkPancakeWin 在所有结算点判定（出牌收尾 afterPlayCommitted（打断钩子含亡语已全部结算完，亡语先于获胜判定）/吃饼倒置 finishPancake/主动技 finishSkillAction/回合开始钩子 runTurnStartHooks/轮末钩子 runRoundEndHooks/过牌 pass）；**他人打完手牌的获胜判定先于吃饼询问**（afterPlayCommitted 获胜判定在前）；**出牌后已满足条件的，亡语门控同步生效**——非亡语钩子（答疑等）不再触发、直接宣判（2026-10-06 用户追加）。恰好接上 = 同型同长且 rank 恰差一级（正序 +1、倒序 −1）：A↔2 自然衔接、2 压非 A 不算；炸弹同张数差一级才算；单王/对王/首席 Q 压一切类不算；王按所当点数；顺子/连对按起点 rank 差一级。牌权不变、轮末起牌权归吃饼者（provisionalLeadId）；吃饼不消耗响应，轮到他时只能打 2（倒序 3）/炸弹、无则自动过；首席 Q 压一切特判：桌面单 Q + roundLastPlayerId 是首席 + prevTableCombo 非单 J → 不询问
  greedy?: boolean;          // 贪婪（阿摩，锁定技无需询问）：初始手牌 = 2×全场人数（含自己，先手/后手相同、不遵循先手 +1，deal 时按 activeCount ×2 发）；手牌上限 30（checkHandLimit 特判，超出照常淘汰）；每次普通主动出牌后从牌堆摸 1 张（afterPlayCommitted 内、tableOwnerId === playerId 时——归属改写后 tableOwnerId 是惰戈故不摸；再问补打走 playSideCard 不经 playCards 管线、从不触发；**打完最后一张先判获胜不摸**——获胜判定在前；插队/狂吠/翻面接等技能出牌不触发）
  yaoWu?: boolean;           // 耀武（阿摩，锁定技无需询问）：手牌含 3~A~2 全部 13 个点数（rank 3~15）→ 立即获胜（checkYaoWu 纯函数，combos.ts，王补缺——每张王补一个缺的点数、仅此判定视作任意点数）；**每次手牌变化后立即判定**：发牌（start deal 后）/摸牌（rawDraw 后）/收牌（moveRevealedToHand 后）/别人给牌（giveTo 后），均以 phase === 'playing' 守卫，满足即 finishGame（finishGame 守卫防重复计分）
  mystic?: boolean;          // 神秘（辛歼，引擎级标志）：独立牌堆 = 一整副 54 张（id 162..215、deck:3，开局构造洗好）+ 独立弃牌堆（按牌 id 归属路由——discardCards 分流，无论流转到谁手里，池子自守恒）；开局先问初始手牌数（先手 5-7/非先手 4-6，suspendEngine 挂起、超时默认 6/5）；摸牌阶段自选 1-2 张（轮末 draw 前挂起询问，超时默认 1）；摸牌（rawDraw 入口分流 privateDraw）摸空自动洗回独立弃牌堆继续用；手牌数对别人隐藏（快照 handCount 发 -1、客户端 ??）；留 2 禁止收尾豁免（单 2/对 2、倒序单 3/对 3——`liu2ExemptFor()` 引擎守卫，listPlayable 第 6 参 liu2Exempt 需传透：引擎 5 处调用点 + simulate/测试枚举都要带，否则只剩单 2 时死锁守卫误判自动过）
  zhangMu?: boolean;         // 障目（辛歼，引擎级守卫 zhangMuCheck）：其他角色的指向性技能以辛歼为目标（目标确定后、生效前）先猜手牌数（guess ask：1-20、超时算猜错）——猜错 {ok:true} 跳过效果、本回合该技能不能再对其他人发动（再对辛歼可重猜）；猜中挂起辛歼自选摸 1-3（choice ask，askPlayerId = 辛歼）后续跑；状态机 pending/passed/blocked（key = 发动者:技能，每轮 startRound 清空）；指向性 = 选玩家的技能 + 对出牌人发动的技能；锁定技不拦（角色自判：locked 且未挂 zhangMu 语义的跳过）；血压守卫（bpProtected(施放者) 不拦）。**角色插桩纪律**：调用 `ctx.game.zhangMuCheck(casterId, targetId, skillId, cont)` 前先设 `st.gate = 目标标记`，拿到返回值后：`if (st.gate && !('ask' in g)) st.gate = null` 清残留（{ok:false}/{ok:true} 无 ask 都是「没挂起」——用 `'ask' in g` 收窄，`!g.ask` 会 TS 报错），再 return g；{ok:true} 无 ask = 技能跳过、**出牌不否决**（引擎同样不否决——障目封锁只拦技能不拦触发它的出牌，2026-10-06 修复）
}
```

## 10 个钩子

| 钩子 | 时机 | 说明 |
|---|---|---|
| `onDeal(ctx)` | 发牌时 | 可 `extraDealCards`（仅此钩子可用） |
| `onTurnStart(ctx)` | 轮到出牌（含开局整备：首回合无摸牌但仍有整备阶段，先手开局即触发） | 任意 modify；可返回 ask 挂起（阿色开局抽你） |
| `beforePlay(ctx, proposed)` | **引擎基础规则校验之后** | `allowAnyway` 放行 / `ok:false` 否决（技能优先） |
| `afterPlay(ctx, played)` | 出牌后 | 任意 modify |
| `onPlayInterrupt(ctx, played)` | 出牌提交后、**获胜判定前**（驱逐类优先于获胜，如巨石；**亡语**——有人打完手牌仍可在此拦截阻止立即获胜，如楠王旺旺：判定成功给压牌者摸牌 → 手牌非空 → 获胜自然取消） | 可返回 ask 挂起 |

**亡语门控（2026-10-05 用户定稿，★ 写「打完牌后」类钩子必读）**：只有角色标注 `deathrattleHooks?: (keyof RoleHooks)[]` 的钩子可以在「有人打完最后一张牌」后触发；**未标注的钩子在打光那一刻引擎直接跳过（游戏立即结束）**——询问/改判/加牌/播报一律不触发。引擎在 runAfterPlayHooks/runInterruptHooks 对出牌者手牌为 0（未淘汰）时做此门控。**「打光」口径 = 手牌 + 扣置全空（2026-10-06 苗条修正）**：扣置牌也算手牌，实体手牌打光但扣置仍在时不算打光——不判胜、非亡语技能照常触发（引擎 `handHeldTotal()` 统一口径）。目前标注亡语的有楠王旺旺、雪灾巨石、陈正（五连鞭+压腿）（`deathrattleHooks: ['onPlayInterrupt']`）；楠王回味（afterPlay）、修勾答疑、橐驼地坛、惰戈法音、阿色再问（其钩子内部原本就有手牌守卫，与全局规则一致）、煞蔱约等（afterPlay）与直播（onPlayInterrupt）均不标注——**煞蔱打光压出最后一手直接获胜、约等不再询问（2026-10-06 用户裁定：自己打光了不用问，问了只会让自己赢不了）**。**新角色的 afterPlay/onPlayInterrupt 钩子：除非用户明确说是亡语，否则不要标注——打光即结束。** 同场多个亡语 onPlayInterrupt 按 priority 降序执行（用户定稿：旺旺 100 → 陈正 90 → 巨石 0）。**门控同样覆盖吐饼获胜（2026-10-06 用户追加）**：出牌后已满足「饼数 ≥ 手牌数」（`pancakeWinCandidate()`，无副作用判定）的，非亡语钩子同样跳过、直接宣判获胜；亡语钩子照常先结算（亡语摸牌使条件不成立则取消获胜）。

**空手判胜（2026-10-06 用户定稿，同吐饼「不看来因」口径）**：手牌 + 扣置全空（`emptyHandWinCandidate()`，无副作用全局扫描、扣置牌也算手牌）→ 立即获胜——自己打光/法音弃置/给别人牌等一切致归零的路径都触发；引擎 `checkEmptyHandWin()` 挂在与 checkPancakeWin 相同的全部结算点（出牌收尾 afterPlayCommitted/吃饼倒置 finishPancake/主动技 finishSkillAction/回合开始钩子/轮末钩子/过牌），亡语先结算（尖叫打光触发摸回在打断钩子里先执行）；亡语门控同步扩展（已有玩家空手待判胜时非亡语钩子同样跳过）。**新角色给原语（giveFrom/discardFromHand 等）不要挂获胜检查**——挂结算点即可。
| `onPass(ctx)` | 过牌 | 任意 modify |
| `onDraw(ctx, n)` | 摸牌（n=本次摸牌数） | `drawBonus` |
| `onRoundEnd(ctx, lastPlayerId)` | 一轮结束（lastPlayerId=最后出牌者，牌权所在） | 可返回 ask 挂起（黑脸/观股）；`suppressDraw` 替代摸牌 |
| `onGameEnd(ctx, winnerId)` | 终局记分 | `scoreDelta` |
| `onSkillAction(ctx, req)` | 主动技动作（game:useSkill 触发，如茄汤/骚骚） | 可返回 ask 做多阶段交互 |

## HookResult 与技能优先

```ts
type HookResult =
  | { ok: true; modify?: ActionMods; allowAnyway?: boolean; ask?: SkillAsk }
  | { ok: false; reason: string };   // 中文原因，前端直接展示
```

**技能优先原则（用户定稿）**：技能与基础规则冲突时技能生效。实现 = 每个判定点走「基础规则校验 → 角色钩子覆写」两段管线：

- `beforePlay` 在引擎规则校验**之后**运行：
  - `allowAnyway: true` → 放行基础规则禁止的出牌（如「蛋神」Q 压 K、「斜视」差 0/1 即接）
  - `ok: false` → 否决基础规则允许的出牌（如「仁德」最后一张不得为 Q）
- 多个钩子结果合并：任一 `ok:false` 否决；`modify` 叠加
- 引擎不做任何"哪个优先"的特判

## 技能询问（ask）系统

可选技能需要玩家交互（确认/选花色/选项/选牌/选目标/插队）时，钩子返回 `ask`，引擎把动作挂起（pendingAsk），服务端把完整询问发给被询问者（`game:skill-ask`），玩家用 `game:useSkill` 回答后**只重跑提问钩子**（带 `ctx.answer`）。

```ts
interface SkillAsk {
  askId?: string;             // 引擎自动生成，角色不填
  kind: 'confirm' | 'suit' | 'choice' | 'pickCards' | 'pickTarget' | 'cutIn';
  prompt: string;             // 中文提示
  options?: string[];         // suit / choice 的候选项（答案 = 所选选项文本）
  cards?: Card[];             // pickCards 的可选牌（自己/目标手牌或展示牌）
  min?: number; max?: number; // pickCards 数量限制
  targetCandidates?: string[];// pickTarget 的候选玩家
  hidden?: boolean;           // pickCards 盲抽：客户端只显示牌背（如骚骚摸对面牌），
                              // 服务端经 currentAsk 下发时自动把牌面掩码（id 保留回传），角色照常传真牌即可
  askPlayerId?: string;       // 被询问的玩家 id，缺省 = 技能所有者；「依次自选」类技能用来依次问其他人
                              //（服务端只发给被询问者；resolveAsk 校验回答者 = 被询问者，引擎零额外改动）
  timeoutMs?: number;         // 缺省 15s，超时服务端自动按弃权处理
  declineAllowed?: boolean;   // 是否允许弃权（缺省 true）。false = 必须作答：引擎把弃权/超时按默认处理
                              //（choice/suit 取第一项、pickCards 自动取最前的牌并清除 choice 防止钩子
                              //  a.choice==='decline' 提前返回），客户端隐藏「放弃」按钮。
                              // 用于「对别人产生的效果不能弃权」类询问（法音弃牌/讲题惩罚/处分等，
                              // 2026-10-06 用户确认）；技能所有者本人的确认类询问照常允许弃权
}
```

**纯度契约（★ 最重要）**：返回 `ask` 之前**不得改动任何状态**（不摸牌、不翻牌、不记 state）——回答后引擎会带着 `ctx.answer` 重跑钩子，改过状态就会重复生效。状态只写在"拿到 answer 之后"的分支里。

**多阶段询问**（骚骚 5 段 / 观股大跌 2 段 / 观股大涨依次自选 / 阿色开局抽你 2 段）：钩子按 `ctx.answer` 分派。**依次问别人**用 `askPlayerId` 定向 + 私有状态队列（观股大涨范式）：state 存 `{ pool: Card[]; boom: { ids: string[]; next: number } }`，确认后 `revealTop` 存入 pool、返回指向队列首位的 pickCards；每次回答（含弃权/超时）处理当前位 → 指向下一位重新返回 ask（此时 `askPlayerId` 指向别人，重跑时 `ctx.self` 仍是技能所有者）；队列走完 discard 余牌收尾。注意弃权路径也必须能走完队列并清空展示池（守恒断言）。

**一次性时机钩子**（只在特定时刻发动一次，如阿色开局整备）的多阶段询问：置位守卫（如 `startPhaseDone`）必须排在 `ctx.answer` 分派**之后**——首次运行置位并发问，回答重跑时先走 answer 分派，否则守卫会把重跑提前拦下、第二段询问发不出来（captain.ts onTurnStart 范式：`stage==='pick'` → `ctx.answer` → 守卫 → 首次询问）。

```ts
onSkillAction(ctx, req) {
  const a = ctx.answer;
  if (!a) return { ok: true, ask: { kind: 'confirm', prompt: '是否发动？' } };
  if (a.choice === 'decline') return;                       // 弃权 = 什么都没发生
  if (a.choice === 'yes') return { ok: true, ask: { kind: 'pickCards', cards: [...ctx.self.hand], min: 2, max: 2 } };
  if (a.cardIds) { /* 这里才执行效果 */ }
}
```

注意：多阶段中间态（如"已翻的展示牌"）存 `setup()` 私有 state，重跑时复用（见 zecheng.ts 的 `revealedIds`）。引擎保证多阶段重挂起期间牌局处于暂停状态。

## ActionMods（有界词汇表）

```ts
interface ActionMods {
  drawBonus?: number;        // 该玩家下一次摸牌额外 +N
  skipNextPlayers?: number;  // 跳过接下来 N 名玩家（回合顺序）
  forcePass?: string[];      // 指定玩家下一回合强制过
  scoreDelta?: number;       // 终局记分修正（加在输赢分上）
  extraDealCards?: number;   // 仅 onDeal：额外发牌
  suppressDraw?: boolean;    // 跳过本轮结束的自动摸牌（角色自行摸牌，如黑脸/观股）
  endTurn?: boolean;         // 技能动作结束后立即轮到下家（换牌类技能，如骚骚）
  eliminate?: string[];      // 淘汰指定玩家（手牌进弃牌堆、记 −1，仅剩一人时其直接获胜）
  seizeLead?: boolean;       // 桌面作废，由技能所有者重新起牌（如巨石驱逐成功）
}
```

## EngineFacade（只读视图 + 受控操作）

角色**永远不能**直接碰引擎结构，只能通过：

- 只读：`cfg` `players()` `handOf(id)` `deckCount()` `table()` `prevTable()`（**上一手被打掉的牌**——本手出牌前桌面上的 combo，起牌为 null）`prevTableOwnerId()`（上一手牌的归属者，起牌为 null；楠王回味压牌判定用）`turnPlayerId()` `roundLeaderId()` `phase()` `passCount()` `roundLastPlayerId()` `nextSeatOf(id, skip?)` `eliminated(id)` `activeCount()` `lastPlayWasCutIn()` `orderReversed()`（当前是否倒序）`lastPlayOrderReversed()`（**刚打出的这一手在切换前处于什么牌序**——洄游先判后切，巨石等按"打出这一手时"的牌序镜像触发用，2026-10-03）`flipCountThisRound()`（本轮内切换牌序角色的实际出牌次数，含插队；隐匿以此判断"一次也没出过"）
- 受控操作：
  - `draw(playerId, n)`（原始摸牌，不吃钩子不吃 drawBonus）
  - `giveFrom(playerId, cardIds)`（移除指定牌）+ `giveTo(playerId, cards)`（塞牌，**必须配合 giveFrom**，角色作者自己保证来源合法）
  - `announce(roleId, skillId, text)`（广播技能播报，前端 Toast「【技能名】text」）
  - **翻牌池**（判定类技能）：`revealTop(n, purpose?)`（翻牌堆顶 n 张到展示区；**每次调用都向全场广播一条 cards:revealed 事件**，purpose 供前端展示区标注，如「黑脸判定」「观股」）→ `takeRevealed(pid, ids)`（判定牌进手牌，**本回合豁免手牌上限**）/ `giveRevealed(pid, ids)`（普通拿取，计入手牌上限）/ `discardRevealed(ids?)`（弃置）。**动作结束前展示区必须清空**，否则引擎抛「翻牌池未清空」——多阶段询问中间可以暂存，最终收尾分支必须处理；挂起期间快照的 `revealed` 字段会把池中牌发给**所有玩家**（判定牌公开）
  - `revealCards(cards, purpose)`（公开亮牌，如茄汤展示手牌，广播 cards:revealed 事件）
  - `playForcedCombo(combo)`（打出特殊组合，引擎按正常出牌流程提交，如茄汤黑牌炸弹）
  - `attributeTable(ownerId)`（**桌面一手牌归属改写**，阿色再问：这手牌视作 ownerId 打出——tableOwner/轮末牌权/当前回合全部改到 ownerId，随后轮转从 ownerId 的下家继续；**先于其他角色的判定钩子执行**（角色 priority 设高，如 900），这样「视作谁打出」的判定才会落到新归属者身上；**出完即胜不受归属影响**——谁打完谁赢，引擎按物理出牌者判定（压牌者空手时角色直接不再问））
  - `retagTable(rank)`（**桌面一手牌判定点数改写**，修勾答疑：牌型不变，把判定点数改为 3~A（3-14），顺子/连对改的是起点（按当前牌序约定：正序 = 最低点、倒序 = 最高点）；`table.label` 随之按新点数重写（`relabelCombo`，对/炸/单/顺/连对全支持）主显，快照带 `tableRankNote` 供界面重建原 label 小标；实体牌不变——其他角色（巨石等）仍按实体牌判定；只影响当前桌面一手牌，被压/轮末/新轮起牌自动清除）
  - `setTableResponderRestrict(designatedId | null)`（**响应限制**，阿色抽你：当前桌面一手牌只有 designatedId 能响应——出牌/自动过候选/插队邀请/插队答案四处全部校验；被指定者淘汰/掉线时限制继续有效（无人能响应只能全过）；null 解除；桌面一手牌被压/轮末/新轮起牌自动清除，归属改写后需重新设置）
  - `playSideCard(playerId, cardId)`（**明置桌旁**，阿色再问补打：从手牌移除一张明置到桌旁，公开进快照 `tableSide`，随当前一手牌一起弃置；压牌者作答时用它，`handOf` 校验 + 自己校验合规性）
  - `discardFromHand(playerId, cardIds)`（**公开弃置手牌**（2026-10-06 用户规则），海棠隐匿重铸等：从手牌移除进**弃牌暂存区**（快照 `stagedDiscards: {playerId, cards}[]`，谁弃的、弃了什么全场可见），轮末随桌面牌一起进弃牌堆；不发事件——快照与 announce 播报覆盖 UI；角色自行保证合法）
  - `curseNextRound(playerId)`（**下回合禁出**，橐驼地坛：目标陷入红楼梦——本回合标记（快照 `cursedPlayerIds` 立即可见），**回合结束时生效**：下一整回合（轮）内不能起牌/响应/插队/狂吠/补打（轮到自动过、照常摸牌、仍可被技能询问作答），再下一回合开始时解除；若目标在本回合获得牌权（轮末最后出牌者），**由诅咒施加者取而代之**：施加者摸牌 + 起新回合，目标不摸（round:ended 事件带 `ledBy`））
  - `banPlayThisRound(playerId)` / `isBannedThisRound(id)`（**本回合罚站**，陈正见习：目标当回合不得出牌（playCards 校验拒绝）、不被任何技能选为目标——引擎在 suspend 处对所有 ask 的 `targetCandidates` 统一过滤罚站者（快照 `roundBannedIds`）；罚站者自己的技能仍可用（useSkillAction 不拦）；轮末（新回合开始）自动解除。与地坛诅咒是两条平行机制：罚站只限本回合、诅咒限下一整回合）

未来需要新的改牌能力 = 在 ActionMods / facade 加一个字段，不动引擎核心。

**倒序下的技能管牌判定**：角色钩子里做 canBeat/listPlayable 判定时一律传当前牌序 `ctx.game.orderReversed()`（flashpoint.ts 即此范式）；桌面 `table()` 的 rank 已按当前牌序解析，跨序混用约定会判错（引擎在切换者出牌后自动重解析桌面，普通出牌不重解析以免覆盖技能改写过的 combo——**带 flipsOrderOnPlay 的角色不要再用 modify 改写 combo**）。

## 模板（照抄改，以末席 肖亡为例）

```ts
// 角色：末席 肖亡 —— 技能【观股】。
import { cardColor } from '../cards';
import type { RoleDef } from './types';

interface ZechengState {
  revealedIds: number[] | null; // 大跌选牌阶段暂存（询问恢复时复用，避免重复翻牌）
}

const zecheng: RoleDef = {
  id: 'zecheng',
  name: '末席 肖亡',
  skills: [{ id: 'guan-gu', name: '观股', description: '拥有牌权时摸牌改为展示 5 张：红多大涨每人 1 张，否则大跌自己拿 2 张。' }],
  setup(): ZechengState {
    return { revealedIds: null };
  },
  hooks: {
    onRoundEnd(ctx, lastPlayerId) {
      if (lastPlayerId !== ctx.self.id) return;   // 只有自己有牌权才触发
      const st = ctx.state as ZechengState;
      const a = ctx.answer;
      if (!a) {
        return { ok: true, ask: { kind: 'confirm', prompt: '是否发动【观股】？展示 5 张：红多则大涨，否则大跌' } };
      }
      if (a.choice === 'decline') return;          // 弃权 → 正常摸牌
      // ……拿到 answer 后才翻牌/发牌/弃置，最后 suppressDraw 替代摸牌
      return { ok: true, modify: { suppressDraw: true } };
    },
  },
};

export default zecheng;
```

## 已有 22 个角色（模板）

| 文件 | 角色 | 技能 | 用到的机制 |
|---|---|---|---|
| skywalker.ts | 首席 杰杰一世 | 蛋神 + 仁德 | 双技能；beforePlay allowAnyway/veto |
| elm-yao.ts | 第二席 圣母 | 斜视 | beforePlay allowAnyway（同长度差 0/1，任意牌型） |
| unhumanity.ts | 第三席 儒艮 | 黑脸 | onRoundEnd ask + takeRevealed 判定循环 + suppressDraw |
| flashpoint.ts | 第四席 阿毛 | 茄汤 | onSkillAction + revealCards + playForcedCombo |
| yy-xue.ts | 第五席 雪灾天使 | 巨石 | onPlayInterrupt ask(花色) + eliminate/seizeLead；触发按实体牌 + `lastPlayOrderReversed()` 镜像（正序 2/对 2、倒序 3/对 3、炸弹、首席 Q、橐驼单王/对王）；判定翻到王按 `jokerSuits` 双花色 |
| cs-champion.ts | 第六席 企鹅 | 骚骚 | onSkillAction 四段 ask + giveFrom/giveTo 换牌 + endTurn |
| patrick.ts | 第七席 圣帕特里克 | 无名 | canCutIn 引擎级插队 |
| zecheng.ts | 末席 肖亡 | 观股 | onRoundEnd ask + revealTop + giveRevealed + suppressDraw |
| captain.ts | 阿色 | 抽你 + 再问 | beforePlay/afterPlay/onRoundEnd 多阶段 ask + 响应限制 + 归属改写 + 明置边牌 |
| fishy.ts | 海棠 | 洄游 + 隐匿 | flipsOrderOnPlay 引擎级牌序切换（含插队）+ onRoundEnd ask(priority 1000 先于整备类) + discardFromHand 重铸 |
| doggie.ts | 修勾 | 答疑 + 狂吠 | onPlayInterrupt ask(choice 点数，顺子/连对选项限合法起点窗口) + retagTable 改判定点（label 经 relabelCombo 重写主显；**2026-10-06 用户确认：改判后判定点数和 ≥20 → attributeTable 归属惰戈**（retaggedPointSum：对/炸 = 张数×点数、顺子/连对按改判窗口逐张求和；间隔语义——洄游等打出那一刻技能不撤销、已归属不重复改写）） + canSelfFollow 引擎级狂吠 |
| guo-tt.ts | 橐驼 | 地坛 + 诅咒 | onPlayInterrupt ask(confirm 判定，≥3 张、仅他人、每回合限一次：弃权不消耗/失败消耗) + revealTop/discardRevealed + curseNextRound 下回合禁出（轮末取而代之）+ soloJoker 引擎级单王/对王；判定中的王按颜色双花色（打出的牌里与翻出的判定牌都算，见 cards.ts `jokerSuits`） |
| king-nan.ts | 楠王 | 旺旺 + 回味 | onPlayInterrupt ask(confirm 亡语判定：翻牌非红桃 → 压牌者摸 3，打光手牌也无法获胜——打断钩子跑在获胜判定前即亡语；`prevTableOwnerId()` === 自己时触发；每回合限一次：弃权不消耗/发动即消耗；判定牌一律弃置；王按 `jokerSuits` 双花色；priority 100 先于巨石——2026-10-03 用户确认) + afterPlay 锁定回味（`prevTableOwnerId()` 被压者摸牌：点数总和差绝对值封顶 3，`pointValue` 2 记 2/A 记 1、单王/对王视为无穷）+ onRoundEnd 重置 |
| button.ts | 轴承 | 端庄 + 窃笑 | canFlipResponse 引擎级翻面接牌（validateFlipResponse 纯函数：桌面单张翻整手接上一手 / 桌面多张翻一张按剩余接，非法剩余打后继或炸弹，后继桌面 type 'gap' 只有炸弹能压；翻面牌 tableSide 牌背展示）+ onSkillAction 主动技（pickTarget ask，每轮一次弃权不消耗，经 facade `peekHand` 发私密事件 skill:peek/skill:peeked——服务端按人路由不广播）+ onRoundEnd 重置 |
| duo-ge.ts | 惰戈 | 亢奋 + 法音 | exciteOnPlay 引擎级归属改写（点数和 ≥20 打出那一刻视作惰戈打出：不触发实际出牌者技能含洄游、判定对惰戈生效、轮转从惰戈下家——详见 types.ts 字段注释）+ afterPlay ask(confirm 法音：打出牌 ≥2 花色（王按 jokerSuits 双计）→ pickTarget 选目标（含自己，自己手牌 ≤3 时不含）→ pickCards 被弃者自选弃一张进弃牌暂存区（公开可见，轮末进弃牌堆；`declineAllowed:false`：弃权/超时自动弃第一张——2026-10-06 用户确认，对别人产生的效果不能弃权）；无次数限制，confirm 阶段 decline 时重置阶段二残留；priority 950 先于阿色再问 900) |
| su.ts | 玊 | 两倍 + 呕哑 | 纯标志角色（无钩子、无 setup）：doubleSupply 引擎级发牌/摸牌/上限 ×2（rawDraw 内统一翻倍，拿回/别人给牌不翻倍）+ ouYa 引擎级校验放行（ouYaCovers 按实体点数判定，无视管牌规则；客户端预览同函数复用显金色提示） |
| rf.ts | R.F | 吐饼 | pancake 引擎级吃饼询问（PendingAsk kind 'pancake'，resolvePancake 两阶段 pickCards：亮牌 → 倒饼，decline/超时干净作废、倒置阶段自动倒前 N 张）：每次出牌后最先询问（先于狂吠/插队）、特殊响应不算出牌（不触发洄游/归属改写）、恰好接上（同型同长 rank ±1、倒序 −1）判定走引擎 canExactFollow；吃饼后限制（无牌权时只能打 2/倒序 3 或炸弹、无则自动过）、轮末起牌权走 provisionalLeadId；饼数 ≥ 手牌数立即获胜（2026-10-06 用户定稿：不看来因、除非有亡语——引擎统一 checkPancakeWin 在所有结算点判定：出牌收尾 afterPlayCommitted（亡语已结算完）/吃饼倒置/主动技/回合开始钩子/轮末钩子/过牌）；首席 Q 特判排除 |
| amo.ts | 阿摩 | 贪婪 + 耀武 | 纯标志角色（无钩子、无 setup）：greedy 引擎级发牌 ×2/上限 30/出牌后摸 1（afterPlayCommitted、归属改写与再问补打不算、打完先判获胜）+ yaoWu 引擎级耀武判定（checkYaoWu 纯函数王补缺，发牌/摸牌/收牌/别人给牌四个检查点立即获胜）；牌堆耗尽洗回弃牌堆（recycleDiscard）为全局规则、所有摸牌生效 |
| bao-guo.ts | 陈正 | 见习 + 反力矩 + 五连鞭 + 压腿（四技能） | onSkillAction 主动技见习（onlyWhenLeader；pickTarget→私摸 2 张暗交 1，每局限 X+2 次弃权不消耗、不能连续两回合同一人）+ banPlayThisRound 罚站（目标不得出牌、不被技能选为目标、自己的技能照常可用，轮末解除）+ onTurnStart 被动反力矩（牌权被抢 confirm→pickTarget→双方暗选各 1 张 revealTop 公开拼点：陈正 +2、平局算输，赢则两张拼点牌都归对方+自弃 1 张、输则全得，手牌 ≥3 才能发动）+ onPlayInterrupt 亡语五连鞭（打出一手 ≥5 张含自己/插队/狂吠每一手/翻面接/茄汤强制、吃饼不算：出牌者摸 1）+ onPlayInterrupt 亡语压腿（仅他人炸弹：双方各 revealTop 1 公开拼点，败方摸 |点差|、两张拼点牌一律弃置、牌堆+弃牌堆都空不询问；拼点通用 contestPoint 王=14/A=1/2=2/其余牌面，priority 90：旺旺 100 → 五连鞭 → 压腿 → 巨石 0） |
| zu-zhang.ts | 组长 | 处分 + 温柔 | onPlayInterrupt ask(choice 处分：被压时（`prevTableOwnerId()` 自己、含插队/归属改写）三选一——检讨摸 2 不限次 / 休学 curseNextRound 每局 X 次 / 放弃不消耗（`declineAllowed:false`：放弃已是显式选项，不再提供额外弃权按钮，超时自动取第一项检讨——2026-10-06 用户确认）；非亡语，压牌者打光手牌不触发（亡语门控自动处理）) + onTurnStart ask(温柔：每局 X 次、无论谁起牌；choice 选 Y → 摸 Y → 依次 pickTarget 标宝贝可提前停；Y 上限 = min(20−手牌, 其他成员数)) + babyIds 引擎级守卫（宝贝本回合不得响应组长的出牌：压牌/插队/吃饼/狂吠/翻面/茄汤成炸/讲题代打全禁，改判/判定/增益类不受影响，轮末自动解除；守卫走引擎统一出牌门控 playGateBlocked，讲题代打按归属者（组长/硝烟）门控） |
| xiao-yan.ts | 硝烟 | 讲题 + 血压 | bloodPressure 引擎级锁定守卫（手牌 ≥8 → 其余人技能一律不能对其生效含增益——suspend targetCandidates/各技能 bpProtected 守卫；playBanned 禁打豁免；动态生效）+ onTurnStart ask(讲题：轮到硝烟接牌（桌面非空门控——只在接牌时发动，起牌/领出不发动，2026-10-06 用户确认）时经引擎统一出牌门控 `playGateBlocked` 自查（禁打/抽你响应限制/温柔宝贝）——**讲题本质是硝烟出牌（2026-10-06 用户确认）**，硝烟本人被技能影响不允许出牌则不能发动；draw 1 → pickTarget 指定代打者 → proxyPlay 引擎级代打询问（kind 'proxyPlay'，代打者按正常管牌规则压桌面牌，打出则 attributeTable 归属硝烟：轮转从硝烟下家继续、判定对硝烟生效；失败 → 代打者 choice 惩罚（`declineAllowed:false`）：硝烟自选弃 1（pickCards `declineAllowed:false`、超时自动弃第一张）或代打者摸 1（超时自动取第一项）；结算后硝烟仍可出牌——讲题不算出牌动作)；proxyPlay 守卫：被诅咒/罚站者仍可代打（强制代打优先于禁打）、温柔宝贝不得代打组长的牌、硝烟本人在代打阶段被禁打/限制则代打一并禁止（resolveProxyPlay 按归属者门控） |
| miao-tiao.ts | 苗条 | 苗条 + 尖叫 | afterPlay 锁定苗条技（roundLastPlayerId 自己且未淘汰：打出 n 种花色摸 n，王按 jokerSuits 双计）+ onTurnStart ask(尖叫：每局 X+2 次扣置——choice 范文 ≤4 异花色 / 尖叫鸡 ≤3 同花色 → pickCards；扣置后手牌 ≥1；**成功扣置才消耗次数**——弃权/非法提交不消耗、非法提交提示重发 pickCards 询问；**已有扣置牌（heldGroups 非空）不再询问**，扣置牌跨回合保留；**选牌阶段放弃 → 重发 choice 类型选择**（可改选另一种），类型选择「放弃」才结束) + heldGroups 引擎级扣置区（takeHeldBack 收回/putHeld 扣置/checkHeldCards 触发匹配；扣置牌也算手牌——checkHandLimit 与空手判胜同口径手牌+扣置；**快照 heldGroups 公开类型+张数（所有人可见）、held 牌面只对本人可见**）+ onPlayInterrupt 亡语尖叫（物理出牌者 lastPlayPhysicalId 打出被扣花色（范文，一次几种摸几张）或点数（尖叫鸡，一次发完）→ 摸回对应扣置牌发给实际打出者；苗条打光实体手牌不算打光——扣置仍在则不判胜、苗条技照常摸牌，2026-10-06 用户修正：旧「自动收回全部扣置」方案作废）+ skillActions anyTime 收回扣置牌（**hidden：按钮行不渲染**，客户端查看弹窗的收回按钮走它） |
| sha-sha.ts | 煞蔱 | 约等 + 直播 | afterPlay 约等（每回合限一次 yueDengUsed、弃权不消耗——触发 A：roundLastPlayerId 自己且 prevTableOwnerId 非自己非空（归属改写后不触发）→ confirm 询问；触发 B：onRoundEnd 拥有牌权（lastId 自己，摸牌前结算 = 出了 0 张牌不用摸牌，2026-10-06 用户确认）→ confirm 询问；yes → 障目门控 → `modify.yueDeng {targetId}` 引擎 afterPlayCommitted（获胜判定前）消费 yueDengRevert：收回刚打一手 + 桌面回退上一手（**被压那手从弃牌堆移回桌面**——commitPlay 已弃置，不移回双重计数破坏守恒，2026-10-06 修复）+ 桌旁随弃 + 与随机角色均分（她 ⌊X/2⌋）+ 从下家继续接牌/桌面空重新起牌（**牌权仍归煞蔱**——roundLastPlayerId = ownerId，全过 → 煞蔱起牌，2026-10-07 用户反馈：旧实现归回退手主人 = 对面牌权 bug））+ onPlayInterrupt 直播（prevTableOwnerId 自己且那手 ≥2 张且有人压（roundLastPlayerId 非自己）→ 障目门控 → choice 给一张牌（手牌 ≥2 才有）/令对方摸 2 张，可放弃不限次；血压全挡；**约等/直播均非亡语——打光压出最后一手直接获胜、不再询问（2026-10-06 用户裁定）**) |
| xin-jian.ts | 辛歼 | 神秘 + 障目 | **纯标志角色**：mystic（引擎级：独立 54 张牌堆摸空洗回、独立弃牌堆按 id 路由、初始手牌自选 5-7/4-6、摸牌 1-2、手牌数隐藏 -1、留 2 豁免）+ zhangMu（引擎级 zhangMuCheck 障目门控：指向性技能目标为辛歼先猜手牌数——猜错失效不扣次数且本回合不能再对他人发动（对辛歼重试可再猜）、猜中照常 + 辛歼摸 1-3（**技能先生效、再摸 1-3**：摸牌挂账 zhangMuDrawQueue、动作收尾 ok() 统一兑现——窃笑偷看须看到旧手牌、约等均分不含新摸的牌，2026-10-07 用户反馈）；pending/passed/blocked 每轮清空、血压守卫）。其他角色按插桩纪律接入（st.gate 标记 + `'ask' in g` 清残留；封锁返回 {ok:true} 静默跳过、不出牌否决） |

## 新增角色的流程（每个角色照此执行）

1. 用户给出角色名 + 技能描述（中文，可能与基础规则冲突）；**实现前先与用户确认技能细节**
2. **先想清楚映射**：技能对应哪个钩子 + 哪个 ActionMods / facade 操作；现有词汇表不够 → 和用户确认后扩展（引擎核心不动）
3. 在 `shared/src/roles/` 新建 `pinyin-name.ts`，写 RoleDef（前 8 席之后的角色：名字不带「第 X 席」、不填 seatOrder）
4. 新建 `shared/src/roles/pinyin-name.test.ts`：精确效果断言（含 setup 状态变化、ask 多阶段、announce 文案、与基础规则冲突时的技能优先行为）；loader 测试期望列表同步更新
5. 验证：`npm test` 全绿 → 三包 tsc → `npm run build -w client` → `npm run smoke` → 服务器套件 15× 防抖
6. 前端角色卡片（RoleCard）自动展示 skills，无需改 UI；技能播报经 `announce` 自动进 Toast；技能按钮由 `skillActions` 通用渲染；询问弹窗由 ask 类型通用渲染
7. 更新 `docs/01-requirements.md` 的角色表 + 当天 dev-log

## 红线

- ❌ 不改引擎核心（engine.ts 只允许动 ActionMods/钩子分发的 bug 修复）
- ❌ 不绕过 EngineFacade（直接 import 引擎内部函数、篡改手牌数组）
- ❌ 返回 ask 之前改状态（纯度契约：重跑钩子会重复生效）
- ❌ 钩子内做非确定性操作（Math.random、Date.now）——一切随机走 `ctx.rng`
- ❌ 异步钩子、抛异常（异常会终止牌局；防御性写代码）
- ❌ 状态放模块级变量（会跨房间串）——私有状态一律 `setup()` 返回
- ❌ 翻牌后不清空展示池（引擎守恒断言直接报错）
- ✅ 不确定规则 → 先问用户，不自己拍板
