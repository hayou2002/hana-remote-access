// 纯逻辑与平台适配层：不依赖 App 运行时，可被 Node 直接 import 做单元测试。
// index.js 只负责与宿主 SDK 打交道，平台细节都落在这里。
//
// 设计要点：
//   · 通用：不写死任何个人服务器 / 端口 / token，全部来自配置或探测。
//   · 可测：所有函数纯输入纯输出，不碰 fs、不碰 process 之外的全局。

// ---------------------------------------------------------------- 常量

/** 残留代理变量：子进程前一律剔除，保证隧道连接不被本机代理干扰。 */
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "WS_PROXY",
  "WSS_PROXY",
  "ALL_PROXY",
  "all_proxy",
];

/** cftunnel 官方仓库与文档。 */
export const CFTUNNEL_REPO = "qingchencloud/cftunnel";
export const CFTUNNEL_DOC = "https://qingchencloud.github.io/cftunnel/";
export const CFTUNNEL_RELEASES = "https://github.com/qingchencloud/cftunnel/releases/latest";

/** 两种穿透模式。 */
export const MODES = {
  cloud: {
    id: "cloud",
    label: "Cloud（Cloudflare）",
    hint: "免费 HTTP/WS 穿透，自动 TLS，全球 CDN；需 Cloudflare 账号与域名。",
  },
  relay: {
    id: "relay",
    label: "Relay（自建中继）",
    hint: "走自己的公网服务器（frps），支持 TCP/UDP 全协议；需一台公网服务器。",
  },
};

export const DEFAULT_MODE = "relay";

// ---------------------------------------------------------------- 环境

/** 剔除残留代理变量（隧道直连原则）。返回新对象，不改原 env。 */
export function cleanEnv(base = {}) {
  const env = { __proto__: null, ...base };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return env;
}

/**
 * cftunnel 可执行文件的候选路径（按优先级）。
 * 不写死单一位置：环境变量 → 常见安装目录 → PATH 兜底。
 */
export function cftunnelExecutableCandidates(env = {}, platform = process.platform) {
  const candidates = [];
  if (env.CFTUNNEL_PATH) candidates.push(env.CFTUNNEL_PATH);
  if (platform === "win32") {
    if (env.LOCALAPPDATA) candidates.push(`${env.LOCALAPPDATA}/cftunnel/cftunnel.exe`);
    candidates.push("C:/Program Files/cftunnel/cftunnel.exe");
    candidates.push("C:/Program Files (x86)/cftunnel/cftunnel.exe");
    if (env.USERPROFILE) candidates.push(`${env.USERPROFILE}/.cftunnel/cftunnel.exe`);
  } else {
    if (env.HOME) {
      candidates.push(`${env.HOME}/.local/bin/cftunnel`);
      candidates.push(`${env.HOME}/.cftunnel/cftunnel`);
    }
    candidates.push("/usr/local/bin/cftunnel", "/opt/homebrew/bin/cftunnel");
  }
  candidates.push("cftunnel"); // PATH 兜底
  return [...new Set(candidates.filter(Boolean))];
}

/** cftunnel 配置文件目录（默认 ~/.cftunnel，便携模式除外）。 */
export function cftunnelConfigDir(env = {}, platform = process.platform) {
  const home = platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME;
  return home ? `${home}/.cftunnel` : null;
}

// ---------------------------------------------------------------- 版本

/** 从 `cftunnel 0.8.1` 里取纯语义化版本号；失败返回 null。 */
export function parseCftunnelVersion(text) {
  const m = String(text ?? "").match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return m ? m[1] : null;
}

/** 语义化版本比较：a > b 返回正数，a < b 返回负数，相等 0。 */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b ?? "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- 文本

