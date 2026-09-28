// cftunnel-core 纯逻辑单测。用真实命令输出作样例，确保解析器对得上。
// 运行：node tests/core.test.mjs
import assert from "node:assert/strict";
import {
  cleanEnv,
  cftunnelExecutableCandidates,
  cftunnelConfigDir,
  parseCftunnelVersion,
  compareVersions,
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
  pickReleaseAsset,
  mirrorDownloadUrl,
  mirrorLabel,
  cftunnelInstallDir,
  isUpToDate,
  engineBinaryName,
  engineBinDir,
  parsePinnedFrpVersion,
  frpAssetName,
  frpDownloadUrl,
  cloudflaredDownloadUrl,
  cftunnelLatestDownloadUrl,
  extractDownloadUrl,
  parseHelpCommands,
  featureAvailability,
  parseListOutput,
  parseDiagnoseJson,
  redactSecrets,
  healDecision,
  tunnelHealthFromCheck,
  isDeepCheckTick,
} from "../remote-access/lib/cftunnel-core.js";

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
};

console.log("cftunnel-core 单测\n");

// --- 环境 ---
t("cleanEnv 剔除代理变量", () => {
  const env = cleanEnv({ HTTP_PROXY: "x", https_proxy: "y", PATH: "/bin", KEEP: "1" });
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.KEEP, "1");
});

t("cftunnel 候选路径含环境变量与 PATH 兜底", () => {
  const c = cftunnelExecutableCandidates({ CFTUNNEL_PATH: "/custom/cf" }, "win32");
  assert.equal(c[0], "/custom/cf");
  assert.ok(c.includes("cftunnel"));
});

t("cftunnel 配置目录来自用户主目录", () => {
  assert.equal(cftunnelConfigDir({ USERPROFILE: "C:/Users/x" }, "win32"), "C:/Users/x/.cftunnel");
  assert.equal(cftunnelConfigDir({ HOME: "/home/x" }, "linux"), "/home/x/.cftunnel");
  assert.equal(cftunnelConfigDir({}, "linux"), null);
});

// --- 版本 ---
t("解析版本号", () => {
  assert.equal(parseCftunnelVersion("cftunnel 0.8.1"), "0.8.1");
  assert.equal(parseCftunnelVersion("no version here"), null);
});

t("版本比较", () => {
  assert.ok(compareVersions("0.9.0", "0.8.1") > 0);
  assert.ok(compareVersions("0.8.1", "0.8.1") === 0);
  assert.ok(compareVersions("0.8.0", "0.8.1") < 0);
});

// --- 真实输出样例 ---
t("解析 relay list 表格（真实样例）", () => {
  const sample = `名称      协议    本地端口      远程端口      域名
----    ----  --------  --------  ----
web-demo  tcp   8080     8080     -`;
  const rows = parseRouteTable(sample);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "web-demo");
  assert.equal(rows[0].proto, "tcp");
  assert.equal(rows[0].localPort, 8080);
  assert.equal(rows[0].remotePort, 8080);
  assert.equal(rows[0].domain, null);
});

t("解析 status --json（真实样例）", () => {
  const sample = `{
  "relay": {
    "server": "203.0.113.10:7000",
    "running": false,
    "rules": [{ "name": "web-demo", "proto": "tcp", "local_port": 8080, "remote_port": 8080 }]
  }
}`;
  const s = parseStatusJson(sample);
  assert.equal(s.relay.configured, true);
  assert.equal(s.relay.running, false);
  assert.equal(s.relay.server, "203.0.113.10:7000");
  assert.equal(s.relay.rules[0].localPort, 8080);
  assert.equal(s.cloud.configured, false);
});

t("解析 relay check --json（真实样例）", () => {
  const sample = `{
  "server": "203.0.113.10:7000",
  "server_ok": true,
  "server_latency_ms": 103,
  "frpc_running": false,
  "rules": [{ "name": "web-demo", "proto": "tcp", "local_port": 8080, "remote_port": 8080, "local_ok": true, "remote_ok": false, "latency_ms": 0, "remote_err": "超时" }],
  "total": 1, "passed": 0, "failed": 1
}`;
  const d = parseCheckJson(sample);
  assert.equal(d.serverOk, true);
  assert.equal(d.serverLatencyMs, 103);
  assert.equal(d.rules[0].localOk, true);
  assert.equal(d.rules[0].remoteOk, false);
  assert.equal(d.rules[0].error, "超时");
  assert.equal(d.failed, 1);
});

