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
const CFTUNNEL_REPO = "qingchencloud/cftunnel";
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
    const up = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null);
    if (up) candidates.push(`${up}/AppData/Local/cftunnel/cftunnel.exe`);
    candidates.push("C:/Program Files/cftunnel/cftunnel.exe");
    candidates.push("C:/Program Files (x86)/cftunnel/cftunnel.exe");
    if (up) candidates.push(`${up}/.cftunnel/cftunnel.exe`);
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
  if (platform === "win32") {
    const home = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null) || env.HOME;
    return home ? `${home}/.cftunnel` : null;
  }
  return env.HOME ? `${env.HOME}/.cftunnel` : null;
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
 * 解析 `cftunnel list` 的分节输出（官方：列出所有路由和规则）。
 * 真实样例形状：
 *   Relay 规则:
 *   名称      协议    本地端口      远程端口      域名
 *   ----    ----  --------  --------  ----
 *   web-demo  tcp   8080     8080     -
 * 按 “xxx:” 小节拆开，分别归为 cloudRoutes / relayRules。
 */
export function parseListOutput(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const out = { cloudRoutes: [], relayRules: [], sections: [] };
  let section = null;
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    const rows = parseRouteTable(buffer.join("\n"));
    const key = (section || "").toLowerCase();
    if (/cloud|路由/.test(key)) out.cloudRoutes.push(...rows);
    else out.relayRules.push(...rows);
    out.sections.push({ title: section, rows });
    buffer = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m = line.match(/^\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9 /-]*):\s*$/);
    if (m) { flush(); section = m[1].trim(); continue; }
    if (!line.trim()) continue;
    buffer.push(line);
  }
  flush();
  return out;
}

/**
 * 解析 `diagnose --json` 的输出（Cloud 模式链路诊断）。
 * 真实样例：{ cloudflared:{installed,path,version,running}, api:{reachable,latency_ms}, routes:[], total, passed, failed }
 */
export function parseDiagnoseJson(json) {
  const d = typeof json === "string" ? safeJson(json) : json || {};
  const cf = d.cloudflared || {};
  return {
    cloudflared: {
      installed: !!cf.installed,
      path: cf.path ?? null,
      version: cf.version ?? null,
      running: !!cf.running,
    },
    api: { reachable: !!d.api?.reachable, latencyMs: Number.isFinite(d.api?.latency_ms) ? d.api.latency_ms : null },
    routes: Array.isArray(d.routes) ? d.routes : [],
    total: Number.isFinite(d.total) ? d.total : null,
    passed: Number.isFinite(d.passed) ? d.passed : null,
    failed: Number.isFinite(d.failed) ? d.failed : null,
  };
}

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
      return { argv: ["list"] };
    case "relayList":
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
      // 官方：--proto tcp|udp（仅 --relay 时有效）
      if (params.useRelay && str(params.proto)) argv.push("--proto", str(params.proto));
      if (str(params.auth)) argv.push("--auth", str(params.auth));
      // 官方分享扩展：--share / --qr / --telegram
      if (params.share) argv.push("--share");
      if (params.qr) argv.push("--qr");
      if (params.telegram) argv.push("--telegram");
      return { argv };
    }
    case "share": {
      const addr = str(params.address);
      if (!addr) return { error: "缺少要分享的公网地址" };
      const argv = ["share", addr];
      if (params.qr) argv.push("--qr");
      return { argv };
    }
    case "presetList":
      return { argv: ["preset", "list"] };
    case "presetRun": {
      const name = str(params.name);
      if (!name) return { error: "缺少模板名称" };
      const argv = ["preset", name];
      if (params.share) argv.push("--share");
      return { argv };
    }
    case "history":
      return { argv: ["history"] };
    case "historyClear":
      return { argv: ["history", "clear"] };
    case "logs":
      return { argv: params.mode === "cloud" ? ["logs"] : ["relay", "logs"] };
    case "check":
      return { argv: ["relay", "check", "--json"] };
    case "diagnose":
      return { argv: params.json ? ["diagnose", "--json"] : ["diagnose"] };
    case "relayList":
      return { argv: ["relay", "list"] };
    case "cloudInit": {
      const token = str(params.token);
      if (!token) return { error: "缺少 Cloudflare API 令牌" };
      const argv = ["init", "--token", token];
      if (str(params.account)) argv.push("--account", str(params.account));
      return { argv };
    }
    case "cloudCreate": {
      const name = str(params.name);
      if (!name) return { error: "缺少隧道名称" };
      return { argv: ["create", name] };
    }
    case "cloudAdd": {
      const name = str(params.name);
      const p = toPort(params.port);
      if (!name) return { error: "缺少路由名称" };
      if (!p) return { error: "缺少本地端口" };
      const argv = ["add", name, String(p)];
      if (str(params.domain)) argv.push("--domain", str(params.domain));
      if (str(params.auth)) argv.push("--auth", str(params.auth));
      return { argv };
    }
    case "cloudRemove": {
      const name = str(params.name);
      if (!name) return { error: "缺少路由名称" };
      return { argv: ["remove", name] };
    }
    case "installService":
      return { argv: params.mode === "cloud" ? ["install"] : ["relay", "install"] };
    case "uninstallService":
      return { argv: params.mode === "cloud" ? ["uninstall"] : ["relay", "uninstall"] };
    case "update":
      return { argv: ["update"] };
    case "checkUpdate":
      return { argv: ["version", "--check"] };
    case "destroy": {
      const argv = ["destroy"];
      if (params.force) argv.push("--force");
      return { argv };
    }
    case "reset": {
      const argv = ["reset"];
      if (params.force) argv.push("--force");
      return { argv };
    }
    default:
      return { error: `未知操作：${action}` };
  }
}