export function clip(text, max = 60_000) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[输出已截断：共 ${value.length} 字符，保留前 ${max} 字符。]`;
}

/** 把 cftunnel 的日志尾读到指定行数。 */
export function tailLines(text, maxLines = 200) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  return lines.slice(-maxLines).join("\n");
}

// ---------------------------------------------------------------- 解析

/**
 * 解析 cftunnel 的中文表格输出（`relay list`、`list`）。
 * 列以 2+ 空白分隔；跳过表头与虚线分隔行。
 * 返回 [{ name, proto, localPort, remotePort, domain }]。
 */
export function parseRouteTable(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const rows = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (/^[-—\s]+$/.test(line)) continue; // 虚线分隔行
    const cols = line.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    if (cols[0] === "名称") continue; // 表头
    const [name, proto, localPort, remotePort, domain] = cols;
    rows.push({
      name,
      proto: proto || "tcp",
      localPort: toPort(localPort),
      remotePort: toPort(remotePort),
      domain: domain && domain !== "-" ? domain : null,
    });
  }
  return rows;
}

/** 宽松转端口号：非数字返回 null。 */
function toPort(value) {
  if (value === undefined || value === null || value === "-") return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 `status --json` 的输出为统一状态对象。
 * 兼容 cloud 段缺失（未配置 Cloud 时不报错）。
 */
export function parseStatusJson(json) {
  const data = typeof json === "string" ? safeJson(json) : json || {};
  const relay = data.relay || null;
  const cloud = data.cloud || null;
  return {
    cloud: cloud
      ? {
          configured: true,
          running: !!cloud.running,
          server: cloud.server ?? null,
          tunnelId: cloud.id ?? cloud.tunnel_id ?? null,
          routes: Array.isArray(cloud.routes) ? cloud.routes : [],
        }
      : { configured: false, running: false, server: null, tunnelId: null, routes: [] },
    relay: relay
      ? {
          configured: true,
          running: !!relay.running,
          server: relay.server ?? null,
          rules: Array.isArray(relay.rules) ? relay.rules.map(normalizeRule) : [],
        }
      : { configured: false, running: false, server: null, rules: [] },
  };
}

function normalizeRule(rule) {
  return {
    name: rule?.name ?? "",
    proto: rule?.proto ?? "tcp",
    localPort: toPort(rule?.local_port ?? rule?.localPort),
    remotePort: toPort(rule?.remote_port ?? rule?.remotePort),
    domain: rule?.domain ?? null,
  };
}

/**
 * 解析 `relay check --json` 的输出为诊断结果。
 * 返回 { server, serverOk, latencyMs, frpcRunning, rules: [...], passed, failed }。
 */
export function parseCheckJson(json) {
  const data = typeof json === "string" ? safeJson(json) : json || {};
  const rules = Array.isArray(data.rules) ? data.rules : [];
  return {
    server: data.server ?? null,
    serverOk: !!data.server_ok,
    serverLatencyMs: Number.isFinite(data.server_latency_ms) ? data.server_latency_ms : null,
    frpcRunning: !!data.frpc_running,
    rules: rules.map((r) => ({
      name: r?.name ?? "",
      proto: r?.proto ?? "tcp",
      localPort: toPort(r?.local_port ?? r?.localPort),
      remotePort: toPort(r?.remote_port ?? r?.remotePort),
      localOk: !!r?.local_ok,
      remoteOk: !!r?.remote_ok,
      latencyMs: Number.isFinite(r?.latency_ms) ? r.latency_ms : null,
      error: r?.remote_err ?? r?.error ?? null,
    })),
    passed: Number.isFinite(data.passed) ? data.passed : null,
    failed: Number.isFinite(data.failed) ? data.failed : null,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 端口探测

/**
 * 从 Hana 的 server-info.json 内容里取监听端口。
 * 这是"默认暴露 Hana 自己"的自动探测来源；读不到就返回 null，交给用户手填。
 */
export function portFromServerInfo(json) {
  const data = typeof json === "string" ? safeJson(json) : json || {};
  const port = toPort(data.port ?? data.network?.actualPort ?? data.network?.port);
  return port ?? null;
}

/**
 * 推断"要暴露的本地端口"：显式配置优先 → 探测到的 Hana 端口 → null。
 */
export function resolveLocalPort({ configuredPort, hanaPort } = {}) {
  return toPort(configuredPort) ?? toPort(hanaPort) ?? null;
}

// ---------------------------------------------------------------- 公网地址

/**
 * 从 quick 命令的输出里提取临时公网地址（*.trycloudflare.com）。
 * 兼容它打印在多行里的情况。
 */
export function extractQuickUrl(text) {
  const m = String(text ?? "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return m ? m[0] : null;
}

/** 把"服务器地址 + 远程端口"拼成可访问地址（Relay 模式用）。 */
export function relayPublicAddress(server, remotePort) {
  if (!server) return null;
  const host = String(server).split(":")[0];
  const port = toPort(remotePort);
  return port ? `http://${host}:${port}` : `http://${host}`;
}