t("解析异常输入不崩", () => {
  assert.deepEqual(parseStatusJson("not json").relay.configured, false);
  assert.deepEqual(parseRouteTable(""), []);
  assert.deepEqual(parseCheckJson(null).rules, []);
});

// --- 端口 ---
t("从 server-info.json 取端口", () => {
  assert.equal(portFromServerInfo('{"port":8080}'), 8080);
  assert.equal(portFromServerInfo('{"network":{"actualPort":5000}}'), 5000);
  assert.equal(portFromServerInfo('{}'), null);
});

t("端口优先级：配置 > 探测", () => {
  assert.equal(resolveLocalPort({ configuredPort: 8080, hanaPort: 8080 }), 8080);
  assert.equal(resolveLocalPort({ configuredPort: null, hanaPort: 8080 }), 8080);
  assert.equal(resolveLocalPort({}), null);
});

// --- 公网地址 ---
t("提取 quick 临时地址", () => {
  assert.equal(extractQuickUrl("隧道已启动: https://calm-fox-1234.trycloudflare.com"), "https://calm-fox-1234.trycloudflare.com");
  assert.equal(extractQuickUrl("no url"), null);
});

t("拼 Relay 公网地址", () => {
  assert.equal(relayPublicAddress("1.2.3.4:7000", 8080), "http://1.2.3.4:8080");
  assert.equal(relayPublicAddress(null, 1), null);
});

// --- 命令构造 ---
t("构造常用命令", () => {
  assert.deepEqual(buildCommand("status").argv, ["status", "--json"]);
  assert.deepEqual(buildCommand("up", { mode: "relay" }).argv, ["relay", "up"]);
  assert.deepEqual(buildCommand("up", { mode: "cloud" }).argv, ["up"]);
  assert.deepEqual(buildCommand("down", { mode: "relay" }).argv, ["relay", "down"]);
  assert.deepEqual(buildCommand("check").argv, ["relay", "check", "--json"]);
});

t("构造 relay init", () => {
  assert.deepEqual(buildCommand("relayInit", { server: "1.2.3.4:7000" }).argv, ["relay", "init", "--server", "1.2.3.4:7000"]);
  assert.deepEqual(buildCommand("relayInit", { server: "1.2.3.4:7000", token: "abc" }).argv, ["relay", "init", "--server", "1.2.3.4:7000", "--token", "abc"]);
  assert.ok(buildCommand("relayInit", {}).error);
});

t("构造 relay add / remove", () => {
  assert.deepEqual(buildCommand("relayAdd", { name: "web", port: 8080 }).argv, ["relay", "add", "web", "--local", "8080", "--proto", "tcp"]);
  assert.deepEqual(buildCommand("relayAdd", { name: "web", port: 8080, remotePort: 9000, proto: "udp" }).argv, ["relay", "add", "web", "--local", "8080", "--proto", "udp", "--remote", "9000"]);
  assert.deepEqual(buildCommand("relayRemove", { name: "web" }).argv, ["relay", "remove", "web"]);
  assert.ok(buildCommand("relayAdd", { name: "web" }).error);
});

t("构造 quick", () => {
  assert.deepEqual(buildCommand("quick", { port: 3000 }).argv, ["quick", "3000"]);
  assert.deepEqual(buildCommand("quick", { port: 3000, useRelay: true, auth: "u:p" }).argv, ["quick", "3000", "--relay", "--auth", "u:p"]);
  assert.ok(buildCommand("quick", {}).error);
});

t("未知操作报错", () => {
  assert.ok(buildCommand("nope").error);
});

console.log("\n-- 安装与引擎 --");

// --- 发布资产 ---
t("平台资产名", () => {
  assert.equal(releaseAssetName("win32", "x64"), "cftunnel_windows_amd64.zip");
  assert.equal(releaseAssetName("linux", "arm64"), "cftunnel_linux_arm64.tar.gz");
  assert.equal(releaseAssetName("darwin", "x64"), "cftunnel_darwin_amd64.tar.gz");
  assert.equal(releaseAssetName("freebsd", "x64"), null);
});

