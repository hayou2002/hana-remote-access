// 远程访问管理面板：标签分页（总览 / 隧道 / 分享 / 安装 / 诊断）。
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
  latest: "/latest",
  job: "/job",
};
const POLL_MS = 5000;
const LOG_TAIL_CHARS = 4000;

const el = (id) => document.getElementById(id);

const ui = {
  dot: el("health-dot"), healthText: el("health-text"), appVersion: el("app-version"), refresh: el("refresh"),
  missing: el("sec-missing"), missingInstall: el("btn-missing-install"), openReleases: el("open-releases"), openDocs: el("open-docs"),
  tabs: el("tabs"),
  // 总览
  statusBadge: el("status-badge"), modeLabel: el("mode-label"), statusKv: el("status-kv"),
  up: el("btn-up"), down: el("btn-down"), open: el("btn-open"), copy: el("btn-copy"), share: el("btn-share"),
  overviewHint: el("overview-hint"),
  // 隧道
  modes: el("modes"), modeHint: el("mode-hint"),
  secRelay: el("sec-relay"), server: el("server"), token: el("token"), relayInit: el("btn-relay-init"), relayState: el("relay-state"),
  secCloud: el("sec-cloud"), cloudToken: el("cloud-token"), cloudAccount: el("cloud-account"), cloudInit: el("btn-cloud-init"),
  cloudTunnel: el("cloud-tunnel"), cloudCreate: el("btn-cloud-create"), cloudState: el("cloud-state"),
  routesMode: el("routes-mode"), routesList: el("routes-list"),
  relayRuleForm: el("relay-rule-form"), routeName: el("route-name"), routeLocal: el("route-local"), routeRemote: el("route-remote"), routeProto: el("route-proto"), addRule: el("btn-add-rule"),
  cloudRouteForm: el("cloud-route-form"), cloudRouteName: el("cloud-route-name"), cloudRoutePort: el("cloud-route-port"), cloudRouteDomain: el("cloud-route-domain"), cloudAddRoute: el("btn-cloud-add-route"),
  svcInstall: el("btn-svc-install"), svcUninstall: el("btn-svc-uninstall"), autoStart: el("auto-start"), autoHeal: el("auto-heal"),
  destroy: el("btn-destroy"), reset: el("btn-reset"),
  // 分享
  quickPort: el("quick-port"), quickRelay: el("quick-relay"), quickProto: el("quick-proto"), quickProtoWrap: el("quick-proto-wrap"),
  quickQr: el("quick-qr"), quickTelegram: el("quick-telegram"), quickShare: el("quick-share"), quick: el("btn-quick"),
  quickVerNote: el("quick-ver-note"), quickResult: el("quick-result"), quickUrl: el("quick-url"), quickCopy: el("quick-copy"),
  presetSelect: el("preset-select"), presetRefresh: el("btn-preset-refresh"), presetRun: el("btn-preset-run"),
  history: el("btn-history"), historyClear: el("btn-history-clear"),
  // 安装
  installBadge: el("install-badge"), dotCf: el("dot-cf"), cfMeta: el("cf-meta"), cfLatest: el("cf-latest"),
  cfInstall: el("btn-cf-install"), cfUpdate: el("btn-cf-update"), cfReinstall: el("btn-cf-reinstall"), cfUninstall: el("btn-cf-uninstall"),
  dotEngine: el("dot-engine"), engineMeta: el("engine-meta"), engineRepair: el("btn-engine-repair"),
  jobBox: el("job-box"), jobLabel: el("job-label"), jobPhase: el("job-phase"), jobFill: el("job-fill"), jobLog: el("job-log"),
  // 诊断
  check: el("btn-check"), diagnose: el("btn-diagnose"), logs: el("btn-logs"), diagOut: el("diag-out"), diagHint: el("diag-hint"),
  // 通用
  updated: el("updated"), runLog: el("run-log"),
  confirmBar: el("confirm-bar"), confirmText: el("confirm-text"), confirmOk: el("confirm-ok"), confirmCancel: el("confirm-cancel"),
};

