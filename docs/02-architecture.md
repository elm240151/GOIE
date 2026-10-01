# 技术架构

## 总体结构

npm workspaces monorepo，全 TypeScript（strict、ES2022、不用 enum）：

```
s4/
├─ shared/            # @gdys/shared：纯 TS 游戏引擎（DOM 无关，前后端共用）
│  └─ src/
│     ├─ cards.ts         # Card/Rank（15=2, 16=小王, 17=大王）、中文牌面
│     ├─ config.ts        # RuleConfig + defaultRules（引擎所有判定读配置，无硬编码）
│     ├─ engine/          # rng(种子随机) deck(162张) combos(牌型纯函数) engine(状态机) events snapshot
│     ├─ roles/           # ★ 角色框架：types registry 双 loader + 每角色一个文件
│     └─ protocol/        # Socket.IO 事件名 + payload 类型
├─ server/            # Node + Socket.IO + tsx（服务端全权）
│  └─ src/            # index roomManager room socketHandlers reconnect scoreStore
├─ client/            # Vite 5 + React 18 + Zustand
│  └─ src/            # socket store strings screens/ components/
├─ docs/              # 本目录：需求/架构/协议/角色规范/测试/UI/部署
├─ dev-log/           # 每日开发日志 + 待办清单
└─ scripts/smoke.ts   # 双客户端端到端烟测
```

## 核心设计

### 服务端全权（server-authoritative）
- 客户端只发送意图（出哪些牌/过/选角色），**所有规则判定都在服务端引擎**执行
- 每次动作后服务端广播 `game:snapshot`：**按查看者过滤手牌**（只发自己的牌，其他人只有手牌数）
- 客户端用同一套 shared 的 `parseCombo/canBeat/listPlayable` 做即时预览（零漂移），但判定永远以服务端回执为准

### 引擎不变量（任何改动不得破坏）
- **牌守恒**：手牌 + 桌面 + 展示池 + 牌堆 + 弃牌堆 ≡ 162（三副）或 54（测试小局）
- 零和记分：Σ 本局分 = 0（淘汰者 −1、赢家 +(开局人数−1)，跨局累计）
- 种子 RNG（mulberry32）：发牌/随机可复现（测试用）
- 钩子同步执行、按 priority 降序再按座位序——**确定性**
- 角色只能通过 EngineFacade + ActionMods 的受控词汇表改牌（见 docs/04），引擎结构永不被破坏
- **翻牌池必须清空**：动作结束时展示区还有牌且无询问挂起 → 抛「翻牌池未清空（角色技能泄漏）」
- 淘汰玩家被 nextSeat/advanceTurn/startRound 统一跳过；passCount 阈值按存活人数算
- 手牌上限 20：每次手牌变化后检查，超过 → 立即淘汰（发牌阶段与判定牌豁免除外）

### 回合循环（engine.ts）
`startRound(leader)` → 轮流 playCards/pass → passCount == 存活人数−1 → endRound（最后出牌者摸 1 张、重新起牌）→ 有人出完手牌 → finishGame（立即获胜、记分）→ 再来一局开新引擎实例。

**死锁守卫**：起牌者无任何可出牌型（含被技能否决，如仁德的"最后一张 Q"）→ 自动过给下家；转满一圈无人能起牌 → `finishDraw()` 流局（无赢家、0 分、game:ended 带 winnerId=null）。干跑 beforePlay 时 announce 不发声、modify 不生效、ask 不挂起，但**否决生效**；`turnPlayerId` 在守卫前设置，钩子能看到"自己在起牌"。

### 技能询问（ask）挂起模型
钩子返回 ask → 引擎挂起（pendingAsk + 恢复闭包）→ 服务端 `game:skill-ask` 定向发给被询问者并启动超时（15s 自动弃权）→ `resolveAsk` **只重跑提问钩子**（ctx.answer）。多阶段询问在恢复闭包中重挂起（onSkillAction / onRoundEnd 均已支持）。嵌套管线（恢复/插队/playForcedCombo）产生的重排事件由 requeue 保证按序广播。

### 插队（无名，引擎级）
`canCutIn` 角色在非插队出牌后收到 ask（kind:'cutIn'）→ 接受则验证（合法牌型、压得过、响应牌中有与被压牌同花色的真牌，单张也可）→ 提交：桌面原牌进弃牌堆，被响应者摸 X 张（X = 响应牌中同花色真牌点数总和），turn = **无名的下家**（插队跳过了被响应者与无名之间的玩家）；拒绝 → 正常回合继续。普通响应（非插队）同样触发（`prevTableOwnerId` 记录被压者、`prevTableSuits` 记录被压牌花色），轮转照常。

### 房间与重连（server）
- Room：座位/角色选择（同角色一房限一个）/准备/开局/rematch 投票/掉线标记
- playerSecret（randomUUID）：创建/加入时下发，客户端存 localStorage；重连 `room:rejoin` 校验 secret 后恢复座位、立即下发快照并**重发未决技能询问**
- 掉线超时（30s）自动过；起牌者掉线且必须出牌时自动出最小组合（autoPlayFallback）；技能询问挂起时自动过定时器顺延
- 询问超时（15s）自动按弃权了结；测试可注入 `engineFactory`（固定手牌/先手）做确定性房间测试
- 战绩落盘 `server/data/scores.json`（ScoreStore 接口，云端可换 Postgres）

### 前端（client）
- zustand 单 store（store.ts）：屏幕路由 + 房间状态 + 快照 + 选牌 + Toast + 技能询问，全部由服务端广播驱动
- screens：Lobby / Room / GameTable / Scoreboard；components：Card Hand ComboBadge PlayerSeat RoleCard SkillAskModal Toast
- 文案集中在 strings.ts；样式单文件 styles.css（mobile-first，CSS 变量）

## 端口与构建

- 开发：server 3000（Socket.IO），client 5173（Vite 代理 /socket.io → 3000，`host: true` 供局域网）
- 生产：`npm run build` 后 `npm start`——server 在 3000 托管 client/dist（SPA 回退 + MIME 映射）