t("本体 latest 下载地址不钉版本", () => {
  const u = cftunnelLatestDownloadUrl("win32", "x64");
  assert.ok(u.includes("/releases/download/latest/download/cftunnel_windows_amd64.zip"));
});

t("解析 latest 发布（真实样例）", () => {
  const sample = JSON.stringify({
    tag_name: "v0.4.4",
    published_at: "2026-09-26T14:12:54Z",
    assets: [
      { name: "cftunnel_windows_amd64.zip", browser_download_url: "https://x/a.zip", size: 100 },
      { name: "cftunnel_linux_amd64.tar.gz", browser_download_url: "https://x/b.tgz", size: 90 },
    ],
  });
  const r = parseLatestRelease(sample);
  assert.equal(r.ok, true);
  assert.equal(r.tag, "v0.4.4");
  assert.equal(r.version, "0.4.4");
  assert.equal(r.assets.length, 2);
  const a = pickReleaseAsset(r.assets, "win32", "x64");
  assert.equal(a.name, "cftunnel_windows_amd64.zip");
});

t("latest 解析异常不崩", () => {
  assert.equal(parseLatestRelease("not json").ok, false);
  assert.equal(parseLatestRelease("{}").ok, false);
  assert.equal(pickReleaseAsset(null, "win32", "x64"), null);
});

// --- 更新判定：靠字符串相等，不靠 semver ---
t("更新判定用字符串相等（版本号回退项目）", () => {
  // 该项目 0.8.1 发布于 3 月、0.4.4 发布于 9 月，semver 比较会得出错误结论
  assert.equal(isUpToDate("0.8.1", "0.8.1"), true);
  assert.equal(isUpToDate("v0.8.1", "0.8.1"), true);
  assert.equal(isUpToDate("0.8.1", "0.4.4"), false); // 不能因为 0.8.1>0.4.4 就判“已最新”
  assert.equal(isUpToDate("", "0.4.4"), false);
  assert.equal(isUpToDate("0.4.4", ""), false);
});

// --- 镜像 ---
t("镜像 URL 与标签", () => {
  assert.equal(mirrorDownloadUrl("https://g/x.zip", ""), "https://g/x.zip");
  assert.equal(mirrorDownloadUrl("https://g/x.zip", "https://ghfast.top/"), "https://ghfast.top/https://g/x.zip");
  assert.equal(mirrorLabel(""), "直连");
  assert.equal(mirrorLabel("https://ghfast.top/"), "ghfast.top");
});

// --- 安装目录 ---
t("安装目录按平台", () => {
  assert.equal(cftunnelInstallDir({ LOCALAPPDATA: "C:\\U\\L" }, "win32"), "C:\\U\\L\\cftunnel");
  assert.equal(cftunnelInstallDir({ HOME: "/home/u" }, "linux"), "/home/u/.local/bin");
  assert.equal(cftunnelInstallDir({}, "linux"), null);
});

// --- 引擎 ---
t("引擎文件名", () => {
  assert.equal(engineBinaryName("frpc", "win32"), "frpc.exe");
  assert.equal(engineBinaryName("cloudflared", "linux"), "cloudflared");
  assert.equal(engineBinaryName("frpc", "darwin"), "frpc");
});

t("引擎目录 = 配置目录/bin", () => {
  assert.equal(engineBinDir({ HOME: "/home/u" }, "linux"), "/home/u/.cftunnel/bin");
  assert.equal(engineBinDir({ USERPROFILE: "C:\\U" }, "win32"), "C:\\U/.cftunnel/bin");
});

t("从 cftunnel 二进制里读钉死的 frp 版本", () => {
  const text = '...\nFRP_VERSION="0.66.0"\nFILENAME="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"';
  assert.equal(parsePinnedFrpVersion(text), "0.66.0");
  assert.equal(parsePinnedFrpVersion("nothing here"), null);
});

