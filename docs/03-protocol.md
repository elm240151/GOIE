# Socket.IO 协议规范

定义在 `shared/src/protocol/messages.ts`（`CLIENT_EVENTS` / `SERVER_EVENTS` / 类型），两端共用避免字符串漂移。

## 客户端事件（client → server）

| 事件 | payload | ack |
|---|---|---|
| `room:create` | `{name}` | `{ok:true, code, playerId, secret}`（6 位数字房号） |
| `room:join` | `{code, name}` | 同上 |
| `room:rejoin` | `{code, playerId, secret}` | `{ok:true}` 或 `{ok:false, error:'身份校验失败'}` |
| `role:select` | `{roleId}` | ok / 错误（'角色不存在'、'已被别人选择'） |
| `room:ready` | `{ready: boolean}` | ok / 错误 |
| `room:start` | — | ok / 错误（'只有房主可以开始游戏'、'至少需要 2 人'…） |
| `room:rematch` | — | ok（全员投票通过后回到房间重选角色/重新准备，房主开局，先手给上局赢家） |
| `room:addBot` / `room:removeBot` | removeBot 带 `{playerId}` | ok / 错误（'只有房主可以…'等；仅大厅可用，人机无 socket 由 Room 定时器驱动） |
| `room:setDevDraw` | `{enabled: boolean}` | ok / 错误（'仅开发者账号（Elm）可用'——玩家名恰为「Elm」才可开启自定义摸牌） |
| `room:leave` | — | 无 ack（空房间销毁） |
| `game:play` | `{cardIds: number[], flippedCardId?: number}`（带 `flippedCardId` = 端庄（轴承）翻面接牌：翻面桌面一张牌并接牌，一次动作） | ok / `{ok:false, error: 中文原因}` |
| `game:pass` | — | 同上 |
| `game:useSkill` | `SkillUsePayload`（见下） | 同上 |

`SkillUsePayload`：有 `askId` = **回答技能询问**（`{askId, choice?, cardIds?, targetPlayerId?, guess?, swapSpec?}`——`guess` 障目猜手牌数、`swapSpec` Elm 自定义摸牌 devSwap 换牌 `{suit, rank} | {joker}`）；无 `askId` = **发动主动技**（`{skillId}` → onSkillAction）。

## 服务端事件（server → client）

| 事件 | payload |
|---|---|
| `room:updated` | `RoomState {code, phase:'lobby'|'playing'|'finished', hostId, players[], winnerId, scoreDeltas, totals, rematchVotes}`（玩家含 `isDev/devDraw`——Elm 开发者账号标记与自定义摸牌开关，服务端权威判定） |
| `game:snapshot` | `GameSnapshot`（按接收者过滤：只有自己的 `hand` 非 null；**神秘（辛歼）手牌数对别人发 -1（客户端显示 ??）、牌面永不可见**，`privateDeckCount/privateDiscardCount` 只有辛歼自己非 null——独立牌堆/弃牌张数；含 `pendingAsk: {askId, playerId, kind, prompt, timeoutMs} \| null`；`revealed` 翻牌展示区**所有人可见**——判定牌公开，动作内须清空；`orderReversed` 当前牌序是否倒序（海棠洄游），`table` 牌型的 rank 已按当前牌序约定解析——倒序时 rank = 最高点数；`tableRankNote: {rank} \| null` 桌面一手牌被答疑改点后的新判定点数（修勾，牌面实体不变；**`table.label` 已按新点数重写**（主显金色），界面据 note 用实体牌重建原 label 小标「改判：原X」）；`cursedPlayerIds` 陷入红楼梦的玩家（橐驼地坛，含本回合 pending 诅咒——判定成功即广播，下回合生效）；桌面可为单王牌型 `type: 'singleJoker'`（橐驼诅咒：label「王」，压一切单张、只有炸弹能压）或对王牌型 `type: 'jokerPair'`（label「对王」，压一切对子、只有炸弹能压）；`prevTable: Combo \| null` 上一手桌面牌型（轴承端庄情况一接的是它）；`tableSide: Card[]` 明置桌旁的边牌，`tableSideHidden: number[]` 其中以牌背展示的牌 id（端庄翻面牌**可见但背面**）——随当前一手牌一起弃置；`stagedDiscards: {playerId, cards}[]` 弃牌暂存区——本回合公开弃置的牌（谁弃的、弃了什么全场可见；轮末进弃牌堆，客户端据此渲染「弃牌」区）；`tableOwnerId: string \| null` 当前桌面一手牌的实际打出者（归属改写前——温柔宝贝守卫基准）；`babyIds: string[]` 温柔（组长）标定的宝贝；`babyOwnerId: string \| null` 标定者（组长）id；`heldCount/held/heldGroups` 尖叫（苗条）扣置牌——张数公开、`held` 牌面只对苗条自己可见、`heldGroups: {kind, count}[]` 类型 + 张数所有人可见（别人点扣置徽章看是范文还是尖叫鸡）） |
| `game:event` | `GameEvent`（判别联合 + 自增 seq，见下） |
| `game:error` | 中文原因字符串 |
| `game:skill-ask` | 完整 `SkillAsk`（**只发给被询问者**——被询问者可由 `askPlayerId` 指定，缺省 = 技能所有者；重连时重发未决询问；`hidden: true` 的 pickCards 为盲抽，经 currentAsk 下发时牌面已掩码只留 id；`declineAllowed: false` = 不可弃权——客户端隐藏「放弃」按钮，弃权/超时由引擎按默认处理：choice/suit 取第一项、pickCards 自动取最前牌） |
| `score:list` | `{records}`（应答 score:list 请求） |

