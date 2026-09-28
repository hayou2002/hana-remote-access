// 远程访问管理面板：状态 / 启停 / 临时分享 / 路由 / 诊断 / 自启动。
// 数据面：hana.api.fetch → /api/apps/remote-access/routes/*
// 渲染模型：单一 state + 单一 render()，所有 UI 变化都经它落地。
// 注意：面板跑在 iframe 里 —— window.confirm/alert 被沙箱禁止，确认改由页内确认条完成。
import { hana } from "./sdk.js";

const ROUTE = {
  status: "/status",
  action: "/action",
  config: "/config",
  logs: "/logs",
  detect: "/detect",
};
const POLL_MS = 5000;
const LOG_TAIL_CHARS = 4000;

const el = (id) => document.getElementById(id);

const ui = {
  dot: el("health-dot"),
  healthText: el("health-text"),
  appVersion: el("app-version"),
  refresh: el("refresh"),
  missing: el("sec-missing"),
  openReleases: el("open-releases"),
  openDocs: el("open-docs"),
  statusBadge: el("status-badge"),
  modeLabel: el("mode-label"),
  statusKv: el("status-kv"),
  up: el("btn-up"),
  down: el("btn-down"),
  open: el("btn-open"),
  copy: el("btn-copy"),
  quickPort: el("quick-port"),
  quick: el("btn-quick"),
  quickResult: el("quick-result"),
  quickUrl: el("quick-url"),
  quickCopy: el("quick-copy"),
  routesList: el("routes-list"),
  routeName: el("route-name"),
  routeLocal: el("route-local"),
  routeRemote: el("route-remote"),
  addRoute: el("btn-add-route"),
  check: el("btn-check"),
  logs: el("btn-logs"),
  diagOut: el("diag-out"),
  autoStart: el("auto-start"),
  svcInstall: el("btn-svc-install"),
  svcUninstall: el("btn-svc-uninstall"),
  settings: el("btn-settings"),
  update: el("btn-update"),
  updated: el("updated"),
  runLog: el("run-log"),
  confirmBar: el("confirm-bar"),
  confirmText: el("confirm-text"),
  confirmOk: el("confirm-ok"),
  confirmCancel: el("confirm-cancel"),
};

let state = { status: null, busy: false, quickUrl: null, diag: null, log: "" };
let confirmRequest = null; // { message, onOk } | null
let pollTimer = null;

// ---------------------------------------------------------------- 基础件

async function api(path, init) {
  const res = await hana.api.fetch(path, init);
  const raw = await res.text();
  try {
    return { status: res.status, data: raw ? JSON.parse(raw) : null };
  } catch {
    return { status: res.status, data: null, raw };
  }
}

const setLog = (msg) => {
  if (!msg) return;
  state.log = `${state.log ? `${state.log}\n` : ""}${msg}`.slice(-LOG_TAIL_CHARS);
  renderLog();
};

const renderLog = () => {
  ui.runLog.textContent = state.log;
  ui.runLog.classList.toggle("hidden", !state.log);
};

function askConfirm(message, onOk) {
  confirmRequest = { message, onOk };
  render();
}
function closeConfirm() {
  confirmRequest = null;
  render();
}

// ---------------------------------------------------------------- 数据

async function loadStatus() {
  const { data } = await api(ROUTE.status);
  if (data) state.status = data;
  render();
}

async function loadDetect() {
  // 优先：面板跑在 Hana 的 iframe 里，location.port 就是 Hana 端口（最通用，不依赖后端读文件）。
  const fromFrame = Number.parseInt(location.port, 10);
  let port = Number.isFinite(fromFrame) ? fromFrame : null;
  if (!port) {
    try {
      const { data } = await api(ROUTE.detect);
      if (data?.hanaPort) port = data.hanaPort;
    } catch {}
  }
  if (port && !ui.quickPort.value) ui.quickPort.value = String(port);
  state.hanaPort = port;
}

async function runAction(action, params = {}, { confirmMsg } = {}) {
  if (state.busy) return;
  const go = async () => {
    state.busy = true;
    render();
    try {
      const { data } = await api(ROUTE.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, params }),
      });
      if (data?.stdout) setLog(`$ ${data.argv || ""}\n${data.stdout}`.trim());
      if (data?.stderr) setLog(data.stderr);
      if (data && !data.ok) setLog(`✗ ${data.error || "操作失败"}`);
      if (data?.publicUrl) {
        state.quickUrl = data.publicUrl;
        state.diag = null;
      }
      if (data?.diagnosis) state.diag = data.diagnosis;
      if (data?.routes) state.routes = data.routes;
    } catch (error) {
      setLog(`✗ 请求失败：${String(error)}`);
    } finally {
      state.busy = false;
      await loadStatus();
    }
  };
  if (confirmMsg) askConfirm(confirmMsg, go);
  else await go();
}

