// 远程访问 App — 把 cftunnel 内网穿透工具做成 Hana 面板 + 工具。
//
// 分层：
//   lib/cftunnel-core.js  纯逻辑与平台适配（可单测，不依赖宿主）
//   index.js              与宿主 SDK 打交道：工具注册、后端路由、自启动编排
// 约束：子进程一律 cleanEnv()（隧道直连，剔除残留代理变量）、execFile 不走 shell。
import { execFile, spawn } from "node:child_process";
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
  CFTUNNEL_MIRRORS,
  LATEST_RELEASE_API,
  cleanEnv,
  cftunnelExecutableCandidates,
  cftunnelConfigDir,
  cftunnelInstallDir,
  parseCftunnelVersion,
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
  releaseAssetName,
  parseLatestRelease,
  mirrorDownloadUrl,
  mirrorLabel,
  isUpToDate,
  engineBinaryName,
  engineBinDir,
  parsePinnedFrpVersion,
  frpDownloadUrl,
  cloudflaredDownloadUrl,
  cftunnelLatestDownloadUrl,
  parseHelpCommands,
  featureAvailability,
  parseListOutput,
  parseDiagnoseJson,
  redactSecrets,
} from "./lib/cftunnel-core.js";

const execFileAsync = promisify(execFile);

const VERSION = "0.4.0";

