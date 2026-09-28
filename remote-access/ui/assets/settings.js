// 远程访问设置页：读写配置（模式 / 服务器 / 端口 / 自启动）。
// 数据面：hana.api.fetch → /api/apps/remote-access/routes/config
import { hana } from "./sdk.js";

const ROUTE = { config: "/config", detect: "/detect" };

const el = (id) => document.getElementById(id);
const ui = {
  root: el("settings"),
  modes: el("modes"),
  secRelay: el("sec-relay"),
  server: el("server"),
  token: el("token"),
  localPort: el("localPort"),
  portHint: el("port-hint"),
  autoStart: el("autoStart"),
  authEnabled: el("authEnabled"),
  save: el("save"),
  reload: el("reload"),
  saveHint: el("save-hint"),
};

async function api(path, init) {
  const res = await hana.api.fetch(path, init);
  const raw = await res.text();
  try {
    return { status: res.status, data: raw ? JSON.parse(raw) : null };
  } catch {
    return { status: res.status, data: null };
  }
}

let hasToken = false;

function currentMode() {
  const checked = ui.modes.querySelector('input[name="mode"]:checked');
  return checked?.value || "relay";
}

function renderMode() {
  const mode = currentMode();
  ui.secRelay.classList.toggle("hidden", mode !== "relay");
}

async function load() {
  const { data } = await api(ROUTE.config);
  const cfg = data?.config || {};
  hasToken = !!data?.hasToken;

  const radio = ui.modes.querySelector(`input[value="${cfg.mode || "relay"}"]`);
  if (radio) radio.checked = true;
  ui.server.value = cfg.server || "";
  ui.token.value = "";
  ui.token.placeholder = hasToken ? "已保存（留空保持不变）" : "留空则不变；服务器未设鉴权可不填";
  ui.localPort.value = cfg.localPort != null ? String(cfg.localPort) : "";
  ui.autoStart.checked = cfg.autoStart !== false;
  ui.authEnabled.checked = !!cfg.authEnabled;
  renderMode();

  // 端口提示：给出自动探测到的 Hana 端口
  try {
    const det = await api(ROUTE.detect);
    if (det?.data?.hanaPort) {
      ui.portHint.textContent = `默认暴露 Hana 自己（当前探测到端口 ${det.data.hanaPort}）。想穿透别的服务，在这里填它的端口。`;
    }
  } catch {}
  ui.root.setAttribute("aria-busy", "false");
}

async function save() {
  const patch = {
    mode: currentMode(),
    server: ui.server.value.trim(),
    localPort: ui.localPort.value === "" ? null : Number.parseInt(ui.localPort.value, 10),
    autoStart: ui.autoStart.checked,
    authEnabled: ui.authEnabled.checked,
  };
  // token：留空 = 保持不变；填了 = 更新
  if (ui.token.value.trim()) patch.token = ui.token.value.trim();

  const { data } = await api(ROUTE.config, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: patch }),
  });
  if (data?.ok) {
    ui.saveHint.textContent = "已保存 ✓";
    hasToken = !!data?.config?.token;
    setTimeout(() => (ui.saveHint.textContent = ""), 2500);
  } else {
    ui.saveHint.textContent = "保存失败";
  }
}

ui.modes.addEventListener("change", renderMode);
ui.save.addEventListener("click", save);
ui.reload.addEventListener("click", load);

(async function boot() {
  await hana.ready();
  await load();
})();