// ---------------------------------------------------------------- 渲染

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function render() {
  const s = state.status;
  const installed = !!s?.cftunnel?.installed;

  // 顶栏健康
  if (!s) {
    ui.dot.dataset.state = "unknown";
    ui.healthText.textContent = "正在检查…";
  } else if (!installed) {
    ui.dot.dataset.state = "bad";
    ui.healthText.textContent = "未安装 cftunnel";
  } else if (s.active?.running) {
    ui.dot.dataset.state = "good";
    ui.healthText.textContent = "隧道运行中";
  } else {
    ui.dot.dataset.state = "idle";
    ui.healthText.textContent = "隧道已停止";
  }
  ui.appVersion.textContent = s ? `v${s.appVersion}` : "v—";

  ui.missing.classList.toggle("hidden", !s || installed);

  // 状态总览
  const running = !!s?.active?.running;
  ui.statusBadge.textContent = running ? "运行中" : "已停止";
  ui.statusBadge.className = `badge ${running ? "badge--good" : "badge--idle"}`;
  ui.modeLabel.textContent = s ? (s.mode === "relay" ? "Relay 模式（自建中继）" : "Cloud 模式（Cloudflare）") : "";

  const kv = [];
  if (s) {
    kv.push(["cftunnel", s.cftunnel.installed ? `v${s.cftunnel.version || "未知"}` : "未安装"]);
    kv.push(["本地端口", s.ports.effective != null ? String(s.ports.effective) : "未确定" + (s.ports.hana ? `（Hana 探测 ${s.ports.hana}）` : "")]);
    if (s.mode === "relay" && s.active?.server) kv.push(["中继服务器", s.active.server]);
    if (s.publicAddress) kv.push(["公网地址", s.publicAddress]);
  }
  ui.statusKv.innerHTML = kv
    .map(([k, v]) => `<div class="kv__k">${escapeHtml(k)}</div><div class="kv__v">${escapeHtml(v)}</div>`)
    .join("");

  ui.up.disabled = state.busy || !installed || running;
  ui.down.disabled = state.busy || !installed || !running;
  ui.open.disabled = !s?.publicAddress;
  ui.copy.disabled = !s?.publicAddress;

  // 路由列表
  const rules = s?.mode === "relay" ? s?.relay?.rules || [] : s?.cloud?.routes || [];
  if (!rules.length) {
    ui.routesList.innerHTML = `<p class="muted">暂无路由。${installed ? "在下方添加一条。" : ""}</p>`;
  } else {
    ui.routesList.innerHTML = rules
      .map((r) => {
        const name = r.name || r.id || "(未命名)";
        const ports = r.localPort != null ? `${r.localPort} → ${r.remotePort ?? r.localPort}` : "";
        const dom = r.domain ? `<span class="route__dom">${escapeHtml(r.domain)}</span>` : "";
        return `<div class="route">
          <span class="route__name">${escapeHtml(name)}</span>
          <span class="route__meta">${escapeHtml(r.proto || "tcp")} ${escapeHtml(ports)}</span>
          ${dom}
          <button class="btn btn--danger-outline btn--xs" data-remove="${escapeHtml(name)}" type="button">删除</button>
        </div>`;
      })
      .join("");
    for (const btn of ui.routesList.querySelectorAll("[data-remove]")) {
      btn.addEventListener("click", () => {
        const name = btn.getAttribute("data-remove");
        runAction("relayRemove", { name }, { confirmMsg: `确定删除路由「${name}」？删除后该端口的公网访问会立即失效。` });
      });
    }
  }

  // 临时分享
  ui.quickResult.classList.toggle("hidden", !state.quickUrl);
  if (state.quickUrl) ui.quickUrl.textContent = state.quickUrl;

  // 诊断输出
  if (state.diag) {
    const d = state.diag;
    const lines = [`服务器 ${d.server}（${d.serverOk ? "通" : "不通"}${d.serverLatencyMs != null ? `，${d.serverLatencyMs}ms` : ""}）`];
    lines.push(`frpc：${d.frpcRunning ? "运行中" : "未运行"}`);
    for (const r of d.rules || []) {
      lines.push(`${r.name} ${r.proto} ${r.localPort}→${r.remotePort}｜本地${r.localOk ? "✓" : "✗"} 远程${r.remoteOk ? "✓" : "✗"}${r.error ? `（${r.error}）` : ""}`);
    }
    ui.diagOut.textContent = lines.join("\n");
    ui.diagOut.classList.remove("hidden");
  }

  // 自启动开关
  if (s) ui.autoStart.checked = !!s.config?.autoStart;

  // 确认条
  ui.confirmBar.classList.toggle("hidden", !confirmRequest);
  if (confirmRequest) ui.confirmText.textContent = confirmRequest.message;

  // busy 提示
  document.getElementById("panel").setAttribute("aria-busy", String(state.busy));
}