let state = { status: null, busy: false, quickUrl: null, diag: null, log: "", latest: null, job: null, tab: "overview" };
let confirmRequest = null;
let pollTimer = null;
let jobTimer = null;

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
const apiPost = (path, body) =>
  api(path, {
    method: "POST",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

const setLog = (msg) => {
  if (!msg) return;
  state.log = `${state.log ? `${state.log}\n` : ""}${msg}`.slice(-LOG_TAIL_CHARS);
  renderLog();
};
const renderLog = () => {
  ui.runLog.textContent = state.log;
  ui.runLog.classList.toggle("hidden", !state.log);
};
function askConfirm(message, onOk) { confirmRequest = { message, onOk }; render(); }
function closeConfirm() { confirmRequest = null; render(); }
function showDiag(text) { ui.diagOut.textContent = text; ui.diagOut.classList.remove("hidden"); }

// ---------------------------------------------------------------- 数据

async function loadStatus() {
  const { data } = await api(ROUTE.status);
  if (data) state.status = data;
  render();
}
async function loadDetect() {
  const fromFrame = Number.parseInt(location.port, 10);
  let port = Number.isFinite(fromFrame) ? fromFrame : null;
  if (!port) {
    try { const { data } = await api(ROUTE.detect); if (data?.hanaPort) port = data.hanaPort; } catch {}
  }
  if (port && !ui.quickPort.value) ui.quickPort.value = String(port);
  state.hanaPort = port;
}
async function loadLatest() {
  const { data } = await api(ROUTE.latest);
  if (data) state.latest = data;
  renderInstall(state.status);
}
async function loadJob() {
  const { data } = await api(ROUTE.job);
  if (data?.job) state.job = data.job;
  renderInstall(state.status);
  if (state.job?.running) { if (!jobTimer) jobTimer = setInterval(loadJob, 1200); }
  else if (jobTimer) { clearInterval(jobTimer); jobTimer = null; await loadStatus(); }
}

async function runAction(action, params = {}, { confirmMsg } = {}) {
  if (state.busy) return;
  const go = async () => {
    state.busy = true; render();
    try {
      const { data } = await apiPost(ROUTE.action, { action, params });
      if (data?.argv) setLog(`$ ${data.argv}`);
      if (data?.stdout) setLog(data.stdout);
      if (data?.stderr) setLog(data.stderr);
      if (data && !data.ok) setLog(`✗ ${data.error || "操作失败"}`);
      if (data?.publicUrl) state.quickUrl = data.publicUrl;
      if (data?.diagnosis) state.diag = data.diagnosis;
      if (data?.cloudDiagnosis) state.cloudDiag = data.cloudDiagnosis;
      if (data?.cloudRoutes) state.cloudRoutes = data.cloudRoutes;
      if (data?.relayRules) state.relayRules = data.relayRules;
      if (data?.routes) state.routes = data.routes;
    } catch (error) {
      setLog(`✗ 请求失败：${String(error)}`);
    } finally {
      state.busy = false;
      await loadStatus();
    }
  };
  if (confirmMsg) askConfirm(confirmMsg, go); else await go();
}

// ---------------------------------------------------------------- 渲染

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function currentMode() {
  const checked = ui.modes.querySelector('input[name="mode"]:checked');
  return checked?.value || "relay";
}

function render() {
  const s = state.status;
  const installed = !!s?.cftunnel?.installed;

  // 顶栏
  if (!s) { ui.dot.dataset.state = "unknown"; ui.healthText.textContent = "正在检查…"; }
  else if (!installed) { ui.dot.dataset.state = "bad"; ui.healthText.textContent = "未安装 cftunnel"; }
  else if (s.active?.running) { ui.dot.dataset.state = "good"; ui.healthText.textContent = "隧道运行中"; }
  else { ui.dot.dataset.state = "idle"; ui.healthText.textContent = "隧道已停止"; }
  ui.appVersion.textContent = s ? `v${s.appVersion}` : "v—";
  ui.missing.classList.toggle("hidden", !s || installed);

  const mode = s?.mode || "relay";
  const running = !!s?.active?.running;

  // 总览
  ui.statusBadge.textContent = running ? "运行中" : "已停止";
  ui.statusBadge.className = `badge ${running ? "badge--good" : "badge--idle"}`;
  ui.modeLabel.textContent = mode === "relay" ? "Relay 模式（自建中继）" : "Cloud 模式（Cloudflare）";
  const kv = [];
  if (s) {
    kv.push(["cftunnel", s.cftunnel.installed ? `v${s.cftunnel.version || "未知"}` : "未安装"]);
    kv.push(["本地端口", s.ports.effective != null ? String(s.ports.effective) : "未确定" + (s.ports.hana ? `（Hana 探测 ${s.ports.hana}）` : "")]);
    if (mode === "relay" && s.active?.server) kv.push(["中继服务器", s.active.server]);
    if (mode === "cloud") kv.push(["Cloudflare", s.cloud?.configured ? "已配置" : "未配置（去「隧道」标签配置）"]);
    if (s.publicAddress) kv.push(["公网地址", s.publicAddress]);
  }
  ui.statusKv.innerHTML = kv
    .map(([k, v]) => `<div class="kv__k">${escapeHtml(k)}</div><div class="kv__v">${escapeHtml(v)}</div>`)
    .join("");
  ui.up.disabled = state.busy || !installed || running;
  ui.down.disabled = state.busy || !installed || !running;
  ui.open.disabled = !s?.publicAddress;
  ui.copy.disabled = !s?.publicAddress;
  ui.overviewHint.textContent = installed
    ? (running ? "地址可直接发到手机；Relay 为明文 HTTP，敏感用途建议改用 Cloud 模式。" : "点「启动隧道」把本机服务递到公网。")
    : "先到「安装」标签把 cftunnel 装好。";

  // 隧道：模式
  const radio = ui.modes.querySelector(`input[value="${mode}"]`);
  if (radio) radio.checked = true;
  const caps = s?.capabilities;
  ui.modeHint.textContent = "";
  ui.secRelay.classList.toggle("hidden", mode !== "relay");
  ui.secCloud.classList.toggle("hidden", mode !== "cloud");
  ui.relayRuleForm.classList.toggle("hidden", mode !== "relay");
  ui.cloudRouteForm.classList.toggle("hidden", mode !== "cloud");

  // Relay 状态
  ui.relayState.textContent = s?.relay?.configured
    ? `已配置：${s.relay.server || "?"}　规则 ${s.relay.rules?.length ?? 0} 条`
    : "尚未配置中继服务器";
  ui.token.placeholder = s?.config?.token ? "已保存（留空保持不变）" : "留空则不变；服务器未设鉴权可不填";
  ui.server.value = ui.server.value || s?.relay?.server || "";

  // Cloud 状态
  if (s) {
    ui.cloudState.textContent = s.cloud?.configured
      ? `已配置：隧道 ${s.cloud.tunnelId || s.cloud.tunnelName || "?"}　路由 ${s.cloud.routes?.length ?? 0} 条`
      : "尚未配置 Cloudflare 认证（需 API 令牌 + 账户 ID）";
    if (!ui.cloudAccount.value && s.cloud?.account) ui.cloudAccount.value = s.cloud.account;
    if (!ui.cloudTunnel.value && s.cloud?.tunnelName) ui.cloudTunnel.value = s.cloud.tunnelName;
  }

  // 路由列表
  ui.routesMode.textContent = mode === "relay" ? "（Relay 规则）" : "（Cloud 路由）";
  const rules = mode === "relay" ? s?.relay?.rules || [] : s?.cloud?.routes || [];
  if (!rules.length) {
    ui.routesList.innerHTML = `<p class="muted">暂无${mode === "relay" ? "规则" : "路由"}。${installed ? "在下方添加一条。" : ""}</p>`;
  } else {
    ui.routesList.innerHTML = rules
      .map((r) => {
        const name = r.name || r.id || "(未命名)";
        const meta = mode === "relay"
          ? `${r.proto || "tcp"} ${r.localPort ?? "?"} → ${r.remotePort ?? r.localPort ?? "?"}`
          : `${r.port ?? r.localPort ?? "?"} → ${r.domain || r.hostname || "?"}`;
        const btn = mode === "relay" ? 'data-remove-rule' : 'data-remove-cloud';
        return `<div class="route">
          <span class="route__name">${escapeHtml(name)}</span>
          <span class="route__meta">${escapeHtml(meta)}</span>
          <button class="btn btn--danger-outline btn--xs" ${btn}="${escapeHtml(name)}" type="button">删除</button>
        </div>`;
      })
      .join("");
    for (const btn of ui.routesList.querySelectorAll("[data-remove-rule]")) {
      btn.addEventListener("click", () => {
        const name = btn.getAttribute("data-remove-rule");
        runAction("relayRemove", { name }, { confirmMsg: `删除规则「${name}」？该端口的公网访问会立即失效。` });
      });
    }
    for (const btn of ui.routesList.querySelectorAll("[data-remove-cloud]")) {
      btn.addEventListener("click", () => {
        const name = btn.getAttribute("data-remove-cloud");
        runAction("cloudRemove", { name }, { confirmMsg: `删除 Cloud 路由「${name}」？会同时清理它的 DNS 记录。` });
      });
    }
  }

  // 自启动
  if (s) ui.autoStart.checked = !!s.config?.autoStart;
  // 掉线自愈
  if (s) ui.autoHeal.checked = !!s.config?.autoHeal;

  // 分享
  ui.quickResult.classList.toggle("hidden", !state.quickUrl);
  if (state.quickUrl) ui.quickUrl.textContent = state.quickUrl;

  // 能力门控
  if (caps?.known) {
    const missing = [];
    if (!caps.share) missing.push("share");
    if (!caps.preset) missing.push("preset");
    if (!caps.history) missing.push("history");
    ui.share.disabled = !caps.share;
    ui.history.disabled = !caps.history;
    ui.historyClear.disabled = !caps.history;
    ui.presetRun.disabled = !caps.preset;
    ui.presetRefresh.disabled = !caps.preset;
    ui.quickVerNote.textContent = missing.length ? `（本机版本不支持：${missing.join(" / ")}，升级后可用）` : "";
  }

  // 诊断
  if (state.diag) {
    const d = state.diag;
    const lines = [`Relay：服务器 ${d.server}（${d.serverOk ? "通" : "不通"}${d.serverLatencyMs != null ? `，${d.serverLatencyMs}ms` : ""}）`, `frpc：${d.frpcRunning ? "运行中" : "未运行"}`];
    for (const r of d.rules || []) lines.push(`· ${r.name} ${r.proto} ${r.localPort}→${r.remotePort}｜本地${r.localOk ? "✓" : "✗"} 远程${r.remoteOk ? "✓" : "✗"}${r.error ? `（${r.error}）` : ""}`);
    showDiag(lines.join("\n"));
  }
  if (state.cloudDiag) {
    const c = state.cloudDiag;
    const lines = [
      `Cloud：cloudflared ${c.cloudflared.installed ? `已装${c.cloudflared.version ? `（${String(c.cloudflared.version).slice(0, 40)}）` : ""}` : "未装"}　运行${c.cloudflared.running ? "中" : "否"}`,
      `Cloudflare API：${c.api.reachable ? "可达" : "不可达"}${c.api.latencyMs != null ? `（${c.api.latencyMs}ms）` : ""}`,
      `路由：${c.routes.length} 条　结果 ${c.passed ?? "?"} 通 / ${c.failed ?? "?"} 不通`,
    ];
    showDiag(lines.join("\n"));
  }

  ui.confirmBar.classList.toggle("hidden", !confirmRequest);
  if (confirmRequest) ui.confirmText.textContent = confirmRequest.message;

  // 标签
  for (const t of ui.tabs.querySelectorAll(".tab")) t.classList.toggle("is-active", t.dataset.tab === state.tab);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("is-active", p.dataset.pane === state.tab);

  renderInstall(s);
  document.getElementById("panel").setAttribute("aria-busy", String(state.busy));
}

/** 安装板块渲染。 */
function renderInstall(s) {
  const installed = !!s?.cftunnel?.installed;
  const eng = s?.engines;
  const hasEngine = !!(eng?.frpc?.exists || eng?.cloudflared?.exists);

  if (!s) { ui.installBadge.textContent = "检查中"; ui.installBadge.className = "badge badge--idle"; }
  else if (installed && hasEngine) { ui.installBadge.textContent = "就绪"; ui.installBadge.className = "badge badge--good"; }
  else if (installed) { ui.installBadge.textContent = "缺引擎"; ui.installBadge.className = "badge badge--warn"; }
  else { ui.installBadge.textContent = "未安装"; ui.installBadge.className = "badge badge--warn"; }

  ui.dotCf.dataset.on = installed ? "1" : "0";
  ui.cfMeta.textContent = installed
    ? `v${s.cftunnel.version || "未知"}｜${s.install?.installDir || s.cftunnel.path || ""}`
    : "未检测到（点「安装」一键装好）";
  ui.cfInstall.textContent = installed ? "已安装" : "安装";
  ui.cfInstall.disabled = !!state.busy || installed;
  ui.cfReinstall.disabled = !!state.busy || !installed;
  ui.cfUninstall.disabled = !!state.busy || !installed;

  if (state.latest) {
    const l = state.latest;
    if (!l.ok) { ui.cfLatest.textContent = `检查更新失败：${l.error || "未知"}（不影响使用）`; ui.cfUpdate.disabled = !!state.busy; }
    else {
      ui.cfLatest.textContent = l.upToDate
        ? `已是最新（${l.latest.tag}）`
        : `有新版本：${l.latest.tag}（本机 v${l.local || "未知"}）｜该项目标签号会回退，以 GitHub 的 latest 为准`;
      ui.cfUpdate.disabled = !!state.busy || l.upToDate;
      ui.cfUpdate.textContent = l.upToDate ? "已是最新" : `更新到 ${l.latest.tag}`;
    }
  } else {
    ui.cfLatest.textContent = "点「检查更新」向 GitHub 查询最新版本。";
    ui.cfUpdate.disabled = !!state.busy;
  }

  const parts = [];
  if (eng) { parts.push(`frpc ${eng.frpc?.exists ? "✓" : "✗"}`); parts.push(`cloudflared ${eng.cloudflared?.exists ? "✓" : "✗"}`); }
  ui.dotEngine.dataset.on = hasEngine ? "1" : "0";
  ui.engineMeta.textContent = eng ? `${parts.join("　")}　${eng.binDir || ""}` : "未检测";
  ui.engineRepair.disabled = !!state.busy;

  const j = state.job;
  const showJob = !!j && (j.running || j.done || j.error);
  ui.jobBox.classList.toggle("hidden", !showJob);
  if (showJob) {
    const actionName = { installSelf: "安装", updateSelf: "更新", reinstallSelf: "重装", uninstallSelf: "卸载", repairEngine: "预装/修复引擎" }[j.action] || "作业";
    ui.jobLabel.textContent = j.running ? `${actionName}中…` : j.error ? `${actionName}失败` : `${actionName}完成`;
    ui.jobPhase.textContent = j.running ? (j.phase || "") : "";
    if (j.running) {
      ui.jobFill.classList.add("job__fill--busy");
      if (Number.isFinite(j.percent)) ui.jobFill.style.width = `${j.percent}%`;
    } else {
      ui.jobFill.classList.remove("job__fill--busy");
      ui.jobFill.style.width = "100%";
      ui.jobFill.style.background = j.error ? "var(--ra-danger)" : "var(--ra-green)";
    }
    ui.jobLog.textContent = j.log || "";
  }
}

// ---------------------------------------------------------------- 事件：通用

ui.refresh.addEventListener("click", async () => { await loadStatus(); setLog("已刷新状态。"); });
ui.tabs.addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (!t) return;
  state.tab = t.dataset.tab;
  render();
});
ui.openReleases.addEventListener("click", () => hana.external.open({ url: state.status?.cftunnel?.releases || "https://github.com/qingchencloud/cftunnel/releases/latest" }));
ui.openDocs.addEventListener("click", () => hana.external.open({ url: state.status?.cftunnel?.docs || "https://qingchencloud.github.io/cftunnel/" }));