t("frp 资产名与下载地址（按钉死版本）", () => {
  const a = frpAssetName("0.66.0", "win32", "x64");
  assert.equal(a.file, "frp_0.66.0_windows_amd64.zip");
  assert.equal(a.dir, "frp_0.66.0_windows_amd64");
  assert.ok(frpDownloadUrl("0.66.0", "win32", "x64").includes("/releases/download/v0.66.0/frp_0.66.0_windows_amd64.zip"));
  assert.equal(frpAssetName(null, "win32", "x64"), null);
});

t("cloudflared 下载地址走 latest", () => {
  assert.ok(cloudflaredDownloadUrl("win32", "x64").endsWith("/latest/download/cloudflared-windows-amd64.exe"));
  assert.ok(cloudflaredDownloadUrl("linux", "arm64").endsWith("/latest/download/cloudflared-linux-arm64"));
});

t("从输出里抓下载地址（兜底路径）", () => {
  const t = '尝试下载: https://github.com/fatedier/frp/releases/download/v0.66.0/frp_0.66.0_windows_amd64.zip';
  assert.equal(extractDownloadUrl(t), "https://github.com/fatedier/frp/releases/download/v0.66.0/frp_0.66.0_windows_amd64.zip");
  assert.equal(extractDownloadUrl("无链接"), null);
});

console.log("\n-- 官方文档对齐 --");

// --- 官方分享/模板/历史命令 ---
t("quick 支持官方 --proto/--share/--qr/--telegram", () => {
  assert.deepEqual(buildCommand("quick", { port: 3000 }).argv, ["quick", "3000"]);
  assert.deepEqual(buildCommand("quick", { port: 9987, useRelay: true, proto: "udp" }).argv, ["quick", "9987", "--relay", "--proto", "udp"]);
  assert.deepEqual(buildCommand("quick", { port: 3000, share: true }).argv, ["quick", "3000", "--share"]);
  assert.deepEqual(buildCommand("quick", { port: 3000, qr: true }).argv, ["quick", "3000", "--qr"]);
  assert.deepEqual(buildCommand("quick", { port: 3000, auth: "u:p" }).argv, ["quick", "3000", "--auth", "u:p"]);
});

t("share / preset / history 命令构造", () => {
  assert.deepEqual(buildCommand("share", { address: "https://x.trycloudflare.com" }).argv, ["share", "https://x.trycloudflare.com"]);
  assert.deepEqual(buildCommand("share", { address: "https://x", qr: true }).argv, ["share", "https://x", "--qr"]);
  assert.ok(buildCommand("share", {}).error);
  assert.deepEqual(buildCommand("presetList").argv, ["preset", "list"]);
  assert.deepEqual(buildCommand("presetRun", { name: "frontend", share: true }).argv, ["preset", "frontend", "--share"]);
  assert.ok(buildCommand("presetRun", {}).error);
  assert.deepEqual(buildCommand("history").argv, ["history"]);
  assert.deepEqual(buildCommand("historyClear").argv, ["history", "clear"]);
});

t("destroy / reset 支持 --force（官方）", () => {
  assert.deepEqual(buildCommand("destroy").argv, ["destroy"]);
  assert.deepEqual(buildCommand("destroy", { force: true }).argv, ["destroy", "--force"]);
  assert.deepEqual(buildCommand("reset", { force: true }).argv, ["reset", "--force"]);
});

// --- 能力探测（本机 0.8.1 真实 --help 输出片段）---
t("解析 --help 的命令表（真实输出）", () => {
  const help = `Cloudflare Tunnel 一键管理工具

Usage:
  cftunnel [command]

Available Commands:
  add         添加路由（自动创建 CNAME + 更新 ingress）
  destroy     删除隧道
  quick       快速启动免域名隧道
  relay       中继模式
  status      查看隧道状态
  update      更新 cftunnel 到最新版本

Flags:
  -h, --help   help for cftunnel`;
  const cmds = parseHelpCommands(help);
  assert.ok(cmds.has("quick"));
  assert.ok(cmds.has("relay"));
  assert.ok(cmds.has("update"));
  assert.equal(cmds.has("preset"), false);
  assert.equal(cmds.size, 6);
});