// ---------------------------------------------------------------- 能力探测

/**
 * 从 `cftunnel --help` 输出里解析出实际支持的命令名。
 * 为何不用版本号判断：该项目版本号会回退（0.8.1 在 3 月、0.4.4 在 9 月），
 * 拿版本比大小必错。以实际命令表为准才是事实。
 */
export function parseHelpCommands(helpText) {
  const out = new Set();
  const lines = String(helpText ?? "").replace(/\r/g, "").split("\n");
  let inCommands = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^Available Commands:/i.test(line)) { inCommands = true; continue; }
    if (!inCommands) continue;
    if (!line) {
      // 空行后若已收集到命令则结束
      if (out.size) break;
      continue;
    }
    if (/^(Flags:|Use |Global Flags:)/i.test(line)) break;
    const m = line.match(/^([a-z][a-z0-9-]*)\s{2,}/);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * 界面功能 → 所需命令。用于按实际能力置灰按钮。
 */
const FEATURE_REQUIREMENTS = {
  quick: ["quick"],
  share: ["share"],
  preset: ["preset"],
  history: ["history"],
  relay: ["relay"],
  update: ["update"],
  diagnose: ["diagnose"],
};

/** 根据已支持命令集合，算出哪些界面功能可用。 */
export function featureAvailability(commands) {
  const set = commands instanceof Set ? commands : new Set(commands || []);
  const out = {};
  for (const [feature, needs] of Object.entries(FEATURE_REQUIREMENTS)) {
    out[feature] = needs.every((c) => set.has(c));
  }
  out.known = set.size > 0; // 是否成功探测到（空=探测失败，不应据此置灰）
  return out;
}

// ---------------------------------------------------------------- 发布与安装

/** GitHub Releases 接口与下载页（本 App 不携带引擎二进制，只负责编排下载）。 */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${CFTUNNEL_REPO}/releases/latest`;
const RELEASE_DOWNLOAD_BASE = `https://github.com/${CFTUNNEL_REPO}/releases/download/`;

/**
 * 下载加速候选（顺序按实测调整：2026-09 实测 ghfast.top 不可用，已移到最后）。
 * 空串=直连。直连虽可用但慢，镜像快时优先。
 * 每个源都有独立超时，不会卡死在一个源上。
 */
export const CFTUNNEL_MIRRORS = ["https://gh-proxy.com/", "https://ghproxy.net/", "", "https://ghfast.top/"];

/**
 * 平台对应的发布资产名。
 * 只认官方实际存在的组合，其他回 null 交给上层报“不支持当前平台”。
 */
export function releaseAssetName(platform = process.platform, arch = process.arch) {
  const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
  const cpu = { x64: "amd64", arm64: "arm64" }[arch];
  if (!os || !cpu) return null;
  const ext = os === "windows" ? "zip" : "tar.gz";
  return `cftunnel_${os}_${cpu}.${ext}`;
}

/**
 * 解析 /releases/latest 的 JSON。
 * 注意：本项目的版本号会回退（v0.8.1 在 2026-03，v0.4.4 在 2026-09），
 * 所以“是否最新”只能看 GitHub 的 latest 指向，绝不能用 semver 比大小。
 */
export function parseLatestRelease(json) {
  const data = typeof json === "string" ? safeJson(json) : json || {};
  const tag = typeof data.tag_name === "string" ? data.tag_name : null;
  if (!tag) return { ok: false, error: "未能从 Releases 接口取到版本号（可能被限流或断网）" };
  const assets = Array.isArray(data.assets)
    ? data.assets.map((a) => ({
        name: a?.name ?? "",
        url: a?.browser_download_url ?? null,
        size: Number.isFinite(a?.size) ? a.size : null,
      }))
    : [];
  return {
    ok: true,
    tag,
    version: tag.replace(/^v/, ""),
    publishedAt: data.published_at ?? null,
    assets,
  };
}