// ---------------------------------------------------------------- 命令构造

/**
 * 构造 cftunnel 子进程参数数组（永不经过 shell）。
 * 返回 { argv } 或 { error }。
 */
export function buildCommand(action, params = {}) {
  const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
  const port = toPort(params.port);
  switch (action) {
    case "version":
      return { argv: ["version"] };
    case "status":
      return { argv: ["status", "--json"] };
    case "list":
      return { argv: ["relay", "list"] };
    case "up":
      return params.mode === "cloud" ? { argv: ["up"] } : { argv: ["relay", "up"] };
    case "down":
      return params.mode === "cloud" ? { argv: ["down"] } : { argv: ["relay", "down"] };
    case "relayInit": {
      const server = str(params.server);
      if (!server) return { error: "缺少中继服务器地址（格式 IP:端口）" };
      const argv = ["relay", "init", "--server", server];
      if (str(params.token)) argv.push("--token", str(params.token));
      return { argv };
    }
    case "relayAdd": {
      const name = str(params.name);
      if (!name) return { error: "缺少路由名称" };
      if (!port) return { error: "缺少本地端口" };
      const argv = ["relay", "add", name, "--local", String(port), "--proto", str(params.proto) || "tcp"];
      if (toPort(params.remotePort)) argv.push("--remote", String(toPort(params.remotePort)));
      return { argv };
    }
    case "relayRemove": {
      const name = str(params.name);
      if (!name) return { error: "缺少路由名称" };
      return { argv: ["relay", "remove", name] };
    }
    case "quick": {
      if (!port) return { error: "缺少端口" };
      const argv = ["quick", String(port)];
      if (params.useRelay) argv.push("--relay");
      if (str(params.auth)) argv.push("--auth", str(params.auth));
      return { argv };
    }
    case "logs":
      return { argv: params.mode === "cloud" ? ["logs"] : ["relay", "logs"] };
    case "check":
      return { argv: ["relay", "check", "--json"] };
    case "diagnose":
      return { argv: ["diagnose"] };
    case "installService":
      return { argv: params.mode === "cloud" ? ["install"] : ["relay", "install"] };
    case "uninstallService":
      return { argv: params.mode === "cloud" ? ["uninstall"] : ["relay", "uninstall"] };
    case "update":
      return { argv: ["update"] };
    case "checkUpdate":
      return { argv: ["version", "--check"] };
    default:
      return { error: `未知操作：${action}` };
  }
}

// ---------------------------------------------------------------- 危险动作

/** 需要二次确认的动作（不可逆或影响外部）。 */
export const DANGEROUS_ACTIONS = new Set([
  "relayRemove",
  "destroy",
  "reset",
  "uninstallService",
]);

/** 动作的中文说明，用于确认文案与日志。 */
export const ACTION_LABELS = {
  up: "启动隧道",
  down: "停止隧道",
  relayInit: "配置中继服务器",
  relayAdd: "添加路由",
  relayRemove: "删除路由",
  quick: "临时分享",
  logs: "查看日志",
  check: "链路诊断",
  diagnose: "Cloud 诊断",
  installService: "注册开机自启",
  uninstallService: "取消开机自启",
  update: "更新 cftunnel",
  checkUpdate: "检查更新",
};
