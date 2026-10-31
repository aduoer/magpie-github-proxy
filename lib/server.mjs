// 插件在 127.0.0.1 上起的小服务：页面的真界面由它提供，
// 页面里能做的三件事——读状态、写配置、自检——都从这里的 /api/* 出去。
//
// 为什么要这一层：magpie 的插件页面跑在 sandbox="allow-scripts" 的框架里，
// CSP 里 connect-src 是 'none'，不能发任何请求，也不能用存储；
// 唯一允许的联网动作是把自身导航到别处（文档明说）。所以那个页面只负责
// 把自己导航到 http://127.0.0.1:<port>/，界面和 API 都在本服务的 origin 上。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfigDir, paths, readSettings, patchSettings, pluginOptions } from "./config.mjs";
import { probeAll, probe, probePrefixAll, joinPrefix, TARGETS } from "./probe.mjs";
import { gitPath, gitEntries, applyGitProxy, clearGitProxy, testGit } from "./git.mjs";
import { readAllUserEnv, setUserEnv, delUserEnv } from "./userenv.mjs";
import { findApp, restartApp, restartLog, liveEnv } from "./restart.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UI = join(ROOT, "ui");
const PAGE = join(ROOT, "page");

const PLUGIN_NAMES = ["page-github-proxy", "@magpie-community/page-github-proxy"];
const DEFAULT_PORT = 3478;
const USER_ENV_NAMES = ["MAGPIE_MIRRORS", "MAGPIE_GITHUB_MIRROR", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"];

const log = (...a) => console.log("[github-proxy]", ...a);
const warn = (...a) => console.warn("[github-proxy]", ...a);

/** 页面与 API 的版本号，取自 package.json。 */
async function readVersion() {
  try {
    const doc = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    return doc.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/* ───────────────────────── 配置值的校验 ───────────────────────── */

const CLEAR_WORDS = /^(direct|off|none|no|不加|清空)$/i;

/** 把用户填的东西变成 magpie 认的代理地址。 */
export function normalizeProxy(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return { error: "先填个代理地址，例如 127.0.0.1:7897 或 socks5://127.0.0.1:1080" };
  if (CLEAR_WORDS.test(v)) return { value: "direct", clear: true, shown: "" };
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(v) ? v : "http://" + v;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { error: `这个地址不像代理：${v}` };
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(u.protocol)) {
    return { error: "代理只支持 http://、https://、socks5://、socks5h://" };
  }
  if (!u.hostname) return { error: "代理没有主机名" };
  if (!u.port) return { error: "代理要带端口，例如 127.0.0.1:7897" };
  const value = u.protocol + "//" + u.host + (u.pathname === "/" ? "" : u.pathname);
  return { value, shown: value };
}

/** 把用户填的东西变成镜像前缀。magpie 的做法是把 GitHub 原地址直接接在它后面。 */
export function normalizeMirror(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return { error: "先填个镜像地址，例如 https://ghfast.top 或 https://gh-proxy.com" };
  if (CLEAR_WORDS.test(v)) return { clear: true };
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(v) ? v : "https://" + v;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { error: `这个地址不像镜像：${v}` };
  }
  if (!/^https?:$/.test(u.protocol)) return { error: "镜像要是 http(s) 地址" };
  if (!u.hostname || !u.hostname.includes(".")) return { error: "镜像要是个完整域名，例如 ghfast.top" };
  const base = (u.protocol + "//" + u.host + u.pathname).replace(/\/+$/, "");
  return { base, updateMirror: base + "/", envBase: base };
}

/* ───────────────────────── 状态 ───────────────────────── */

function firstProxyFromEnv(env) {
  for (const k of ["MAGPIE_HTTPS_PROXY", "MAGPIE_HTTP_PROXY", "MAGPIE_ALL_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    const v = String(env[k] || "").trim();
    if (v) return { key: k, value: v };
  }
  return null;
}

/** 现在实际在用的前缀：运行中的 magpie 读到的 > 用户环境变量 > updateMirror。 */
async function currentPrefix(ctx) {
  const live = liveEnv();
  const liveBase = String(live.base || "").trim();
  if (liveBase) return liveBase;
  if (live.mirrorsOn) return "https://gh-proxy.com";
  const userEnv = await readAllUserEnv(["MAGPIE_GITHUB_MIRROR"]);
  const envBase = String(userEnv.MAGPIE_GITHUB_MIRROR || "").trim();
  if (envBase) return envBase;
  try {
    const s = await readSettings(ctx.configDir);
    const m = String(s.updateMirror || "").trim();
    if (m) return m.replace(/\/+$/, "");
  } catch {
    /* 读不到 settings.json 就没前缀可报 */
  }
  return "";
}

async function collectState(ctx) {
  const p = paths(ctx.configDir);
  let settings = {};
  let settingsError = "";
  try {
    settings = await readSettings(ctx.configDir);
  } catch (err) {
    settingsError = err.message;
  }
  const git = (await gitPath(ctx.gitOverride)) || null;
  const live = liveEnv();
  const [gitHosts, userEnv, version, app] = await Promise.all([
    git ? gitEntries(git) : Promise.resolve([]),
    readAllUserEnv(USER_ENV_NAMES),
    readVersion(),
    findApp(),
  ]);
  const hostProxy = firstProxyFromEnv(process.env);
  const settingsProxy = String(settings.proxy || "").trim();
  const route = settingsProxy && settingsProxy !== "direct" ? "settings" : hostProxy ? "environment" : "direct-or-system";
  return {
    version,
    platform: process.platform,
    configDir: ctx.configDir,
    paths: p,
    port: ctx.port,
    settings: {
      proxy: settingsProxy,
      proxyCustom: String(settings.proxyCustom || ""),
      updateMirror: String(settings.updateMirror || ""),
      chinaMirror: Boolean(settings.chinaMirror),
      error: settingsError,
    },
    route: {
      source: route,
      proxy: route === "settings" ? settingsProxy : route === "environment" ? hostProxy.value : "",
      hostProxy,
    },
    // 前缀通道的两半：updateMirror 立即生效；MAGPIE_MIRRORS 只对下次启动的 magpie 生效
    mirror: {
      update: String(settings.updateMirror || ""),
      envMirrors: String(userEnv.MAGPIE_MIRRORS || ""),
      envBase: String(userEnv.MAGPIE_GITHUB_MIRROR || ""),
      live: { on: live.mirrorsOn, raw: live.mirrors, base: live.base },
      chinaMirror: Boolean(settings.chinaMirror),
      defaultBase: "https://gh-proxy.com",
    },
    live,
    app,
    prefixInUse: await currentPrefix(ctx),
    prefixTargets: TARGETS.filter((t) => !t.rootOnly).map((t) => ({ id: t.id, name: t.name, url: t.url, what: t.what })),
    restart: restartLog(8),
    userEnv,
    git: { binary: git, hosts: gitHosts, override: ctx.gitOverride || "" },
    targets: TARGETS.map(({ id, name, url, what }) => ({ id, name, url, what })),
  };
}

/* ───────────────────────── 写配置 ───────────────────────── */

async function applyChanges(ctx, body) {
  const steps = [];
  const git = await gitPath(ctx.gitOverride);
  let touchedSettings = false;
  const patch = {};

  if (body.proxy !== undefined) {
    const n = normalizeProxy(body.proxy);
    if (n.error) return { status: 400, steps: [{ step: "代理", ok: false, message: n.error }] };
    if (n.clear) {
      patch.proxy = undefined;
      steps.push({ step: "magpie · 代理", ok: true, message: "已清空，magpie 改为跟随环境变量/系统代理" });
    } else {
      patch.proxy = n.value;
      patch.proxyCustom = n.value;
      steps.push({ step: "magpie · 代理", ok: true, message: `settings.proxy = ${n.value}（magpie 自身所有请求立即走它）` });
    }
    touchedSettings = true;
  }

  if (body.mirror !== undefined) {
    const n = normalizeMirror(body.mirror);
    if (n.error) return { status: 400, steps: [{ step: "镜像", ok: false, message: n.error }] };
    if (n.clear) {
      patch.updateMirror = undefined;
      steps.push({ step: "magpie · 更新镜像", ok: true, message: "已清空 updateMirror" });
    } else {
      patch.updateMirror = n.updateMirror;
      steps.push({ step: "magpie · 更新镜像", ok: true, message: `settings.updateMirror = ${n.updateMirror}（应用更新的下载立即走它）` });
    }
    touchedSettings = true;
  }

  if (touchedSettings) {
    try {
      const r = await patchSettings(ctx.configDir, patch);
      if (!r.changed) steps.push({ step: "settings.json", ok: true, message: "本来就是这个值，没动文件" });
      else steps.push({ step: "settings.json", ok: true, message: `已写入 ${r.path}（magpie 会立即重读）` });
    } catch (err) {
      steps.push({ step: "settings.json", ok: false, message: err.message });
    }
  }

  if (body.mirror !== undefined && body.userEnvMirror !== undefined && !normalizeMirror(body.mirror).error) {
    const n = normalizeMirror(body.mirror);
    if (body.userEnvMirror) {
      if (n.clear) {
        steps.push({ step: "用户环境变量 · MAGPIE_MIRRORS", ...(await delUserEnv("MAGPIE_MIRRORS")) });
        steps.push({ step: "用户环境变量 · MAGPIE_GITHUB_MIRROR", ...(await delUserEnv("MAGPIE_GITHUB_MIRROR")) });
        steps.push({ step: "前缀通道 · 生效时间", ok: true, message: "重启 magpie 后，插件市场/安装/Skill/MCP 才回到只用官方地址" });
      } else {
        steps.push({ step: "用户环境变量 · MAGPIE_MIRRORS", ...(await setUserEnv("MAGPIE_MIRRORS", "on")) });
        steps.push({ step: "用户环境变量 · MAGPIE_GITHUB_MIRROR", ...(await setUserEnv("MAGPIE_GITHUB_MIRROR", n.envBase)) });
        steps.push({
          step: "前缀通道 · 生效时间",
          ok: true,
          message: "应用更新/更新包已经生效；插件市场、插件安装、Skill、MCP 要重启 magpie（它启动时读这两个变量）",
        });
      }
    } else if (body.userEnvMirror === false) {
      steps.push({ step: "用户环境变量 · MAGPIE_MIRRORS", ...(await delUserEnv("MAGPIE_MIRRORS")) });
      steps.push({ step: "用户环境变量 · MAGPIE_GITHUB_MIRROR", ...(await delUserEnv("MAGPIE_GITHUB_MIRROR")) });
    }
  }

  if (body.envProxy !== undefined) {
    const n = body.proxy !== undefined ? normalizeProxy(body.proxy) : null;
    if (body.envProxy) {
      const target = n && !n.clear && !n.error ? n.value : null;
      if (!target) {
        steps.push({ step: "用户环境变量 · HTTPS_PROXY", ok: false, message: "要先填一个代理地址才能写进环境变量" });
      } else {
        steps.push({ step: "用户环境变量 · HTTPS_PROXY", ...(await setUserEnv("HTTPS_PROXY", target)) });
        steps.push({ step: "用户环境变量 · ALL_PROXY", ...(await setUserEnv("ALL_PROXY", target)) });
        steps.push({ step: "用户环境变量 · NODE_USE_ENV_PROXY", ...(await setUserEnv("NODE_USE_ENV_PROXY", "1")) });
        steps.push({ step: "环境变量生效时间", ok: true, message: "只影响新启动的进程（magpie 重启后，以及它拉起的 git、bun、npx）" });
      }
    } else {
      for (const name of ["HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"]) {
        steps.push({ step: `用户环境变量 · ${name}`, ...(await delUserEnv(name)) });
      }
    }
  }

  if (body.git === "apply") {
    if (!git) {
      steps.push({ step: "git 通道", ok: false, message: "找不到 git（PATH 里没有，插件选项 gitPath 可指定）" });
    } else if (body.proxy !== undefined) {
      const n = normalizeProxy(body.proxy);
      if (n.error) steps.push({ step: "git 通道", ok: false, message: n.error });
      else if (n.clear) steps.push(...(await clearGitProxy(git)));
      else steps.push(...(await applyGitProxy(n.value, git)));
    } else {
      const cur = normalizeProxy((await readSettings(ctx.configDir)).proxy || "");
      if (cur.error || cur.clear) steps.push({ step: "git 通道", ok: false, message: "magpie 里还没有代理，先设代理再写 git" });
      else steps.push(...(await applyGitProxy(cur.value, git)));
    }
  } else if (body.git === "clear") {
    if (!git) steps.push({ step: "git 通道", ok: false, message: "找不到 git" });
    else steps.push(...(await clearGitProxy(git)));
  }

  if (body.restart) {
    const app = await findApp({ fresh: true });
    if (!app.found) {
      steps.push({ step: "重启 magpie", ok: false, message: app.why || "没找到 magpie 进程" });
    } else {
      // 注册表里的用户环境变量不会自动进重启后的进程，这里按刚写好的值直接交给它
      const env = await readAllUserEnv(USER_ENV_NAMES);
      const r = await restartApp(app, { delayMs: body.restartDelayMs || 900, env });
      steps.push({
        step: "重启 magpie",
        ok: Boolean(r.ok),
        message: r.ok
          ? `一秒后关掉并重新打开 ${app.exe}（旧进程 pid ${r.pid}，本窗口会断开，重开 magpie 后回到这一页就能看到结果）`
          : r.error || "重启失败，自己关掉 magpie 再打开也一样",
      });
    }
  }

  return { status: 200, steps };
}

/* ───────────────────────── HTTP ───────────────────────── */

const CSP =
  "default-src 'self'; base-uri 'none'; form-action 'none'; img-src 'self' data:; " +
  // connect-src 放开回环口：服务换端口后，页面要靠 /api/health 在 3478~3497 里找到现在谁在跑
  "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:*";

function send(res, status, body, type = "application/json; charset=utf-8") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 65536) {
        reject(new Error("请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求体不是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function originAllowed(ctx, req) {
  const origin = req.headers.origin;
  // 这个界面的 origin 就是本服务；沙盒框架的 opaque origin 记作 null。
  // 没有 Origin 的（命令行、调试）由下面的 x-magpie-page 标记把关。
  if (origin === undefined || origin === "null") return true;
  const host = (req.headers.host || `127.0.0.1:${ctx.port}`).toLowerCase();
  return origin.toLowerCase() === `http://${host}`;
}

const STATIC = {
  "/": { file: join(UI, "index.html"), type: "text/html; charset=utf-8" },
  "/index.html": { file: join(UI, "index.html"), type: "text/html; charset=utf-8" },
  "/app.js": { file: join(UI, "app.js"), type: "text/javascript; charset=utf-8" },
  "/app.css": { file: join(UI, "app.css"), type: "text/css; charset=utf-8" },
  "/icon.svg": { file: join(PAGE, "icon.svg"), type: "image/svg+xml" },
};

export async function startServer({ port = DEFAULT_PORT, configDir, gitPath: gitOverride } = {}) {
  const ctx = {
    port,
    configDir: configDir || defaultConfigDir(),
    gitOverride: gitOverride || "",
  };

  const handler = async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${ctx.port}`);
    const path = url.pathname;

    try {
      // 这个页面有四种处境：直接开（同源）、magpie 里的沙盒框架（opaque origin，Origin: null）、
      // 换过端口后被旧页面跨源找到、命令行。前两种里，带 x-magpie-page 的 JSON POST 属于
      // 「非简单请求」，浏览器会先发 OPTIONS 预检；不答预检，页面就只会得到 Failed to fetch。
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader("access-control-allow-origin", origin === "null" ? "*" : origin);
        res.setHeader("vary", "origin");
      }

      if (path.startsWith("/api/")) {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type, x-magpie-page",
            "access-control-max-age": "600",
            "cache-control": "no-store",
          });
          res.end();
          return;
        }

        if (req.method === "GET" && path === "/api/health") {
          // 页面偶尔会落在旧端口上（服务换端口、magpie 重启），需要一个能从任何端口问
          // 「现在到底谁在跑、在哪」的探针，所以这条只回端口号，允许跨源读。
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ ok: true, port: ctx.port, pid: process.pid }));
          return;
        }

        if (req.method !== "POST") return send(res, 405, { error: "只接受 POST" });
        if (!originAllowed(ctx, req)) return send(res, 403, { error: "拒绝跨站请求" });
        if (req.headers["x-magpie-page"] !== "github-proxy") return send(res, 403, { error: "缺少页面标记" });

        const body = await readBody(req);

        if (path === "/api/state") return send(res, 200, await collectState(ctx));

        if (path === "/api/apply") {
          const out = await applyChanges(ctx, body || {});
          let state = null;
          try {
            state = await collectState(ctx);
          } catch {
            /* 状态读不到就把步骤单独给出去 */
          }
          return send(res, out.status, { steps: out.steps, state });
        }

        if (path === "/api/test") {
          const target = String(body?.target || "all");
          const proxy = String(body?.proxy || "").trim();
          const prefix = String(body?.prefix || "").trim();
          const only = body?.only || "both";

          if (target === "prefix") {
            const want = prefix || (await currentPrefix(ctx));
            if (!want) return send(res, 200, { rows: [], prefix: "", error: "还没有前缀可测：先在上面填一个镜像站" });
            const rows = await probePrefixAll(want, { timeoutMs: 30000 });
            return send(res, 200, { rows, prefix: want });
          }

          const list = target === "all" ? TARGETS : TARGETS.filter((t) => t.id === target);
          const rows = await Promise.all(
            list.map(async (t) => {
              const [direct, viaProxy] = await Promise.all([
                only === "via" ? null : probe(t.url, { timeoutMs: 12000 }),
                !proxy || only === "direct" ? null : probe(t.url, { proxy, timeoutMs: 12000 }),
              ]);
              return { ...t, direct, viaProxy };
            }),
          );
          return send(res, 200, { rows, proxy });
        }

        if (path === "/api/restart") {
          const app = await findApp({ fresh: true });
          if (!app.found) return send(res, 200, { ok: false, app, error: app.why || "没找到 magpie 进程" });
          const env = body?.env === false ? null : await readAllUserEnv(USER_ENV_NAMES);
          const r = await restartApp(app, { delayMs: body?.delayMs || 900, env });
          return send(res, 200, { ...r, app });
        }

        if (path === "/api/app") {
          return send(res, 200, { app: await findApp({ fresh: true }), live: liveEnv() });
        }

        if (path === "/api/git/test") {
          const git = await gitPath(ctx.gitOverride);
          if (!git) return send(res, 200, { ok: false, error: "找不到 git" });
          return send(res, 200, await testGit(git));
        }

        return send(res, 404, { error: "没有这个接口" });
      }

      const entry = STATIC[path];
      if (!entry) return send(res, 404, "not found", "text/plain; charset=utf-8");
      const data = await readFile(entry.file);
      res.writeHead(200, {
        "content-type": entry.type,
        "cache-control": "no-store",
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      return res.end(data);
    } catch (err) {
      warn("请求失败", path, err?.message || err);
      if (!res.headersSent) send(res, 500, { error: String(err?.message || err) });
      else res.end();
    }
  };

  const makeServer = () =>
    createServer((req, res) => {
      handler(req, res).catch((err) => {
        warn("handler 出错", err?.message || err);
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err?.message || err) }));
        } catch {
          /* 已经回了 */
        }
      });
    });

  const bind = (srv, p) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        srv.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        srv.removeListener("error", onError);
        resolve(p);
      };
      srv.once("error", onError);
      srv.once("listening", onListening);
      srv.listen(p, "127.0.0.1");
    });

  const closeServer = (srv) =>
    new Promise((r) => {
      try {
        srv.close(() => r(null));
      } catch {
        r(null);
      }
    });

  /** 在 want 起，被占就顺延。每起一个都记下来，旧端口不急着关。 */
  const listeners = new Map();
  const listenOn = async (p) => {
    const srv = makeServer();
    const got = await bind(srv, p);
    listeners.set(got, srv);
    return got;
  };

  const startOn = async (want) => {
    for (let i = 0; i < 20; i++) {
      try {
        return await listenOn(want + i);
      } catch (err) {
        if (err?.code !== "EADDRINUSE") throw err;
        log(`端口 ${want + i} 被占用，试下一个`);
      }
    }
    throw new Error(`127.0.0.1:${want}~${want + 19} 都占着`);
  };

  /** 只留最近几个端口：页面可能还开着旧地址，关早了一片白。 */
  const pruneAliases = async (keep) => {
    const extra = [...listeners.keys()].filter((p) => p !== keep);
    while (extra.length > 2) {
      const p = extra.shift();
      const srv = listeners.get(p);
      listeners.delete(p);
      await closeServer(srv);
      log(`关掉旧端口 ${p}`);
    }
  };

  let livePort = await startOn(port);
  ctx.port = livePort;
  log(`监听 http://127.0.0.1:${livePort}  配置目录 ${ctx.configDir}`);

  // 首选端口被占（magpie 的 CLI 也会短暂加载插件宿主），空出来就补上，
  // 但**不关旧端口**：已经打开的页面还在旧地址上，关掉它只会得到 Failed to fetch。
  const hunter = setInterval(async () => {
    if (listeners.has(port)) return;
    try {
      const got = await listenOn(port);
      ctx.port = got;
      log(`补上首选端口 ${got}（${[...listeners.keys()].join(", ")} 都在听）`);
      await pruneAliases(got);
    } catch {
      /* 还被别人占着，下一次再试 */
    }
  }, 4000);
  hunter.unref?.();

  return {
    get port() {
      return ctx.port;
    },
    get ports() {
      return [...listeners.keys()];
    },
    get url() {
      return `http://127.0.0.1:${ctx.port}/`;
    },
    configDir: ctx.configDir,
    pid: process.pid,
    close: async () => {
      clearInterval(hunter);
      const all = [...listeners.values()];
      listeners.clear();
      await Promise.all(all.map((srv) => closeServer(srv)));
    },
  };
}

/** 按 plugins.json 里的 options.port 换端口用。 */
export async function optionsFor(configDir) {
  return pluginOptions(configDir, PLUGIN_NAMES);
}

export { DEFAULT_PORT, PLUGIN_NAMES };