/** 从资产列表挑出本平台的包；找不到返回 null。 */
export function pickReleaseAsset(assets, platform = process.platform, arch = process.arch) {
  const want = releaseAssetName(platform, arch);
  if (!want || !Array.isArray(assets)) return null;
  return assets.find((a) => a?.name === want) || null;
}

/** 给下载 URL 套上镜像前缀。 */
export function mirrorDownloadUrl(url, mirror = "") {
  if (!url) return null;
  return mirror ? `${mirror}${url}` : url;
}

/** 镜像标签（空串=直连）。 */
export function mirrorLabel(mirror) {
  if (!mirror) return "直连";
  try {
    return new URL(mirror).hostname;
  } catch {
    return mirror;
  }
}

/**
 * cftunnel 自身的安装目录（与官方安装脚本一致）。
 * 卸载就是清这个目录；配置目录（~/.cftunnel）单独处理，不绑在一起删。
 * 注：App 沙箱进程的环境变量可能不含 LOCALAPPDATA，故用 USERPROFILE 兜底。
 */
export function cftunnelInstallDir(env = {}, platform = process.platform) {
  if (platform !== "win32") return env.HOME ? `${env.HOME}/.local/bin` : null;
  if (env.LOCALAPPDATA) return `${env.LOCALAPPDATA}\\cftunnel`;
  const up = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null);
  return up ? `${up}\\AppData\\Local\\cftunnel` : null;
}

/**
 * “已是最新”的判定：字符串相等。
 * 绝不用 semver——本项目版本号回退过，比大小必错。
 */
export function isUpToDate(localVersion, latestVersion) {
  const norm = (v) => String(v ?? "").replace(/^v/, "").trim();
  if (!norm(localVersion) || !norm(latestVersion)) return false;
  return norm(localVersion) === norm(latestVersion);
}

// ---------------------------------------------------------------- 引擎（cloudflared / frpc）

/** 引擎二进制名（按平台）。 */
export function engineBinaryName(kind, platform = process.platform) {
  const ext = platform === "win32" ? ".exe" : "";
  return kind === "cloudflared" ? `cloudflared${ext}` : `frpc${ext}`;
}

/** 引擎落盘目录（实测 cftunnel 认这里；我们把手动/预装的引擎放这）。 */
export function engineBinDir(env = {}, platform = process.platform) {
  const cfg = cftunnelConfigDir(env, platform);
  return cfg ? `${cfg}/bin` : null;
}

/**
 * 从 cftunnel 二进制里读出它钉死的 frp 版本。
 * 必须按它钉的版本来——frp 要求客户端/服务端版本对齐，随便下最新版会连不上。
 * 读不到返回 null，交给上层走“抓自己报的下载地址”兑底。
 */
export function parsePinnedFrpVersion(binaryText) {
  const m = String(binaryText ?? "").match(/FRP_VERSION="(\d+\.\d+\.\d+)"/);
  return m ? m[1] : null;
}

/** frp 发布包名（含版本与平台）。 */
export function frpAssetName(version, platform = process.platform, arch = process.arch) {
  const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
  const cpu = { x64: "amd64", arm64: "arm64" }[arch];
  if (!os || !cpu || !version) return null;
  const ext = os === "windows" ? "zip" : "tar.gz";
  return { file: `frp_${version}_${os}_${cpu}.${ext}`, dir: `frp_${version}_${os}_${cpu}` };
}

/** frp 官方下载地址。 */
export function frpDownloadUrl(version, platform = process.platform, arch = process.arch) {
  const a = frpAssetName(version, platform, arch);
  if (!a) return null;
  return `https://github.com/fatedier/frp/releases/download/v${version}/${a.file}`;
}

/** cloudflared 资产名。 */
function cloudflaredAssetName(platform = process.platform, arch = process.arch) {
  const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
  const cpu = { x64: "amd64", arm64: "arm64" }[arch];
  if (!os || !cpu) return null;
  return platform === "win32" ? `cloudflared-windows-${cpu}.exe` : platform === "darwin" ? `cloudflared-darwin-${cpu}.tgz` : `cloudflared-linux-${cpu}`;
}

/** cloudflared 官方下载地址（不钉版本，走 latest）。 */
export function cloudflaredDownloadUrl(platform = process.platform, arch = process.arch) {
  const name = cloudflaredAssetName(platform, arch);
  return name ? `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}` : null;
}