t("能力探测：本机无 preset/history/share → 置灰", () => {
  const help = `Available Commands:
  add    添加路由
  quick  快速隧道
  relay  中继
  status 状态

Flags:
  -h, --help`;
  const f = featureAvailability(parseHelpCommands(help));
  assert.equal(f.quick, true);
  assert.equal(f.preset, false);
  assert.equal(f.history, false);
  assert.equal(f.share, false);
  assert.equal(f.known, true);
});

t("能力探测：新版全部具备", () => {
  const help = `Available Commands:
  quick    快速隧道
  relay    中继
  share    分享
  preset   模板
  history  历史

Flags:`;
  const f = featureAvailability(parseHelpCommands(help));
  assert.equal(f.share, true);
  assert.equal(f.preset, true);
  assert.equal(f.history, true);
});

t("能力探测失败（空）不应误判", () => {
  const f = featureAvailability(parseHelpCommands(""));
  assert.equal(f.known, false);
});

console.log("\n-- Cloud 模式（官方命令）--");

t("list 修正为 Cloud 路由列表，relayList 才是规则", () => {
  assert.deepEqual(buildCommand("list").argv, ["list"]);
  assert.deepEqual(buildCommand("relayList").argv, ["relay", "list"]);
});

t("cloudInit / create / add / remove 按官方参数", () => {
  assert.deepEqual(buildCommand("cloudInit", { token: "tk", account: "acc" }).argv, ["init", "--token", "tk", "--account", "acc"]);
  assert.deepEqual(buildCommand("cloudInit", { token: "tk" }).argv, ["init", "--token", "tk"]);
  assert.ok(buildCommand("cloudInit", {}).error);
  assert.deepEqual(buildCommand("cloudCreate", { name: "my-tunnel" }).argv, ["create", "my-tunnel"]);
  assert.ok(buildCommand("cloudCreate", {}).error);
  assert.deepEqual(buildCommand("cloudAdd", { name: "myapp", port: 3000, domain: "app.example.com" }).argv, ["add", "myapp", "3000", "--domain", "app.example.com"]);
  assert.deepEqual(buildCommand("cloudAdd", { name: "myapp", port: 3000 }).argv, ["add", "myapp", "3000"]);
  assert.ok(buildCommand("cloudAdd", { name: "x" }).error);
  assert.deepEqual(buildCommand("cloudRemove", { name: "myapp" }).argv, ["remove", "myapp"]);
  assert.ok(buildCommand("cloudRemove", {}).error);
});

t("diagnose 支持 --json（官方）", () => {
  assert.deepEqual(buildCommand("diagnose").argv, ["diagnose"]);
  assert.deepEqual(buildCommand("diagnose", { json: true }).argv, ["diagnose", "--json"]);
});

t("解析 list 分节输出（真实样例：Relay 规则段）", () => {
  const sample = `Relay 规则:
名称      协议    本地端口      远程端口      域名
----    ----  --------  --------  ----
web-demo  tcp   8080     8080     -`;
  const parsed = parseListOutput(sample);
  assert.equal(parsed.relayRules.length, 1);
  assert.equal(parsed.relayRules[0].name, "web-demo");
  assert.equal(parsed.relayRules[0].localPort, 8080);
  assert.equal(parsed.cloudRoutes.length, 0);
  assert.equal(parsed.sections.length, 1);
});

t("解析 list 分节输出（含 Cloud 路由段）", () => {
  const sample = `Cloud 路由:
名称    本地端口      域名
----  --------  ----------------
myapp  3000      app.example.com

Relay 规则:
名称  协议  本地端口  远程端口  域名
---- ---- -------- -------- ----
ssh  tcp  22       6022     -`;
  const parsed = parseListOutput(sample);
  assert.equal(parsed.cloudRoutes.length, 1);
  assert.equal(parsed.cloudRoutes[0].name, "myapp");
  assert.equal(parsed.relayRules.length, 1);
  assert.equal(parsed.relayRules[0].name, "ssh");
});