const TIMEOUT = {
  probe: 15_000,
  status: 20_000,
  action: 60_000,
  quick: 20_000,
  logs: 20_000,
  update: 5 * 60_000,
  meta: 20_000,
  download: 10 * 60_000,
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

  /**
   * 盘外文件操作统一走 ResourceIO（宿主授权的正规通道）。
   * 需要 app/resources.read（stat/read）与 app/resources.write（mkdir/copy/delete）。
   * 不以 shell 绕沙箱——安装器要盘外权限就光明正大地申请。
   */
  const refOf = (p) => ({ kind: "local-file", path: p });

  /**
   * 盘外文件是否存在。
   * 实测：sdk.resources.stat 对不存在的路径不一定抛错（可能返回 null/空对象），
   * 所以既看异常也看返回值，不能用 try/catch 一招了事。
   */
  async function pathExists(p) {
    try {
      const st = await sdk.resources.stat(refOf(p));
      if (st == null) return false;
      if (typeof st === "object") {
        // 有的实现返回 { exists } 或 { size }；空对象视为不存在
        if ("exists" in st) return !!st.exists;
        if ("size" in st) return Number.isFinite(st.size);
        if ("kind" in st || "mtimeMs" in st || "isFile" in st) return true;
        for (const k in st) return true; // 有任何字段就当作存在
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // 注意：resources.read 走 RPC，单次上限 32MiB（实测）。搬运大文件一律用 resources.copy。

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
   * 走 ResourceIO 正规删（需 app/resources.write），不用 shell 绕沙箱。
   */
  async function repairStaleLock() {
    const dir = cftunnelConfigDir(process.env, process.platform);
    if (!dir) return false;
    const pidPath = `${dir}/frpc.pid`;
    try {
      await sdk.resources.delete(refOf(pidPath));
      await sdk.logger.info(`修复陈旧启动锁：已清除 ${pidPath}`);
      return true;
    } catch (error) {
      await sdk.logger.warn(`修复陈旧启动锁失败（可能不存在或未授权）：${String(error)}`);
      return false;
    }
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

  /**
   * Cloud 模式配置状态（不存令牌，只回“配了没”与可公开的账户/隧道名）。
   * 令牌本身只在你点击那一下传给 cftunnel，App 不落盘。
   */
  async function cloudState() {
    const env = await readEnvironment();
    return {
      configured: !!env.cloud?.configured,
      running: !!env.cloud?.running,
      tunnelId: env.cloud?.tunnelId ?? null,
      account: config.cloudAccount || "",
      tunnelName: config.cloudTunnelName || "",
      routes: env.cloud?.routes ?? [],
      hasToken: false, // 令牌从不回显；是否已配看 configured
    };
  }

  /**
   * 探测引擎二进制是否存在。
   * ~/.cftunnel/bin 在 dataDir 之外——裸 fs 会被沙箱拒绝（且静默），
   * 故走 ResourceIO.stat，否则会永远误报“缺引擎”。
   */
  async function engineStatus() {
    const plat = process.platform;
    const binDir = engineBinDir(process.env, plat);
    const check = async (kind) => {
      const name = engineBinaryName(kind, plat);
      const p = binDir ? `${binDir}/${name}` : null;
      const exists = p ? await pathExists(p) : false;
      return { kind, name, path: p, exists };
    };
    return { binDir, cloudflared: await check("cloudflared"), frpc: await check("frpc") };
  }

  /**
   * 从 cftunnel 二进制里读它钉死的 frp 版本。
   * 不能用 resources.read 整文件（走 RPC，有 32MiB 上限，要全传且慢）。
   * 改用子进程 grep 前 4MB，足够命中 FRP_VERSION 常量。
   */
  async function pinnedFrpVersion() {
    try {
      const exe = await resolveCf();
      const q = String(exe).replace(/'/g, "''");
      const ps = [
        `$fs=[IO.File]::OpenRead('${q}')`,
        `$n=[Math]::Min(4194304, $fs.Length)`,
        `$buf=New-Object byte[] $n`,
        `$null=$fs.Read($buf,0,$n)`,
        `$fs.Close()`,
        `$t=[Text.Encoding]::ASCII.GetString($buf)`,
        `$m=[regex]::Match($t,'FRP_VERSION="(\d+\.\d+\.\d+)"')`,
        `if($m.Success){Write-Output $m.Groups[1].Value}`,
      ].join("; ");
      const r = await run("powershell.exe", ["-NoProfile", "-Command", ps], { timeoutMs: 60_000 });
      return parsePinnedFrpVersion(`FRP_VERSION="${r.stdout.trim()}"`);
    } catch {
      return null;
    }
  }

  /**
   * 探测本机 cftunnel 实际支持哪些命令（读 --help，不靠版本号）。
   * 缓存：进程生命周期内只探一次（除非重解析可执行文件）。
   */
  let capabilityCache = null;
  async function capabilities() {
    if (capabilityCache) return capabilityCache;
    const r = await cf(["--help"], { timeoutMs: TIMEOUT.probe });
    const commands = r.enoent ? new Set() : parseHelpCommands(r.stdout || r.stderr || "");
    capabilityCache = { commands: [...commands], features: featureAvailability(commands) };
    await sdk.logger.info(`cftunnel 命令探测：${capabilityCache.commands.join(", ") || "（失败）"}`);
    return capabilityCache;
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
      engines: await engineStatus(),
      cloud: await cloudState(),
      install: { installDir: cftunnelInstallDir(process.env, process.platform) },
      capabilities: (await capabilities()).features,
      commands: (await capabilities()).commands,
      job: jobSnapshot(),
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
      argv: redactSecrets([await resolveCf(), ...argv]),
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
    // diagnose --json（Cloud 模式链路诊断）
    if (action === "diagnose" && result.ok) {
      out.cloudDiagnosis = parseDiagnoseJson(result.stdout);
    }
    // list（官方：列出所有路由和规则，分节）
    if (action === "list" && result.ok) {
      const parsed = parseListOutput(result.stdout);
      out.cloudRoutes = parsed.cloudRoutes;
      out.relayRules = parsed.relayRules;
    }
    if (action === "relayList" && result.ok) {
      out.routes = parseRouteTable(result.stdout);
    }
    return out;
  }

  // ---------------------------------------------------------------- 安装作业
  //
  // 三层结构要分清：
  //   ① 管家 cftunnel      —— 本体，本 App 负责下载/解压/放好/改 PATH
  //   ② 引擎 cloudflared/frpc —— 它自己会下，但国内常下不动；本 App 提供预装/修复
  //   ③ 服务端 frps         —— 在你自己的服务器上，另一条独立链路（待做）
  //
  // 子进程（curl/tar/powershell）不受 App 沙箱的写限制约束，所以下载解压放盘都走它们；
  // 这也正是“安装器”本该有的能力，不是绕过安全边界。

  let job = makeJob();
  let jobPromise = null;

  function makeJob() {
    return { running: false, action: null, phase: "", percent: null, log: "", error: null, done: false, result: null, startedAt: null };
  }
  const pushLog = (line) => {
    const clean = String(line).replace(/\r/g, "").trimEnd();
    if (clean) job.log = `${job.log ? `${job.log}\n` : ""}${clean}`.slice(-LOG_KEEP);
  };
  const jobSnapshot = () => ({
    running: job.running, action: job.action, phase: job.phase, percent: job.percent,
    log: job.log, error: job.error, done: job.done, result: job.result,
  });

  /** 带进度回调的下载（curl，按镜像依次回退）。返回 { ok, path, mirror, error }。 */
  function curlDownload(url, dest, { timeoutMs = TIMEOUT.download } = {}) {
    return new Promise((resolve) => {
      const child = spawn(
        "curl.exe",
        [
          "-L", "--fail", "--silent", "--show-error", "-o", dest,
          "--connect-timeout", "12",
          "--max-time", String(Math.round(timeoutMs / 1000)),
          "--speed-time", "25", "--speed-limit", "4096",
          url,
        ],
        { shell: false, stdio: ["ignore", "ignore", "pipe"], env: cleanEnv() },
      );
      let err = "";
      child.stderr.on("data", (b) => { err = (err + String(b)).slice(-500); });
      // 硬性墙：即使 curl 因某些原因不退出，也强制结束，让上层进入下一镜像
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs + 5_000);
      child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e?.message || e) }); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true, path: dest });
        else if (code === null) resolve({ ok: false, error: "下载超时被终止" });
        else resolve({ ok: false, error: err.trim() || `curl 退出码 ${code}` });
      });
    });
  }

  /** 依次试镜像下载，成功即停。每个源都有独立时限，不会卡死在一个源上。 */
  async function downloadWithMirrors(url, dest, label) {
    let lastErr = null;
    for (const mirror of CFTUNNEL_MIRRORS) {
      const full = mirrorDownloadUrl(url, mirror);
      pushLog(`→ 尝试下载（${mirrorLabel(mirror)}）：${full}`);
      const r = await curlDownload(full, dest, { timeoutMs: 90_000 });
      if (r.ok) { pushLog(`✓ 下载完成（${mirrorLabel(mirror)}）`); return { ok: true, mirror, path: dest }; }
      lastErr = r.error;
      pushLog(`✗ ${mirrorLabel(mirror)} 失败：${r.error}`);
    }
    return { ok: false, error: `${label || "下载"}全部源失败：${lastErr || "未知"}` };
  }

  /** 解压（bsdtar 两边都能解：zip / tar.gz）。 */
  async function extract(archive, destDir) {
    const r = await run("tar", ["-xf", archive, "-C", destDir], { timeoutMs: 120_000 });
    if (!r.ok) return { ok: false, error: `解压失败：${r.stderr || r.message || describe(r)}` };
    return { ok: true };
  }

  /** 在目录里递归找可执行文件（避开目录层级差异）。 */
  function findBinary(dir, name) {
    const target = name.toLowerCase();
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.toLowerCase() === target) return p;
      }
    }
    return null;
  }

  /** 装 cftunnel 本体：下载 → 解压 → 放到安装目录 → 加 PATH。 */
  async function installCftunnel() {
    const plat = process.platform;
    const arch = process.arch;
    const asset = releaseAssetName(plat, arch);
    if (!asset) throw new Error(`不支持当前平台：${plat}/${arch}`);
    const installDir = cftunnelInstallDir(process.env, plat);
    if (!installDir) throw new Error("无法确定安装目录（缺少 LOCALAPPDATA / HOME）");

    const workDir = path.join(dataDir, "install");
    fs.mkdirSync(workDir, { recursive: true });
    const archivePath = path.join(workDir, asset);
    const extractDir = path.join(workDir, "x");
    fs.mkdirSync(extractDir, { recursive: true });

    job.phase = "下载 cftunnel";
    const url = cftunnelLatestDownloadUrl(plat, arch);
    const dl = await downloadWithMirrors(url, archivePath, "cftunnel 本体");
    if (!dl.ok) throw new Error(dl.error);

    job.phase = "解压";
    const ex = await extract(archivePath, extractDir);
    if (!ex.ok) throw new Error(ex.error);

    const exeName = plat === "win32" ? "cftunnel.exe" : "cftunnel";
    const found = findBinary(extractDir, exeName);
    if (!found) throw new Error("包里没找到 cftunnel 可执行文件");

    job.phase = "安装到 " + installDir;
    // 写盘走 ResourceIO（需 app/resources.write）——这是宿主授权的正规通道
    try { await sdk.resources.mkdir(refOf(installDir)); } catch { /* 已存在 */ }
    await sdk.resources.copy(refOf(found), refOf(`${installDir}/${exeName}`));

    // 加 PATH（仅 Windows 需要；健壮处理已有/无 PATH）
    if (plat === "win32") {
      job.phase = "写入 PATH";
      const psPath = [
        `$d='${installDir.replace(/'/g, "''")}'`,
        `$u=[Environment]::GetEnvironmentVariable('Path','User')`,
        `if ($u -notlike "*$d*") { [Environment]::SetEnvironmentVariable('Path', (($u.TrimEnd(';')) + ';' + $d), 'User'); Write-Output 'PATH_ADDED' } else { Write-Output 'PATH_EXISTS' }`,
      ].join("; ");
      const rp = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psPath], { timeoutMs: 30_000 });
      pushLog(rp.ok ? `PATH：${rp.stdout.trim()}` : `PATH 写入失败（不致命）：${rp.stderr || rp.message}`);
    }

    // 重解析路径并验版本
    cfPath = null; cfPathPending = null;
    job.phase = "验证";
    const v = await cf(["version"], { timeoutMs: TIMEOUT.probe });
    if (v.enoent) throw new Error("安装后仍找不到 cftunnel（PATH 未生效，可重开 Hana 或手动指定路径）");
    const ver = parseCftunnelVersion(v.stdout);
    pushLog(`✓ 已安装 cftunnel ${ver || ""} → ${await resolveCf()}`);
    try { fs.unlinkSync(archivePath); } catch { /* 清理失败不影响结果 */ }
    return { version: ver, path: await resolveCf(), installDir };
  }

  /** 卸载 cftunnel 本体：删安装目录 + 清 PATH。不动配置（~/.cftunnel）。 */
  async function uninstallCftunnel() {
    const plat = process.platform;
    const installDir = cftunnelInstallDir(process.env, plat);
    if (!installDir) throw new Error("无法确定安装目录");
    job.phase = "删除安装目录";
    const exePath = `${installDir}/${plat === "win32" ? "cftunnel.exe" : "cftunnel"}`;
    let removed = false;
    try { await sdk.resources.delete(refOf(exePath)); removed = true; } catch (e) { pushLog(`删除可执行文件失败：${String(e)}`); }
    pushLog(removed ? `已删除 ${exePath}` : "可执行文件未找到或删除失败");
    // 目录若已空则一起清掉（失败不致命）
    try { await sdk.resources.delete(refOf(installDir)); pushLog("安装目录已清理"); } catch { /* 目录非空或无权，忽略 */ }

    if (plat === "win32") {
      job.phase = "清理 PATH";
      const psPath = [
        `$d='${installDir.replace(/'/g, "''")}'`,
        `$u=[Environment]::GetEnvironmentVariable('Path','User')`,
        `if ($u) { $parts = $u -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $d.TrimEnd('\\')) }; [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User') }`,
        `Write-Output 'PATH_CLEANED'`,
      ].join("; ");
      const rp = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psPath], { timeoutMs: 30_000 });
      pushLog(rp.ok ? "PATH 已清理" : `PATH 清理失败（不致命）：${rp.stderr || rp.message}`);
    }
    cfPath = null; cfPathPending = null;
    pushLog("✓ 已卸载（配置 ~/.cftunnel 保留，如需彻底清除请手动删除）");
    return { installDir };
  }

  /** 预装/修复引擎（cloudflared + frpc）。这是“卡在正在下载 frpc”那个问题的药。 */
  async function repairEngines() {
    const plat = process.platform;
    const arch = process.arch;
    const binDir = engineBinDir(process.env, plat);
    if (!binDir) throw new Error("无法确定引擎目录");
    const workDir = path.join(dataDir, "install");
    fs.mkdirSync(workDir, { recursive: true });
    try { await sdk.resources.mkdir(refOf(binDir)); } catch { /* 已存在 */ }
    const results = [];

    // 1) frpc：版本必须跟 cftunnel 钉死的对齐
    job.phase = "准备 frpc";
    const frpcName = engineBinaryName("frpc", plat);
    const frpcDest = `${binDir}/${frpcName}`;
    if (await pathExists(frpcDest)) {
      results.push({ engine: "frpc", status: "已存在", path: frpcDest });
      pushLog(`frpc：已存在，跳过（${frpcDest}）`);
    } else {
      const pinned = await pinnedFrpVersion();
      const version = pinned || "0.66.0";
      pushLog(`frpc：目标版本 ${version}${pinned ? "（取自 cftunnel 内置）" : "（默认值）"}`);
      const url = frpDownloadUrl(version, plat, arch);
      if (!url) throw new Error(`不支持当前平台：${plat}/${arch}`);
      const archive = path.join(workDir, `frp_${version}.zip`);
      const dl = await downloadWithMirrors(url, archive, "frp 引擎");
      if (!dl.ok) { results.push({ engine: "frpc", status: "下载失败", error: dl.error }); throw new Error(dl.error); }
      job.phase = "解压 frpc";
      const exDir = path.join(workDir, `frp_${version}`);
      fs.mkdirSync(exDir, { recursive: true });
      const ex = await extract(archive, exDir);
      if (!ex.ok) throw new Error(ex.error);
      const found = findBinary(exDir, frpcName);
      if (!found) throw new Error("frp 包里没找到 frpc");
      job.phase = "放置 frpc";
      await sdk.resources.copy(refOf(found), refOf(frpcDest));
      pushLog(`✓ frpc ${version} → ${frpcDest}`);
      results.push({ engine: "frpc", status: "已安装", version, path: frpcDest });
      try { fs.unlinkSync(archive); } catch { /* ignore */ }
    }

    // 2) cloudflared（仅 Cloud 模式需要，失败不阻断 Relay）
    job.phase = "准备 cloudflared";
    const cdName = engineBinaryName("cloudflared", plat);
    const cdDest = `${binDir}/${cdName}`;
    if (await pathExists(cdDest)) {
      results.push({ engine: "cloudflared", status: "已存在", path: cdDest });
      pushLog(`cloudflared：已存在，跳过`);
    } else {
      const url = cloudflaredDownloadUrl(plat, arch);
      const dl = await downloadWithMirrors(url, path.join(workDir, cdName), "cloudflared");
      if (dl.ok) {
        job.phase = "放置 cloudflared";
        await sdk.resources.copy(refOf(path.join(workDir, cdName)), refOf(cdDest));
        pushLog(`✓ cloudflared → ${cdDest}`);
        results.push({ engine: "cloudflared", status: "已安装", path: cdDest });
      } else {
        pushLog(`✗ cloudflared 下载失败（不影响 Relay 模式）：${dl.error}`);
        results.push({ engine: "cloudflared", status: "下载失败", error: dl.error });
      }
    }
    return { binDir, results };
  }

  /** 开一个安装作业（同一时刻只允许一个）。 */
  function startJob(action) {
    if (jobPromise) return false;
    job = makeJob();
    job.running = true; job.action = action; job.startedAt = Date.now();
    jobPromise = (async () => {
      try {
        if (action === "installSelf" || action === "updateSelf" || action === "reinstallSelf") {
          if (action === "reinstallSelf") { pushLog("重装：先卸载再安装"); try { await uninstallCftunnel(); } catch (e) { pushLog(`卸载步骤跳过：${String(e)}`); } }
          job.result = await installCftunnel();
        } else if (action === "uninstallSelf") {
          job.result = await uninstallCftunnel();
        } else if (action === "repairEngine") {
          job.result = await repairEngines();
        } else {
          throw new Error(`未知作业：${action}`);
        }
        job.done = true;
        pushLog("―― 完成 ――");
        await sdk.notifications.show({ title: "远程访问", body: `${ACTION_LABELS[action] || action}已完成。` }).catch(() => {});
      } catch (error) {
        job.error = String(error?.message || error);
        pushLog(`✗ 失败：${job.error}`);
        await sdk.notifications.show({ title: "远程访问", body: `${ACTION_LABELS[action] || action}失败：${job.error}` }).catch(() => {});
      } finally {
        job.running = false;
        job.phase = job.error ? "失败" : "完成";
        jobPromise = null;
      }
    })();
    return true;
  }

  /**
   * 拿 GitHub latest 的版本信息（用于「检查更新」）。
   * 注意：本项目版本号会回退（0.8.1 在 3 月，0.4.4 在 9 月），
   * 所以只能用 tag 对比是否相等，绝不能比大小。
   */
  async function checkLatest() {
    const local = (await readEnvironment()).version;
    let latest = null;
    let error = null;
    // 优先 curl 走镜像（GitHub API 在部分网络下不可达）
    for (const mirror of CFTUNNEL_MIRRORS) {
      const url = mirrorDownloadUrl(LATEST_RELEASE_API, mirror);
      const r = await run("curl.exe", ["-sL", "--max-time", "20", "-H", "Accept: application/vnd.github+json", url], { timeoutMs: TIMEOUT.meta });
      if (r.ok && r.stdout && r.stdout.trim().startsWith("{")) {
        const parsed = parseLatestRelease(r.stdout);
        if (parsed.ok) { latest = parsed; break; }
      }
    }
    if (!latest) error = "未能获取最新版本（GitHub API 不可达或限流）";
    return {
      ok: !!latest,
      local,
      latest: latest ? { tag: latest.tag, version: latest.version, publishedAt: latest.publishedAt } : null,
      upToDate: latest ? isUpToDate(local, latest.version) : null,
      error,
    };
  }

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

  await sdk.tools.register({
    name: "remote_access_install",
    description:
      "安装 / 更新 / 重装 / 卸载内网穿透工具 cftunnel 本体，或预装修复它的引擎（cloudflared / frpc）。action：install（安装，已装则报已装）、update（更新到最新）、reinstall（重装）、uninstall（卸载本体）、repairEngine（预装/修复引擎，解决“卡在正在下载 frpc”）。下载会自动试镜像，耗时可能几分钟。卸载与重装会先向用户确认。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["install", "update", "reinstall", "uninstall", "repairEngine"] },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const map = { install: "installSelf", update: "updateSelf", reinstall: "reinstallSelf", uninstall: "uninstallSelf", repairEngine: "repairEngine" };
      const action = map[args?.action];
      if (!action) return fail("未知操作。可选：install / update / reinstall / uninstall / repairEngine。");
      if (!startJob(action)) return fail("已有一个安装作业在进行中，请等它完成。");
      const label = ACTION_LABELS[action] || action;
      return text(`${label}已开始，在后台进行（可能几分钟）。可调用 remote_access_status 查看进度，或在面板中查看实时日志。`);
    },
  });

  await sdk.tools.register({
    name: "remote_access_check_update",
    description:
      "检查 cftunnel 是否有新版本。返回本机版本与 GitHub 上的最新版本。注意：本项目版本号会回退（如 v0.8.1 早于 v0.4.4），因此只比对标签是否相等，不比大小。无需参数。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const r = await checkLatest();
      if (!r.ok) return text(`本机 cftunnel：${r.local || "未安装"}\n检查失败：${r.error}`);
      return text(
        [
          `本机：v${r.local || "未知"}`,
          `最新：${r.latest.tag}（${String(r.latest.publishedAt || "").slice(0, 10)}）`,
          r.upToDate ? "状态：已是最新" : "状态：有新版本可更新（面板点「更新」）",
        ].join("\n"),
      );
    },
  });

  await sdk.tools.register({
    name: "remote_access_extra",
    description:
      "执行一条 cftunnel 命令扩展动作。支持：share（分享已有公网地址）、presetList（列出场景模板）、presetRun（按模板启动）、history（查看端口记录）、historyClear（清空记录）。参数以对象传递。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["share", "presetList", "presetRun", "history", "historyClear"] },
        address: { type: "string", description: "share 用：要分享的公网地址" },
        name: { type: "string", description: "presetRun 用：模板名称" },
        qr: { type: "boolean", description: "是否附带终端二维码" },
        share: { type: "boolean", description: "presetRun 用：是否附带分享信息" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const allowed = ["share", "presetList", "presetRun", "history", "historyClear"];
      const action = allowed.includes(args?.action) ? args.action : null;
      if (!action) return fail(`未知操作。可选：${allowed.join(" / ")}。`);
      const caps = (await capabilities()).features;
      const need = { share: "share", presetList: "preset", presetRun: "preset", history: "history", historyClear: "history" }[action];
      if (caps.known && need && !caps[need]) {
        return fail(`本机 cftunnel 不支持 ${need}（需升级到较新版本）。可用 remote_access_install 的 update 动作升级。`);
      }
      const res = await perform(action, { address: args?.address, name: args?.name, qr: !!args?.qr, share: !!args?.share });
      if (!res.ok) return fail(`${ACTION_LABELS[action] || action}失败（${res.error}）。`, res.stderr || "");
      return text(`${ACTION_LABELS[action] || action}完成。\n${res.stdout || ""}`.trim());
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

    app.get("/applog", (c) => c.json({ ok: true, log: job.log }));

    // 安装板块：检查更新 / 最新版信息
    app.get("/latest", async (c) => c.json(await checkLatest()));

    // 安装板块：作业快照
    app.get("/job", (c) => c.json({ ok: true, job: jobSnapshot() }));

    // 安装板块：启动作业
    app.post("/job", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const map = { install: "installSelf", update: "updateSelf", reinstall: "reinstallSelf", uninstall: "uninstallSelf", repairEngine: "repairEngine" };
      const action = map[body?.action];
      if (!action) return c.json({ ok: false, error: "未知操作" }, 400);
      const started = startJob(action);
      return c.json({ ok: true, started, action, message: started ? undefined : "已有作业在进行中" });
    });
  });

  // ---------------------------------------------------------------- 启动

  await loadConfig();
  await sdk.logger.info(`配置：mode=${config.mode} port=${config.localPort ?? "自动"} autoStart=${config.autoStart}`);
  // 延迟自启动，不阻塞 App 加载
  scheduleAutoStart().catch((error) => sdk.logger.warn(`自启动调度失败：${String(error)}`));
});