## GameEvent（shared/src/engine/events.ts）

`game:started {leaderId}` · `deal:done` · `turn:started {playerId}` · `cards:played {playerId, combo}` · `passed {playerId}` · `round:ended {lastPlayerId, drew, ledBy?}`（`ledBy` 仅橐驼地坛取而代之：lastPlayerId 陷入红楼梦 → 橐驼摸 drew 张并起新回合，lastPlayerId 不摸） · `cards:drawn {playerId, count}` · `cards:revealed {playerId, cards, purpose}`（**判定牌公开**：`revealTop` 每翻一次发一条，逐张可见；`revealCards` 整批亮牌） · `table:attributed {playerId, fromPlayerId, combo}`（**桌面一手牌归属改写**：这手牌视作 playerId 打出，轮转从其下家继续、判定对其生效） · `table:side {playerId, card}`（明置一张牌到桌旁，随当前一手牌一起弃置，公开） · `skill:peek {viewerId, targetId, cards}`（**私密事件**：窃笑——服务端只发给查看者，携带被查看者完整手牌，不广播） · `skill:peeked {viewerId, targetId}`（**私密事件**：服务端只发给被查看者，「X 查看了你的手牌」，不广播） · `player:eliminated {playerId, reason}` · `skill:triggered {playerId, roleId, skillId, text}` · `game:ended {winnerId(null=流局), scoreDeltas, totals}`

## 技能询问时序

```
动作（play/pass/useSkill）→ 钩子返回 ask → 引擎挂起
→ 广播 game:snapshot（pendingAsk 非空）→ 定向 game:skill-ask（完整载荷）→ 启动 15s 超时
→ 被询问者 game:useSkill {askId, ...} → 引擎重跑提问钩子 → 广播新快照（pendingAsk 清空或多阶段重挂起）
→ 超时/掉线 → 服务端自动 {askId, choice:'decline'} 了结
```

客户端弹窗按 `kind` 渲染：confirm（是/否）、suit/choice（选项按钮，答案 = 所选选项文本）、pickCards（选牌 + 数量校验；`hidden` 时显示牌背盲抽）、pickTarget（目标按钮）、cutIn（自己的手牌选接牌组合）、selfFollow（修勾狂吠：自己的手牌选牌压自己打出的牌，提交 = `choice:'yes'`+cardIds，放弃 = decline）、guess（障目：猜辛歼手牌数——数字键盘 1-20（`min`/`max` 给范围），提交 = `guess: number`、超时算猜错）、proxyPlay（讲题代打：pickTarget + 代打者选牌界面）、devSwap（Elm 自定义摸牌：当前实际摸到的牌 + 54 格选牌网格 + 第 `swapIndex`/`swapTotal` 张进度，提交 = `swapSpec` 换这张或 `choice:'keep'/'restKeep'` 保持；询问在 dealing 期以 internalKind 'engine' 挂起——引擎真实 phase 未到 playing，房间判终局须用 `engine.isFinished` 而非快照 phase）。

## 约定

- ack 统一 `{ok:true, ...数据} | {ok:false, error}`（`AckResult<T>`），错误文案中文、直接可展示
- 每次动作后服务端：`game:event` 广播 → `game:snapshot` 广播 → `room:updated` 广播（顺序固定）
- 客户端状态一律由广播驱动；ack 仅用于即时反馈（出错 Toast）
- 重连：socket connect 后若本地有 `{roomId, playerId, secret}`（localStorage `gdys-identity`）自动发 `room:rejoin`；失败清除身份回大厅
- 客户端选牌预览用 shared 的 `parseCombo/canBeat`，**"压不过"只提示不阻断**（技能可能豁免基础规则），最终以服务端 `game:error` 为准
