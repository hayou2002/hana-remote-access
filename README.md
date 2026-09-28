# 远程访问（Hana 远程访问 App）

> 把开源内网穿透工具 [cftunnel](https://qingchencloud.github.io/cftunnel/) 装进 Hana 的一块管理面板：**在外面，打开浏览器就能连回自己的 Hana。**

![远程访问：本机 → 隧道 → 外网设备](docs/architecture.svg)

## 这是什么

Hana 跑在你自己的电脑上，服务只监听本机端口——出了家门就够不着。这个 App 把 **cftunnel**（Cloudflare Tunnel + frp 双引擎）的命令行操作全部搬进图形面板：

- 想看隧道通没通：打开面板一眼看到状态、服务器、公网地址；
- 想开/停隧道：一个按钮，不用记命令；
- 想临时分享：填个端口，几秒钟拿到 `*.trycloudflare.com` 临时地址；
- 想出门也能用：开启「随 Hana 启动自动拉起」，开机即通。

它是通用工具，不绑定任何人的服务器、端口或域名——装好后在设置页填你自己的中继地址即可；中继没配时，面板会引导你完成第一步。

## 我能用它做什么

| 想做的事 | 在面板里 |
|---|---|
| 在外面用浏览器连回家里的 Hana | 启动隧道 → 复制公网地址 → 手机浏览器打开（入口自动带 `/pad/`） |
| 临时把某个端口分享给别人看 | 「临时分享」填端口，一键起 `trycloudflare` 地址 |
| 排查"显示在跑但访问不了" | 「链路诊断」逐段给出服务器 / 本地 / 远程端口通不通、延迟多少 |
| 穿透多个服务 | 「穿透路由」加规则，一条隧道带多端口 |
| 让隧道比 Hana 活得久 | 「注册为系统服务」，Hana 关了也不断 |
| 直接在对话里操作 | 已注册 `remote_access_status / control / diagnose` 三个工具，问一句"隧道通了吗"就行 |

## 快速上手

1. **装引擎**：本 App 不自带 cftunnel（约 19MB，且需要独立更新）。到 [Releases](https://github.com/qingchencloud/cftunnel/releases/latest) 下载装好即可；面板会自动探测安装位置。
   - 小提示：Relay 模式首次启动时 cftunnel 会联网下载 frpc 引擎，国内网络容易失败。若卡在"正在下载 frpc"，从 frp 官方 Release 拿 `frpc.exe` 放进 `~/.cftunnel/bin/` 再启动。
2. **装 App**：把 Releases 里的 `app-remote-access-x.y.z.zip` 在 Hana「市场 → 已安装 → 从本地安装」装上并批准。
3. **配中继**（用 Cloud 模式可跳过）：设置页填你的 frps 地址 `IP:7000` 与鉴权密钥；或直接先在终端跑一次 `cftunnel relay init`。
4. **开隧道**：面板点「启动隧道」，复制公网地址，手机浏览器打开。

![管理面板：状态、启停、临时分享、路由、诊断、自启动](docs/panel.png)

## 两种模式怎么选

| | Cloud（Cloudflare） | Relay（自建 frp） |
|---|---|---|
| 费用 | 免费 | 需一台公网服务器 |
| 协议 | HTTP / WebSocket | TCP / UDP 全协议 |
| TLS | 自动 HTTPS | 明文（敏感操作建议套一层 HTTPS 反代） |
| 地址 | 随机 `*.trycloudflare.com` 或自有域名 | `服务器IP:远程端口` |
| 适合 | 临时分享、网页服务 | 长期自用、数据库/游戏/SSH |

## 安全提醒（认真看）

- 隧道打通 = 你的服务上了公网。暴露前想清楚：**这个服务有没有登录保护？** Hana 自带访问令牌与设备配对，别把没有鉴权的服务裸奔出去。
- Relay 模式默认明文 HTTP，密码类流量请勿直裸跑；Cloud 模式自带 HTTPS，更适合作为长期入口。
- 「注册系统服务」「删除路由」「destroy / reset」都是影响外部可见性的动作，面板一律先弹确认。
- 中继密钥只存在 App 自己的数据目录里，界面上永远掩码显示。

## 开发与结构

```
remote-access/
├── manifest.json          # v2 清单：面板卡 + 设置页 + 6 项能力
├── index.js               # 宿主编排：工具、路由、自启动、陈旧锁自愈
├── lib/cftunnel-core.js   # 纯逻辑：探测 / 命令构造 / 输出解析（18 项单测）
├── ui/                    # 面板与设置页（主题跟随宿主，暖色圆角）
└── tests/                 # 用真实 cftunnel 输出做的解析器测试
```

- 校验：`node <hana-app-creator>/scripts/validate_app.mjs --dir remote-access`（0 错误）
- 单测：`node tests/core.test.mjs`（18 项通过，样例取自 cftunnel 0.8.1 真实输出）

## 更新内容

### v0.1.1
- 自启动前用实况（`relay check`）交叉校验，不被陈旧 `frpc.pid` 僵尸锁欺骗；检测到假死自动清锁重试
- 公网地址自动补 `/pad/` 入口路径（Hana 根路径是 API，直接打开会误以为 403 没通）
- 「已在运行」时先验证真实进程，不再盲信状态输出
- Relay 公网地址跟随生效端口（配置端口 → Hana 探测端口逐级兜底）

### v0.1.0
- 首个版本：cftunnel 全功能面板——状态总览 / 启停 / 临时分享 / 路由增删 / 链路诊断 / 日志 / 系统服务注册
- Cloud 与 Relay 双模式；要暴露的本地端口默认自动探测 Hana，可自定义
- 随 Hana 启动自动拉起隧道（可开关）
- 三个模型工具：`remote_access_status` / `remote_access_control` / `remote_access_diagnose`
- 独立设置页：模式、中继服务器、密钥、端口、自启动、分享鉴权