// ---------------------------------------------------------------- 事件

ui.refresh.addEventListener("click", () => {
  loadStatus();
  setLog("已刷新状态。");
});

ui.openReleases.addEventListener("click", () => hana.external.open({ url: state.status?.cftunnel?.releases || "https://github.com/qingchencloud/cftunnel/releases/latest" }));
ui.openDocs.addEventListener("click", () => hana.external.open({ url: state.status?.cftunnel?.docs || "https://qingchencloud.github.io/cftunnel/" }));

ui.up.addEventListener("click", () => runAction("up", {}));
ui.down.addEventListener("click", () => runAction("down", {}));

ui.copy.addEventListener("click", async () => {
  const url = state.status?.publicAddress;
  if (!url) return;
  try {
    await hana.clipboard.writeText({ text: url });
    setLog(`已复制：${url}`);
  } catch (error) {
    setLog(`复制失败：${String(error)}`);
  }
});

ui.open.addEventListener("click", () => {
  const url = state.status?.publicAddress;
  if (url) hana.external.open({ url });
});

ui.quick.addEventListener("click", () => {
  const port = Number.parseInt(ui.quickPort.value, 10);
  if (!Number.isFinite(port)) {
    setLog("请先填写端口。");
    return;
  }
  runAction("quick", { port });
});

ui.quickCopy.addEventListener("click", async () => {
  if (!state.quickUrl) return;
  try {
    await hana.clipboard.writeText({ text: state.quickUrl });
    setLog(`已复制：${state.quickUrl}`);
  } catch (error) {
    setLog(`复制失败：${String(error)}`);
  }
});

ui.addRoute.addEventListener("click", () => {
  const name = ui.routeName.value.trim();
  const local = Number.parseInt(ui.routeLocal.value, 10);
  const remote = Number.parseInt(ui.routeRemote.value, 10);
  if (!name) return setLog("请填写路由名称。");
  if (!Number.isFinite(local)) return setLog("请填写本地端口。");
  runAction("relayAdd", { name, port: local, remotePort: Number.isFinite(remote) ? remote : undefined });
});

ui.check.addEventListener("click", () => runAction("check", {}));

ui.logs.addEventListener("click", async () => {
  const { data } = await api(ROUTE.logs);
  if (data?.logs) {
    state.diag = null;
    ui.diagOut.textContent = data.logs;
    ui.diagOut.classList.remove("hidden");
  } else {
    setLog(data?.error || "暂无日志。");
  }
});

ui.autoStart.addEventListener("change", async () => {
  const autoStart = ui.autoStart.checked;
  const { data } = await api(ROUTE.config, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: { autoStart } }),
  });
  if (data?.ok) setLog(`已${autoStart ? "开启" : "关闭"}随 Hana 自启动。`);
  await loadStatus();
});

ui.svcInstall.addEventListener("click", () =>
  runAction("installService", {}, { confirmMsg: "注册系统服务会让隧道在 Hana 未运行时也保持在线，可能需要管理员权限。继续？" }),
);
ui.svcUninstall.addEventListener("click", () =>
  runAction("uninstallService", {}, { confirmMsg: "取消系统服务后，Hana 未运行时隧道将不再保持在线。继续？" }),
);

ui.settings.addEventListener("click", () => {
  // 面板 iframe 没有直接打开宿主设置页的 API；给出明确引导，避免静默无反应。
  setLog("请从 Hana「设置 → 应用 → 远程访问」打开设置页（本面板无法自行跳转）。");
});

ui.update.addEventListener("click", () => runAction("checkUpdate", {}));

ui.confirmOk.addEventListener("click", async () => {
  const req = confirmRequest;
  closeConfirm();
  if (req) await req.onOk();
});
ui.confirmCancel.addEventListener("click", closeConfirm);

// ---------------------------------------------------------------- 轮询

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    if (!state.busy) loadStatus();
  }, POLL_MS);
}
function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---------------------------------------------------------------- 启动

(async function boot() {
  await hana.ready();
  await loadStatus();
  await loadDetect();
  startPoll();
  window.addEventListener("beforeunload", stopPoll);
})();