// 总览
ui.up.addEventListener("click", () => runAction("up", {}));
ui.down.addEventListener("click", () => runAction("down", {}));
ui.copy.addEventListener("click", async () => {
  const url = state.status?.publicAddress;
  if (!url) return;
  try { await hana.clipboard.writeText({ text: url }); setLog(`已复制：${url}`); } catch (e) { setLog(`复制失败：${String(e)}`); }
});
ui.open.addEventListener("click", () => { const url = state.status?.publicAddress; if (url) hana.external.open({ url }); });
ui.share.addEventListener("click", () => {
  const addr = state.status?.publicAddress;
  if (!addr) return setLog("当前没有可分享的公网地址（先启动隧道）。");
  runAction("share", { address: addr, qr: true });
});

// 隧道
ui.modes.addEventListener("change", async () => {
  const mode = currentMode();
  const { data } = await apiPost(ROUTE.config, { config: { mode } });
  if (data?.ok) setLog(`模式已切到 ${mode === "relay" ? "Relay" : "Cloud"}（两种配置独立共存，未删另一条）`);
  await loadStatus();
});
ui.relayInit.addEventListener("click", () => {
  const server = ui.server.value.trim();
  if (!server) return setLog("请填写中继服务器地址（IP:端口）。");
  runAction("relayInit", { server, token: ui.token.value.trim() });
});
ui.cloudInit.addEventListener("click", () => {
  const token = ui.cloudToken.value.trim();
  const account = ui.cloudAccount.value.trim();
  if (!token) return setLog("请填写 Cloudflare API 令牌（需要 Tunnel 编辑 + DNS 编辑 + 区域读取三项权限）。");
  runAction("cloudInit", { token, account }, { confirmMsg: "将把 API 令牌交给 cftunnel 写入它自己的配置（~/.cftunnel）。本 App 不保存令牌。继续？" });
});
ui.cloudCreate.addEventListener("click", () => {
  const name = ui.cloudTunnel.value.trim();
  if (!name) return setLog("请填写隧道名称。");
  runAction("cloudCreate", { name });
});
ui.addRule.addEventListener("click", () => {
  const name = ui.routeName.value.trim();
  const local = Number.parseInt(ui.routeLocal.value, 10);
  const remote = Number.parseInt(ui.routeRemote.value, 10);
  if (!name) return setLog("请填写规则名称。");
  if (!Number.isFinite(local)) return setLog("请填写本地端口。");
  runAction("relayAdd", { name, port: local, remotePort: Number.isFinite(remote) ? remote : undefined, proto: ui.routeProto.value });
});
ui.cloudAddRoute.addEventListener("click", () => {
  const name = ui.cloudRouteName.value.trim();
  const port = Number.parseInt(ui.cloudRoutePort.value, 10);
  if (!name) return setLog("请填写路由名称。");
  if (!Number.isFinite(port)) return setLog("请填写本地端口。");
  runAction("cloudAdd", { name, port, domain: ui.cloudRouteDomain.value.trim() });
});
ui.svcInstall.addEventListener("click", () => runAction("installService", {}, { confirmMsg: "注册系统服务会让隧道在 Hana 未运行时也保持在线，可能需要管理员权限。继续？" }));
ui.svcUninstall.addEventListener("click", () => runAction("uninstallService", {}, { confirmMsg: "取消系统服务后，Hana 未运行时隧道将不再保持在线。继续？" }));
ui.autoStart.addEventListener("change", async () => {
  const autoStart = ui.autoStart.checked;
  const { data } = await apiPost(ROUTE.config, { config: { autoStart } });
  if (data?.ok) setLog(`已${autoStart ? "开启" : "关闭"}随 Hana 自启动。`);
  await loadStatus();
});
ui.autoHeal.addEventListener("change", async () => {
  const autoHeal = ui.autoHeal.checked;
  const { data } = await apiPost(ROUTE.config, { config: { autoHeal } });
  if (data?.ok) setLog(`已${autoHeal ? "开启" : "关闭"}掉线自动重连。`);
  await loadStatus();
});
ui.destroy.addEventListener("click", () => runAction("destroy", { force: false }, { confirmMsg: "删除 Cloud 隧道并清理它的全部 DNS 记录？不可撤销。继续？" }));
ui.reset.addEventListener("click", () => runAction("reset", { force: false }, { confirmMsg: "完全重置：删除隧道 + 清空本地配置。不可撤销。继续？" }));

