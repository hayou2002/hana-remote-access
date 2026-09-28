// 远程访问 App — 把 cftunnel 内网穿透工具做成 Hana 面板 + 工具。
//
// 分层：
//   lib/cftunnel-core.js  纯逻辑与平台适配（可单测，不依赖宿主）
//   index.js              与宿主 SDK 打交道：工具注册、后端路由、自启动编排
// 约束：子进程一律 cleanEnv()（隧道直连，剔除残留代理变量）、execFile 不走 shell。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

import {
  CFTUNNEL_DOC,
  CFTUNNEL_RELEASES,
  DEFAULT_MODE,
  MODES,
  DANGEROUS_ACTIONS,
  ACTION_LABELS,
  cleanEnv,
  cftunnelExecutableCandidates,
  cftunnelConfigDir,
  parseCftunnelVersion,
  compareVersions,
  clip,
  tailLines,
  parseRouteTable,
  parseStatusJson,
  parseCheckJson,
  portFromServerInfo,
  resolveLocalPort,
  extractQuickUrl,
  relayPublicAddress,
  buildCommand,
} from "./lib/cftunnel-core.js";

const execFileAsync = promisify(execFile);

const VERSION = "0.1.1";

const TIMEOUT = {
  probe: 15_000,
  status: 20_000,
  action: 60_000,
  quick: 20_000,
  logs: 20_000,
  update: 5 * 60_000,
};

const MAX_BUFFER = 8 * 1024 * 1024;
const LOG_KEEP = 12_000;

const MISSING_HINT =
  "未检测到 cftunnel。请先从官方 Releases 下载并安装：见面板「安装引导」，或访问 " + CFTUNNEL_RELEASES;

const text = (body) => ({ content: [{ type: "text", text: body }] });
const fail = (message, hint) => ({
  content: [{ type: "text", text: hint ? `${message}\n提示：${hint}` : message }],
  isError: true,
});

/**
 * 把 ResourceIO `read` 的返回统一解成文本。
 * 实测返回形如 { content: Uint8Array, resource, ... }；为鲁棒也兼容 string / {text} 等。
 */
