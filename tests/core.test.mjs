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

console.log(`\n${pass} 项通过${process.exitCode ? "，有失败" : "，全部通过"}`);
