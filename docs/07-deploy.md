# 部署与运行

## 环境要求

Node v24+（本机 v24.18.0）、npm 11+。Windows / macOS / Linux 均可。

## 安装与常用命令

```bash
npm install      # 首次：安装三个 workspace 依赖
npm test         # 全部测试
npm run dev      # 开发：server:3000（Socket.IO）+ client:5173（Vite，代理 /socket.io→3000）
npm run build    # 构建 client → client/dist
npm start        # 生产：server 在 3000 托管 client/dist（SPA 回退 + MIME 映射）
npm run smoke    # 双客户端端到端烟测
```

## 本地局域网对战（手机 + 电脑）

1. 电脑 `npm run dev`（Vite 已配 `host: true` 监听所有网卡）
2. 手机连**同一 WiFi**，浏览器访问 `http://电脑局域网IP:5173`（本机 IP 为 **192.168.71.71**；`192.168.199.1` / `192.168.152.1` 是虚拟网卡不可用）
3. 电脑一方也建议用同一地址访问（而非 localhost），便于与手机在同一视角验证

> **Windows 防火墙**：首次被手机访问不通时，控制面板 → Windows Defender 防火墙 → 允许应用通过防火墙 → 勾选 Node.js（专用网络）。README 中已注明此提示。

## 生产模式（单端口 3000）

```bash
npm run build
npm start
```

所有人（含手机）访问 `http://电脑IP:3000`，无需开 5173。

## 免费云部署（Render，2026-10-01 完成）

结构已预留：端口读 `process.env.PORT`（默认 3000，[server/src/index.ts:13](../server/src/index.ts#L13)）；战绩存储接口已抽象（ScoreStore），云端可换 Postgres，本地保持 JsonFile（`server/data/scores.json`）。

### 步骤

1. **代码推到 GitHub 仓库**（公开或私有均可；仓库根目录已含 `render.yaml` 蓝图）
2. 注册 [render.com](https://render.com)（用 GitHub 账号一键登录，**免费档无需信用卡**）→ Dashboard → **New → Blueprint** → 选刚才的仓库 → 自动读取 `render.yaml`（区域选 **Singapore**，离国内近）→ Apply
3. 部署完成得到固定网址 `https://gdys.onrender.com`，发给朋友即可开玩

### 配置说明（手动创建 Web Service 时照填）

| 项 | 值 |
|---|---|
| Runtime | Node，版本 `NODE_VERSION=24`（`package.json` 已声明 `engines`，`render.yaml` 已带环境变量） |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/`（SPA 回退返回 200） |
| 端口 | 不用填——Render 注入 `PORT` 环境变量，服务端自动读取 |
| 区域 | Singapore（国内访问较优） |

### 注意事项

- **免费档休眠**：15 分钟无连接后服务休眠，之后首次打开约等 1 分钟唤醒（朋友刚进会看到转圈，属正常）
- **战绩不持久**：免费档磁盘是临时的，服务重启后云端战绩清零（本机 `server/data/scores.json` 不受影响）；要持久战绩需换 Postgres（ScoreStore 接口已抽象，后续可做）
- **国内访问速度**：onrender.com 国内访问看运气，可能偏慢；若朋友普遍打不开，改用内网穿透（cpolar）方案：代码仍存 GitHub，本机 `npm run build && npm start` + cpolar 隧道暴露 3000 端口