// 分享
ui.quick.addEventListener("click", () => {
  const port = Number.parseInt(ui.quickPort.value, 10);
  if (!Number.isFinite(port)) return setLog("请先填写端口。");
  const useRelay = ui.quickRelay.value === "1";
  runAction("quick", {
    port, useRelay,
    proto: useRelay ? ui.quickProto.value : undefined,
    qr: ui.quickQr.checked, telegram: ui.quickTelegram.checked, share: ui.quickShare.checked,
  });
});
ui.quickRelay.addEventListener("change", () => {
  ui.quickProtoWrap.classList.toggle("hidden", ui.quickRelay.value !== "1");
});
ui.quickCopy.addEventListener("click", async () => {
  if (!state.quickUrl) return;
  try { await hana.clipboard.writeText({ text: state.quickUrl }); setLog(`已复制：${state.quickUrl}`); } catch (e) { setLog(`复制失败：${String(e)}`); }
});
ui.presetRefresh.addEventListener("click", async () => {
  const { data } = await apiPost(ROUTE.action, { action: "presetList", params: {} });
  if (data?.stdout) {
    setLog(data.stdout);
    const names = [...new Set((data.stdout.match(/^\s*([a-z][a-z0-9-]+)\s{2,}/gim) || []).map((s) => s.trim().split(/\s{2,}/)[0]))]
      .filter((n) => !["preset", "name", "名称"].includes(n));
    if (names.length) {
      ui.presetSelect.innerHTML = `<option value="">— 选择模板 —</option>` + names.map((n) => `<option value="${n}">${n}</option>`).join("");
      setLog(`已读取模板：${names.join(", ")}`);
    }
  } else setLog(data?.error || "读取模板失败。");
});
ui.presetRun.addEventListener("click", () => {
  const name = ui.presetSelect.value;
  if (!name) return setLog("请先选择一个模板。");
  runAction("presetRun", { name, share: ui.quickShare.checked });
});
ui.history.addEventListener("click", () => runAction("history", {}));
ui.historyClear.addEventListener("click", () => runAction("historyClear", {}, { confirmMsg: "清空本地端口使用记录？不可撤销。" }));