t("解析 diagnose --json（真实样例）", () => {
  const sample = `{
  "cloudflared": { "installed": true, "path": "C:/x/cloudflared.exe", "version": "cloudflared version 2026.9.3", "running": false },
  "api": { "reachable": true, "latency_ms": 776 },
  "routes": [], "total": 0, "passed": 0, "failed": 0
}`;
  const d = parseDiagnoseJson(sample);
  assert.equal(d.cloudflared.installed, true);
  assert.equal(d.cloudflared.running, false);
  assert.equal(d.api.reachable, true);
  assert.equal(d.api.latencyMs, 776);
  assert.deepEqual(d.routes, []);
});

t("diagnose 解析异常不崩", () => {
  assert.equal(parseDiagnoseJson("not json").cloudflared.installed, false);
  assert.deepEqual(parseListOutput("").cloudRoutes, []);
});

t("凭证参数回显必须脱敏", () => {
  assert.equal(redactSecrets(["cftunnel", "init", "--token", "SECRET123", "--account", "acc"]), "cftunnel init --token *** --account acc");
  assert.equal(redactSecrets(["cftunnel", "relay", "init", "--server", "1.2.3.4:7000", "--token", "abc"]), "cftunnel relay init --server 1.2.3.4:7000 --token ***");
  assert.equal(redactSecrets(["cftunnel", "add", "x", "3000", "--auth", "u:p"]), "cftunnel add x 3000 --auth ***");
  assert.equal(redactSecrets(["cftunnel", "status"]), "cftunnel status");
  assert.equal(redactSecrets(["cftunnel", "--token"]), "cftunnel --token");
  assert.equal(redactSecrets(null), "");
});

t("自愈判定：不该动的场景一律 skip", () => {
  assert.equal(healDecision({ desired: false, autoHeal: true, alive: false }), "skip");
  assert.equal(healDecision({ desired: true, autoHeal: false, alive: false }), "skip");
  assert.equal(healDecision({ desired: true, autoHeal: true, alive: true }), "skip");
  assert.equal(healDecision({ desired: true, autoHeal: true, alive: null }), "skip"); // 实况未知不下手
  assert.equal(healDecision({ desired: true, autoHeal: true, alive: false, busy: true }), "skip");
  assert.equal(healDecision(), "skip");
});

t("自愈判定：真掉线才重连，连续失败到头就放弃", () => {
  assert.equal(healDecision({ desired: true, autoHeal: true, alive: false, failures: 0 }), "heal");
  assert.equal(healDecision({ desired: true, autoHeal: true, alive: false, failures: 4, maxFails: 5 }), "heal");
  assert.equal(healDecision({ desired: true, autoHeal: true, alive: false, failures: 5, maxFails: 5 }), "giveup");
  assert.equal(healDecision({ desired: true, autoHeal: true, alive: false, failures: 9, maxFails: 5 }), "giveup");
});

t("隧道健康判定：pid 锁陈旧也能识破", () => {
  // 真实样本：relay check 的 JSON 没有 total，只有 passed/failed
  assert.equal(tunnelHealthFromCheck({ frpcRunning: true, passed: 0, failed: 1 }), "down");
  assert.equal(tunnelHealthFromCheck({ frpcRunning: false, passed: 1, failed: 0 }), "down");
  // 真通
  assert.equal(tunnelHealthFromCheck({ frpcRunning: true, passed: 1, failed: 0 }), "up");
  // 没有规则可判 → 不冤枉
  assert.equal(tunnelHealthFromCheck({ frpcRunning: true, passed: 0, failed: 0 }), "unknown");
  assert.equal(tunnelHealthFromCheck({ frpcRunning: true }), "unknown");
  // 解析不出
  assert.equal(tunnelHealthFromCheck(null), "unknown");
  assert.equal(tunnelHealthFromCheck("x"), "unknown");
});

t("自愈节流：平时廉价、每 N 次全链路", () => {
  assert.equal(isDeepCheckTick(10, 10), true);
  assert.equal(isDeepCheckTick(20, 10), true);
  assert.equal(isDeepCheckTick(1, 10), false);
  assert.equal(isDeepCheckTick(11, 10), false);
  assert.equal(isDeepCheckTick(0, 10), true);
  assert.equal(isDeepCheckTick(NaN, 10), true);
  assert.equal(isDeepCheckTick(5, 0), true);
});

console.log(`\n${pass} 项通过${process.exitCode ? "，有失败" : "，全部通过"}`);