function decodeResourceText(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  const buf = raw.content ?? raw.bytes ?? raw.data;
  if (buf instanceof Uint8Array) return Buffer.from(buf).toString("utf8");
  if (buf instanceof ArrayBuffer) return Buffer.from(buf).toString("utf8");
  if (typeof raw.text === "string") return raw.text;
  if (typeof buf === "string") return buf;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/** 配置默认值（全部可被用户覆盖，App 不写死任何个人参数）。 */
const DEFAULT_CONFIG = {
  mode: DEFAULT_MODE, // cloud | relay
  localPort: null, // 要暴露的本地端口；null=自动探测 Hana 端口
  server: "", // Relay 模式：中继服务器 IP:端口
  token: "", // Relay 模式：中继鉴权密钥
  autoStart: true, // 随 Hana 启动自动拉起隧道
  authEnabled: false, // 临时分享是否带密码
};

export const name = "remote-access";

import { defineApp } from "./sdk/app-contract/server-client.js";

export default defineApp(async (sdk) => {
  await sdk.logger.info(`remote-access ${VERSION} loaded`);

  const dataDir = sdk.dataDir || process.cwd();

  // ---------------------------------------------------------------- 配置

  let config = { ...DEFAULT_CONFIG };
  async function loadConfig() {
    try {
      const all = await sdk.storage.global.getAll();
      config = { ...DEFAULT_CONFIG, ...(all?.config || {}) };
    } catch (error) {
      await sdk.logger.warn(`读取配置失败，使用默认值：${String(error)}`);
    }
    return config;
  }
  async function saveConfig(patch) {
    config = { ...config, ...(patch || {}) };
    // 归一化：空串转 null、端口转数字
    if (config.localPort !== null && config.localPort !== "") {
      const n = Number.parseInt(config.localPort, 10);
      config.localPort = Number.isFinite(n) ? n : null;
    } else {
      config.localPort = null;
    }
    await sdk.storage.global.set("config", config);
    return config;
  }

  // ---------------------------------------------------------------- 进程执行

  async function run(command, argv, { timeoutMs = TIMEOUT.action } = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(command, argv, {
        shell: false,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: cleanEnv(),
      });
      return { ok: true, stdout: clip(stdout), stderr: clip(stderr) };
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: false, enoent: true };
      return {
        ok: false,
        killed: !!error?.killed,
        code: error?.code ?? error?.signal,
        stdout: clip(error?.stdout ?? ""),
        stderr: clip(error?.stderr ?? ""),
        message: error?.message ? String(error.message) : "",
      };
    }
  }

  /** 解析 cftunnel 可执行路径。结果缓存；并发调用共享同一次解析。 */
  let cfPath = null;
  let cfPathPending = null;
  async function resolveCf() {
    if (cfPath) return cfPath;
    if (cfPathPending) return cfPathPending;
    cfPathPending = (async () => {
      const candidates = cftunnelExecutableCandidates(process.env, process.platform);
      try {
        const info = await sdk.process.resolveExecutable({ candidates });
        return info?.path || candidates.at(-1);
      } catch {
        return candidates.at(-1);
      }
    })()
      .then((resolved) => {
        cfPath = resolved;
        return resolved;
      })
      .finally(() => {
        cfPathPending = null;
      });
    return cfPathPending;
  }

  async function cf(argv, options = {}) {
    const result = await run(await resolveCf(), argv, options);
    if (result.enoent) cfPath = null;
    return result;
  }

  const describe = (r) => (r.killed ? "超时被终止" : `退出码 ${r.code ?? "未知"}`);

  /**
   * 修复陈旧锁：cftunnel 只看 frpc.pid 文件不验进程死活，异常退出后锁会残留，
   * 导致 status 假报运行中、up 被“已在运行”挡住、重启后自启动永远失败。
   * 只在确认 frpc 真没跑时删这个 5 字节锁文件（用子进程绕开 App 沙箱写限制）。
   */
  async function repairStaleLock() {
    const dir = cftunnelConfigDir(process.env, process.platform);
    if (!dir) return false;
    const pidPath = `${dir.replace(/\//g, "\\")}\frpc.pid`;
    const r = await run("cmd.exe", ["/c", "del", "/q", pidPath], { timeoutMs: 8000 });
    await sdk.logger.info(`修复陈旧启动锁：${r.ok ? "已清除" : `失败（${describe(r)}）`}`);
    return r.ok;
  }

  /** 经 relay check 确认 frpc 是否真在运行（不信 pid 文件）。 */
  async function frpcActuallyRunning() {
    const real = await cf(["relay", "check", "--json"], { timeoutMs: TIMEOUT.status });
    return real.ok ? parseCheckJson(real.stdout).frpcRunning : null;
  }

  // ---------------------------------------------------------------- 端口探测

  /**
   * 探测 Hana 自身监听端口（"默认暴露 Hana 自己"的来源）。
   * 通用做法：从 dataDir 反推 HANA_HOME，读 server-info.json。
   * 读不到就返回 null，交给用户在设置里手填。
   */
  async function detectHanaPort() {
    try {
      const hanaHome = path.dirname(path.dirname(dataDir)); // {HANA_HOME}/app-data/{appId} → {HANA_HOME}
      const infoPath = path.join(hanaHome, "server-info.json");
      const raw = await sdk.resources.read({ kind: "local-file", path: infoPath });
      const content = decodeResourceText(raw);
      return portFromServerInfo(content);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- 状态

  async function readEnvironment() {
    const [version, status] = await Promise.all([
      cf(["version"], { timeoutMs: TIMEOUT.probe }),
      cf(["status", "--json"], { timeoutMs: TIMEOUT.status }),
    ]);

    const installed = !version.enoent;
    const parsed = parseStatusJson(status.ok ? status.stdout : "{}");
    return {
      installed,
      path: await resolveCf(),
      version: installed ? parseCftunnelVersion(version.stdout) : null,
      rawVersion: version.stdout?.trim() || null,
      cloud: parsed.cloud,
      relay: parsed.relay,
      statusError: status.ok ? null : describe(status),
    };
  }

  /** 当前生效的本地端口（配置优先，其次探测 Hana）。 */
  async function effectivePort() {
    const hanaPort = await detectHanaPort();
    return resolveLocalPort({ configuredPort: config.localPort, hanaPort });
  }

  /** 组装完整状态快照，供面板与工具共用。 */
  async function snapshot() {
    const env = await readEnvironment();
    const hanaPort = await detectHanaPort();
    const localPort = resolveLocalPort({ configuredPort: config.localPort, hanaPort });
    const active = config.mode === "relay" ? env.relay : env.cloud;
    return {
      ok: true,
      appVersion: VERSION,
      platform: process.platform,
      cftunnel: {
        installed: env.installed,
        version: env.version,
        path: env.path,
        docs: CFTUNNEL_DOC,
        releases: CFTUNNEL_RELEASES,
        configDir: cftunnelConfigDir(process.env, process.platform),
      },
      config: { ...config, token: config.token ? "***" : "" },
      mode: config.mode,
      active: { running: !!active?.running, server: active?.server ?? null },
      cloud: env.cloud,
      relay: env.relay,
      ports: { hana: hanaPort, configured: config.localPort, effective: localPort },
      publicAddress: publicAddressFor(env),
      statusError: env.statusError,
    };
  }

  /** 当前模式下的公网访问地址（Relay 用服务器+远程端口，Cloud 用路由域名）。统一补 /pad/ 网页入口。 */
  function publicAddressFor(env) {
    let base = null;
    if (config.mode === "relay") {
      const wantPort = config.localPort ?? env.ports?.hana ?? null;
      const rule =
        (wantPort != null && env.relay?.rules?.find((r) => r.localPort === wantPort)) ||
        env.relay?.rules?.[0];
      base = rule ? relayPublicAddress(env.relay?.server, rule.remotePort) : null;
    } else {
      const route = env.cloud?.routes?.[0];
      base = route?.domain ? `https://${route.domain}` : null;
    }
    return base ? `${base.replace(/\/+$/, "")}/pad/` : null;
  }

  // ---------------------------------------------------------------- 动作执行

  /** 需要用户显式确认的危险动作集合（供工具层与面板层共用）。 */
  function isDangerous(action) {
    return DANGEROUS_ACTIONS.has(action);
  }

  /**
   * 执行一个 cftunnel 动作。
   * 返回 { ok, action, argv, stdout, stderr, error, publicUrl? }。
   */
  async function perform(action, params = {}) {
    const built = buildCommand(action, { mode: config.mode, ...params });
    if (built.error) return { ok: false, action, error: built.error };

    const argv = built.argv;
    const timeoutMs = action === "quick" ? TIMEOUT.quick : action === "logs" ? TIMEOUT.logs : action === "update" ? TIMEOUT.update : TIMEOUT.action;
    let result = await cf(argv, { timeoutMs });

    // relay up 若报“已在运行”：看真实进程。陈旧 pid 锁会让它假死——用 check 的实况纠正语义。
    if (action === "up" && !result.ok && /已在运行|already running/i.test(`${result.stderr}${result.stdout}`)) {
      if ((await frpcActuallyRunning()) === false) {
        // 假死：清掉陈旧锁，重试一次
        await repairStaleLock();
        result = await cf(argv, { timeoutMs });
        if (result.ok) {
          return { ok: true, action, label: ACTION_LABELS[action], argv: argv.join(" "), stdout: `${result.stdout}\n（已自动修复陈旧的启动锁）`, stderr: result.stderr, error: null, repaired: true };
        }
      } else {
        return { ok: true, action, label: ACTION_LABELS[action], argv: argv.join(" "), stdout: "隧道本来就在运行，无需重复启动。", stderr: "", error: null };
      }
    }

    if (result.enoent) {
      return { ok: false, action, argv, error: MISSING_HINT };
    }

    const out = {
      ok: result.ok,
      action,
      label: ACTION_LABELS[action] || action,
      argv: [await resolveCf(), ...argv].join(" "),
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: result.ok ? null : describe(result),
    };

    // quick 成功后提取临时公网地址
    if (action === "quick" && result.ok) {
      out.publicUrl = extractQuickUrl(result.stdout);
    }
    // check 成功解析为结构化诊断
    if (action === "check" && result.ok) {
      out.diagnosis = parseCheckJson(result.stdout);
    }
    if (action === "list" && result.ok) {
      out.routes = parseRouteTable(result.stdout);
    }
    return out;
  }

  // ---------------------------------------------------------------- 日志缓冲

  let logBuf = "";
  const pushLog = (line) => {
    const clean = String(line).replace(/\r/g, "").trimEnd();
    if (clean) logBuf = `${logBuf ? `${logBuf}\n` : ""}${clean}`.slice(-LOG_KEEP);
  };

  // ---------------------------------------------------------------- 自启动

  let autoStartTimer = null;
  /**
   * 随 Hana 启动自动拉起隧道（第一层自启动）。
   * 通用做法：读配置 → 若 autoStart 且已装 → 延迟拉起（给宿主与网络留就绪时间）。
   * 失败不阻塞 Hana 启动，只记日志 + 发通知。
   */
  async function scheduleAutoStart() {
    if (!config.autoStart) return;
    const env = await readEnvironment();
    if (!env.installed) {
      await sdk.logger.info("自启动跳过：未检测到 cftunnel。");
      return;
    }
    // Relay 模式需要服务器地址：App 没配就用 cftunnel 自带的（env.relay.server）
    const relayServer = config.server || env.relay?.server;
    if (config.mode === "relay" && !relayServer) {
      await sdk.logger.info("自启动跳过：Relay 模式尚未配置中继服务器（App 与 cftunnel 都没有）。");
      return;
    }
    let already = config.mode === "relay" ? env.relay.running : env.cloud.running;
    // 重启后 frpc.pid 会变陈旧，状态会误报“运行中”让自启动跳过；用 check 实况纠偏。
    if (config.mode === "relay" && already && (await frpcActuallyRunning()) === false) {
      await sdk.logger.info("检测到陈旧启动锁（状态报运行中但 frpc 未跑），转入启动+修复流程。");
      already = false;
    }
    if (already) {
      await sdk.logger.info("自启动跳过：隧道已在运行。");
      return;
    }
    autoStartTimer = setTimeout(async () => {
      autoStartTimer = null;
      try {
        const res = await perform("up", {});
        if (res.ok) {
          await sdk.notifications.show({ title: "远程访问", body: "隧道已随 Hana 自动启动。" });
        } else {
          await sdk.notifications.show({ title: "远程访问", body: `隧道自动启动失败：${res.error || "未知原因"}` });
        }
      } catch (error) {
        await sdk.logger.warn(`自启动失败：${String(error)}`);
      }
    }, 8000);
    if (typeof autoStartTimer.unref === "function") autoStartTimer.unref();
  }

  // ---------------------------------------------------------------- 工具

  await sdk.tools.register({
    name: "remote_access_status",
    description:
      "查看内网穿透（cftunnel）状态：是否安装、版本、当前模式、隧道是否运行、公网地址、要暴露的本地端口。用于确认「在外面能否访问本机 Hana」，或诊断连不上。无需参数。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const snap = await snapshot();
      const lines = [];
      if (!snap.cftunnel.installed) {
        lines.push("cftunnel：未安装", `下一步：先安装 cftunnel（见 ${CFTUNNEL_RELEASES}），再回到面板配置。`);
        return text(lines.join("\n"));
      }
      lines.push(`cftunnel：v${snap.cftunnel.version || "未知"}（${snap.cftunnel.path}）`);
      lines.push(`模式：${MODES[snap.mode]?.label || snap.mode}`);
      lines.push(`隧道：${snap.active.running ? "运行中" : "已停止"}`);
      if (snap.active.server) lines.push(`服务器：${snap.active.server}`);
      lines.push(`本地端口：${snap.ports.effective ?? "未确定"}` + (snap.ports.hana ? `（Hana 探测 ${snap.ports.hana}）` : ""));
      if (snap.publicAddress) lines.push(`公网地址：${snap.publicAddress}`);
      else lines.push("公网地址：暂无（隧道未运行或未配置）");
      return text(lines.join("\n"));
    },
  });

  await sdk.tools.register({
    name: "remote_access_control",
    description:
      "启动或停止内网穿透隧道。action：up（启动）/ down（停止）。启动后可在外网访问本机服务（默认 Hana）。若未安装 cftunnel 会提示安装。",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["up", "down"], description: "up 启动，down 停止" } },
      required: ["action"],
    },
    execute: async (args) => {
      const action = args?.action === "down" ? "down" : "up";
      const res = await perform(action, {});
      if (!res.ok) return fail(`${ACTION_LABELS[action]}失败（${res.error}）。`, res.stderr || MISSING_HINT);
      return text(`${ACTION_LABELS[action]}成功。\n${res.stdout || ""}`.trim());
    },
  });

  await sdk.tools.register({
    name: "remote_access_diagnose",
    description:
      "诊断内网穿透链路：检测中继服务器连通性、本地服务、远程穿透端口，并给出每一段的延迟与结果。用于排查「隧道显示在跑但外面访问不了」。无需参数。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const res = await perform("check", {});
      if (!res.ok) return fail(`诊断失败（${res.error}）。`, res.stderr || MISSING_HINT);
      const d = res.diagnosis;
      const lines = [`服务器：${d.server}（${d.serverOk ? "通" : "不通"}${d.serverLatencyMs != null ? `，${d.serverLatencyMs}ms` : ""}）`];
      lines.push(`frpc：${d.frpcRunning ? "运行中" : "未运行"}`);
      for (const r of d.rules || []) {
        lines.push(`· ${r.name} ${r.proto} ${r.localPort}→${r.remotePort}｜本地${r.localOk ? "✓" : "✗"} 远程${r.remoteOk ? "✓" : "✗"}${r.error ? `（${r.error}）` : ""}`);
      }
      lines.push(`结果：${d.passed ?? "?"} 通 / ${d.failed ?? "?"} 不通`);
      return text(lines.join("\n"));
    },
  });

  // ---------------------------------------------------------------- 后端路由

  await sdk.routes.register((app) => {
    app.get("/status", async (c) => c.json(await snapshot()));

    app.post("/action", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const action = typeof body?.action === "string" ? body.action : "";
      const params = body?.params && typeof body.params === "object" ? body.params : {};
      if (!action) return c.json({ ok: false, error: "缺少 action" }, 400);
      const res = await perform(action, params);
      pushLog(`[${ACTION_LABELS[action] || action}] ${res.ok ? "成功" : "失败"} ${res.error || ""}`.trim());
      return c.json(res);
    });

    app.get("/config", async (c) => c.json({ ok: true, config: { ...config, token: config.token ? "***" : "" }, hasToken: !!config.token }));

    app.post("/config", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const patch = body?.config && typeof body.config === "object" ? body.config : {};
      // token 传 *** 表示"保持不变"
      if (patch.token === "***") delete patch.token;
      const saved = await saveConfig(patch);
      pushLog(`[配置] 已更新：mode=${saved.mode} port=${saved.localPort ?? "自动"} autoStart=${saved.autoStart}`);
      return c.json({ ok: true, config: { ...saved, token: saved.token ? "***" : "" } });
    });

    app.get("/detect", async (c) => c.json({ ok: true, hanaPort: await detectHanaPort(), cftunnelPath: await resolveCf() }));

    app.get("/logs", async (c) => {
      const res = await perform("logs", {});
      return c.json({ ok: res.ok, logs: tailLines(res.stdout || res.stderr || "", 200), error: res.error });
    });

    app.get("/applog", (c) => c.json({ ok: true, log: logBuf }));
  });

  // ---------------------------------------------------------------- 启动

  await loadConfig();
  await sdk.logger.info(`配置：mode=${config.mode} port=${config.localPort ?? "自动"} autoStart=${config.autoStart}`);
  // 延迟自启动，不阻塞 App 加载
  scheduleAutoStart().catch((error) => sdk.logger.warn(`自启动调度失败：${String(error)}`));
});