// 安装
ui.missingInstall.addEventListener("click", () => startJob("install"));
async function startJob(action, confirmMsg) {
  const go = async () => {
    const { data } = await apiPost(ROUTE.job, { action });
    if (data && data.ok === false) { setLog(data.message || "作业未能启动"); return; }
    await loadJob();
  };
  if (confirmMsg) askConfirm(confirmMsg, go); else await go();
}
ui.cfInstall.addEventListener("click", () => startJob("install"));
ui.cfUpdate.addEventListener("click", () => startJob("update"));
ui.cfReinstall.addEventListener("click", () => startJob("reinstall", "重装会先卸载再安装 cftunnel（配置 ~/.cftunnel 不动）。继续？"));
ui.cfUninstall.addEventListener("click", () => startJob("uninstall", "卸载会删除 cftunnel 程序目录并从 PATH 移除，配置保留。隧道会断。继续？"));
ui.engineRepair.addEventListener("click", () => startJob("repairEngine"));

// 诊断
ui.check.addEventListener("click", () => runAction("check", {}));
ui.diagnose.addEventListener("click", () => runAction("diagnose", { json: true }));
ui.logs.addEventListener("click", async () => {
  const { data } = await api(ROUTE.logs);
  if (data?.logs) showDiag(data.logs);
  else setLog(data?.error || "暂无日志。");
});

ui.confirmOk.addEventListener("click", async () => { const req = confirmRequest; closeConfirm(); if (req) await req.onOk(); });
ui.confirmCancel.addEventListener("click", closeConfirm);

// ---------------------------------------------------------------- 轮询

function startPoll() { stopPoll(); pollTimer = setInterval(() => { if (!state.busy) loadStatus(); }, POLL_MS); }
function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

(async function boot() {
  await hana.ready();
  await loadStatus();
  await loadDetect();
  await loadJob();
  ui.quickProtoWrap.classList.add("hidden");
  render();
  startPoll();
  window.addEventListener("beforeunload", () => { stopPoll(); if (jobTimer) clearInterval(jobTimer); });
})();