/**
 * 从 cftunnel 自己的输出里抓它想下载的 URL（兑底路径）。
 * 它下载失败时会把完整地址打出来，比猜版本稳。
 */
export function extractDownloadUrl(text) {
  const m = String(text ?? "").match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[^\s"']+/);
  return m ? m[0] : null;
}

/**
 * cftunnel 本体下载地址（不钉版本：latest 重定向到最新资产）。
 * 好处：即使 GitHub API 被封（国内常见），也能装。
 */
export function cftunnelLatestDownloadUrl(platform = process.platform, arch = process.arch) {
  const asset = releaseAssetName(platform, arch);
  return asset ? `${RELEASE_DOWNLOAD_BASE}latest/download/${asset}` : null;
}

// ---------------------------------------------------------------- 脱敏

/** 需要遮蔽后续值的参数（凭证类）。 */
const SECRET_FLAGS = new Set(["--token", "--pass", "--password", "--auth", "--secret"]);

/**
 * 命令行回显脱敏：凭证参数后面的值不得出现在返回值、日志或模型上下文里。
 * 纯函数，可单测。
 */
export function redactSecrets(argv) {
  const arr = Array.isArray(argv) ? argv : [];
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    out.push(arr[i]);
    if (SECRET_FLAGS.has(arr[i]) && i + 1 < arr.length) {
      out.push("***");
      i += 1;
    }
  }
  return out.join(" ");
}

// ---------------------------------------------------------------- 掉线自愈

/**
 * 运行期看门狗的判定（纯逻辑，便于单测）。
 * 返回：
 *  - "skip"   不该动（未开自愈 / 用户本就不想让它跑 / 进程还活着 / 上一轮巡检未结束）
 *  - "heal"   该重连
 *  - "giveup" 连续失败已达上限，停止自动重连（避免无休止重试刷通知）
 * 只负责「该不该」，不碰进程——执行留在 App 入口层。
 */
export function healDecision({ desired, autoHeal, alive, failures = 0, maxFails = 5, busy = false } = {}) {
  if (busy) return "skip";
  if (!desired || !autoHeal) return "skip";
  if (alive !== false) return "skip"; // alive 为 true/null（不确定）时都不动
  if (failures >= maxFails) return "giveup";
  return "heal";
}

/**
 * 由 relay check 的结果判定隧道健不健康（纯逻辑，便于单测）。
 * 重要：不能只看 frpc_running——它读的是 pid 文件，进程死了该文件还在，会误报 true。
 * 真正可信的是规则连通性：本地端口能到、远端端口能到，才算通。
 * 返回 "up" | "down" | "unknown"。
 */
export function tunnelHealthFromCheck(parsed) {
  if (!parsed || typeof parsed !== "object") return "unknown";
  if (parsed.frpcRunning === false) return "down";
  const passed = Number(parsed.passed);
  const failed = Number(parsed.failed);
  // 有失败、且一条都没通 → 判定掉线
  // （frpc 已死但 pid 文件还在的典型表现：frpcRunning 报 true，但规则全不通）
  if (Number.isFinite(passed) && Number.isFinite(failed) && failed > 0 && passed === 0) return "down";
  if (Number.isFinite(passed) && passed > 0) return "up";
  // 没有规则可判 → 不冤枉它
  return "unknown";
}

/**
 * 看门狗节流（纯逻辑，便于单测）：
 * 大部分心跳只做「廉价探活」（看 pid 还在不在，零成本）；
 * 每隔 deepEvery 次才做一次全链路体检（真去测规则通不通）。
 * 既省资源，又不丢「进程还在但已断连」这种隐性故障。
 */
export function isDeepCheckTick(tick, deepEvery = 10) {
  if (!Number.isFinite(tick) || tick <= 0) return true; // 第一轮总是深查
  if (!Number.isFinite(deepEvery) || deepEvery <= 0) return true;
  return tick % deepEvery === 0;
}

// ---------------------------------------------------------------- 危险动作

/** 需要二次确认的动作（不可逆或影响外部）。 */
export const DANGEROUS_ACTIONS = new Set([
  "relayRemove",
  "cloudRemove",
  "destroy",
  "reset",
  "uninstallService",
  "uninstallSelf",
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
  installSelf: "安装 cftunnel",
  uninstallSelf: "卸载 cftunnel",
  repairEngine: "预装/修复引擎",
  share: "分享地址",
  presetRun: "按模板启动",
  presetList: "查看模板",
  history: "端口记录",
  historyClear: "清空端口记录",
  relayList: "查看规则",
  cloudInit: "配置 Cloudflare 认证",
  cloudCreate: "创建隧道",
  cloudAdd: "添加 Cloud 路由",
  cloudRemove: "删除 Cloud 路由",
};
