# 鲸鱼娘陪玩 · dsh-whale-companion

> 一个住在你屏幕边上的桌面女友：**悬浮球 + 漫画气泡 + 会看你打游戏**。
> 它不是助手，是陪玩——看到精彩操作会夸一句，看到你翻车会笑一下。

DSH（DeepSeek Harness）插件形态：**装一次，在设置里开关**，不用记脚本、不用开终端。

```
┌──────────── 你的屏幕 ────────────┐
│                                  │
│   游戏 / 任何窗口                 │
│                                  │
│                        ╭───────╮ │
│        ╭───────────╮   │ 气泡   │ │
│        │  “翻车了”  │◄──┤ ●球   │ │
│        ╰───────────╯   ╰───────╯ │
└──────────────────────────────────┘
        ▲ 打字机式逐字出现，气泡随文字长
        │
   Electron 透明浮层（鼠标穿透，只有球可点）
        ▲ HTTP 127.0.0.1
        │
   bridge.mjs ──stdio JSON-RPC──► dsh --profile sdk ──► 模型
        │                              ▲
        └── capture.py / watcher.py ───┘  看屏幕、判断画面变化
```

## 特性

- **漫画气泡**：独立圆角框（无小尾巴），随文字**逐字生长**——文字打到哪，框长到哪
- **贴边翻转**：球在屏幕左半边就朝右冒，在右半边就朝左冒
- **跟手拖动**：主进程读光标位置驱动，不抖、不丢事件、位置记忆
- **单击聊天 / 双击设置**：输入条直接跟她聊，回复走气泡
- **自动陪看**：常驻低分辨率监视器，画面剧变（死亡、过场、爆点）才看她一眼；也可调成定时
- **认得游戏**：截图裁到前台窗口 + 带上窗口标题，热门游戏基本叫得出名字；不认得就只说看到的，不硬编
- **角色卡**：设置里直接改人设提示词，保存后自动重开会话生效
- **自定义头像**：内置两张，也可以上传自己的 GIF/PNG
- **可调透明度 / 反应速度**：安静 ↔ 灵敏三档，面板上直接看"近 1 小时看了几次"

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | **Windows 10/11**（抓屏走 GDI，暂不支持 macOS/Linux） |
| DSH | ≥ 0.2（需要 `dsh --profile sdk` 这个 stdio JSON-RPC profile） |
| Node.js | ≥ 22 |
| Python | ≥ 3.10（只用来抓屏，依赖 Pillow） |
| Electron | 44.x（安装脚本会装） |

## 安装

> 适用 **DSH Web**（`dsh web`）与 **DSH 桌面版**——两者渲染的是同一套 Web 客户端，插件装进对应 profile 即可。

### 方式 A：从 GitHub 装（推荐给朋友）

```bash
# Web
dsh plugin --profile web add github:<你的用户名>/dsh-whale-companion

# 桌面版
dsh plugin --profile desktop add github:<你的用户名>/dsh-whale-companion
```

装完还要补两个运行时依赖（Electron + Pillow），执行包里自带的安装脚本：

```bash
cd "$(dsh plugin --profile web root 2>/dev/null || echo .)"   # 找不到就手动进 profile 的 node_modules/dsh-whale-companion
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

> 不知道装到哪去了？在 **设置 → 鲸鱼娘** 里，如果提示"还没装依赖"，那一行会直接给出**本机真实路径**，复制执行即可。

### 方式 B：本地 clone（开发用）

```bash
git clone https://github.com/<你的用户名>/dsh-whale-companion
cd dsh-whale-companion
powershell -ExecutionPolicy Bypass -File scripts/install.ps1

dsh plugin --profile web     add link:<本目录绝对路径>
dsh plugin --profile desktop add link:<本目录绝对路径>
```

### 方式 C：下载 zip（朋友没有 git 时）

下载仓库 zip → 解压 → 执行 `scripts/install.ps1` → 用 `dsh plugin add link:<解压目录>`。

装完**重启 DSH**，进 **设置 → 鲸鱼娘**，点「启动」。

## 用法

| 操作 | 结果 |
|---|---|
| 单击球 | 聊天输入条（回车发送，Esc 取消） |
| **双击球** | 设置面板（陪看开关 / 反应速度 / 透明度 / 头像 / 角色卡） |
| 拖动球 | 移动位置，跨屏幕中线后气泡自动换边 |
| 设置开着时点空白 / 点游戏 | 收起 |

聊天走独立 agent（`dsh --profile sdk`，工作目录 `bridge/`），**不影响你正在用的 DSH 会话**；人设由 `bridge/AGENTS.md` 决定。

## 配置

`~/.dsh/whale-companion/config.json`（插件写；也有环境变量式覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | false | 是否在 DSH 启动时自动拉起 |
| `overlayDir` / `companionDir` | 包内 `overlay/` `bridge/` | 想放别处就改这里 |
| `pythonPath` | 空 | 留空则用 `bridge/.venv` 或 PATH 里的 python |

浮层自己的 `overlay/config.json`（首次启动自动生成）：

| 键 | 默认 | 说明 |
|---|---|---|
| `bubbleOpacity` | 0.94 | 气泡透明度，只影响气泡 |
| `watchSpeed` | `normal` | `quiet` / `normal` / `fast` |
| `watchChangeThreshold` | 0.12 | 画面变化像素占比阈值，越低越敏感 |
| `minObserveGapMs` | 5000 | 两次反应最小间隔 |
| `watchIntervalMs` | 120000 | 没变化时的兜底间隔 |
| `typeSpeedMs` | 34 | 打字速度（毫秒/字） |

## 关于开销（重要）

- 监视器**不花 token**：它只在本地比对 64×36 灰度图。
- 每"看一眼"才是一次模型调用：一张图 ≈ 1k input token。
- 看图用**独立会话，每 8 轮自动换新**——否则历史里的图会滚雪球，一小时的消耗是平方级的。
- 想更省：把 `watchSpeed` 设 `quiet`（只定时、不变化触发）。

## 隐私

- 截图只在**本机**从 `capture.py` 传给 `bridge.mjs`，再由 bridge 作为图片块交给**你自己配置的 DSH 模型**；不经过任何第三方服务器。
- 默认**只截前台窗口**，不截整屏（也顺带让令牌更省、识别更准）。
- 抓屏走 GDI，**抓不到本插件自己的透明浮层**——所以画面里不会出现球和气泡，不存在"她盯着自己说话"。
- `config.json`、会话 id、截图都已在 `.gitignore` 里，不会被提交。

## 已知限制

- **独占全屏抓不到**：GDI 对 exclusive fullscreen 会返回黑图，请用**无边框全屏**。
- 透明浮层无法被系统截屏捕获（这是特性，不是 bug）；要用 `Ctrl+Alt+P` 让 Electron 自己截自己。
- 目前仅 Windows。

## 目录结构

```
index.js            宿主：起停子进程、/api/whale/* 路由
client.js           浏览器半端：设置页「鲸鱼娘」
cordis.patch.yml    插件挂载声明
overlay/            Electron 浮层（气泡/球/输入条/设置面板）
bridge/             陪玩 agent 桥 + 抓屏 + 画面监视 + 人格文件
scripts/install.ps1 安装脚本
```

## 开发

- 改 `overlay/renderer.js` `style.css` `index.html` 会**热重载**（不用重启）
- 改 `index.js` `bridge.mjs` 需要重启
- 调试端点：浮层 `GET :8765/health` `POST :8765/say` `POST :8765/watch {"once":true}`；桥 `GET :8766/health` `POST :8766/chat` `POST :8766/observe` `POST :8766/reload`

## 许可与致谢

MIT。头像 GIF 取自 [mini-yifan/dsh-orb-cordis](https://github.com/mini-yifan/dsh-orb-cordis)（MIT），已压缩到 128px 以免仓库过大；完整素材见原仓库。

## 常见问题

**设置里没有「鲸鱼娘」这一页**
说明浏览器半端没被加载。检查两处：
1. `package.json` 的 `exports["./client"]` 指向的文件是否真的存在；
2. `dsh.client.inject` 里的客户端包名是否**本机真实存在**（`ls <DSH>/node_modules/@deepseek-ai | grep dsh-client-`）。
写错一个不存在的包名，整个 web 会起不来，报错形如
`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。

**点了启动，球不出来**
看设置页有没有"还没装依赖"提示：多半是 Electron 没装（`overlay/node_modules/electron` 不存在），跑一次 `scripts/install.ps1`。

**她看不见游戏画面 / 抓到黑图**
用了**独占全屏**。改成无边框全屏（Borderless）即可——GDI 抓屏对独占全屏无解。

**`8765` / `8766` 端口被占**
可能是旧进程没退。设置页点「停止」，或结束占用进程后再「启动」。插件启动前会先探端口，已在跑就不会重复拉起。

**设置页里点开关，她总冒话打断**
已修：面板打开时暂停自动陪看，自动消息会暂存到关面板后再播。若仍出现，多半是旧版本，重启 DSH。

**太费 token**
把「反应速度」调到 **安静**（只定时、不按画面变化触发），或直接把自动陪看关掉，只用聊天。

## 参与开发

- 前端三件套（`overlay/renderer.js`、`style.css`、`index.html`）改动会热重载
- 宿主/桥（`index.js`、`bridge/bridge.mjs`）需要重启 DSH
- 调试端点见上文"开发"一节
- 提交前请确认没有把 `config.json`、会话 id、截图带进仓库（`.gitignore` 已覆盖）
