// git 通道：magpie 装 git 型 Skill 时直接调 git，gitEnv() 只给
// os.Environ() 加几项，不注入 netproxy.Env，所以 git 不会走 magpie 设置里的代理。
// 这里改 git 自己的全局配置，只给 GitHub 的几个域名加代理，别的不动。

import { spawn } from "node:child_process";

/** 只给这几个域名加代理，其余 remote 一概不碰。 */
export const GIT_HOSTS = [
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "gist.githubusercontent.com",
];

const GIT_TIMEOUT = 20000;

/** git 里给某个域名用的配置键；带斜杠是 git 文档里的写法，按 URL 前缀匹配。 */
export function keyFor(host) {
  return `http.https://${host}/.proxy`;
}

/** 老写法（不带斜杠）也一并认，免得界面上显示「未设置」其实设着。 */
function keysFor(host) {
  return [keyFor(host), `http.https://${host}.proxy`];
}


/** 跑一条命令，超时就杀掉。 */
export function run(cmd, args, { timeoutMs = GIT_TIMEOUT, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, windowsHide: true, shell: false });
    } catch (err) {
      resolve({ code: -1, out: "", err: String(err?.message || err), timedOut: false, missing: true });
      return;
    }
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (out.length < 65536) out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (err.length < 65536) err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + String(e?.message || e), timedOut, missing: e?.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err, timedOut });
    });
  });
}

/** git 在哪。 */
export async function gitPath(custom) {
  if (custom) {
    const r = await run(custom, ["--version"], { timeoutMs: 8000 });
    if (r.code === 0) return custom;
  }
  const r = await run("git", ["--version"], { timeoutMs: 8000 });
  return r.code === 0 ? "git" : null;
}

/** 现在这几个域名上各自的代理配置。 */
export async function gitEntries(git = "git") {
  const r = await run(git, ["config", "--global", "--get-regexp", "\\.proxy$"], { timeoutMs: 10000 });
  const map = new Map();
  if (r.code === 0) {
    for (const line of r.out.split(/\r?\n/)) {
      const m = line.match(/^(http\.https:\/\/([^/]+?)\/?\.proxy)\s+(.+)$/);
      if (m) map.set(m[2], { key: m[1], proxy: m[3].trim() });
    }
  }
  return GIT_HOSTS.map((host) => ({ host, ...(map.get(host) || { key: keyFor(host), proxy: "" }) }));
}

/** 给这几个域名设上代理。 */
export async function applyGitProxy(proxy, git = "git") {
  const steps = [];
  for (const host of GIT_HOSTS) {
    const r = await run(git, ["config", "--global", keyFor(host), proxy], { timeoutMs: 10000 });
    steps.push({
      step: `git · ${host}`,
      ok: r.code === 0,
      message: r.code === 0 ? "已写入 git 全局配置" : (r.err || r.out || `git 退出码 ${r.code}`).trim(),
    });
  }
  return steps;
}

/** 把这几个域名上的代理配置删掉。 */
export async function clearGitProxy(git = "git") {
  const steps = [];
  for (const host of GIT_HOSTS) {
    let ok = true;
    let message = "本来就没设";
    let deleted = false;
    for (const key of keysFor(host)) {
      const r = await run(git, ["config", "--global", "--unset-all", key], { timeoutMs: 10000 });
      // 退出码 5 是「这个键本来就没有」
      if (r.code === 0) deleted = true;
      else if (r.code !== 5) {
        ok = false;
        message = (r.err || r.out || `git 退出码 ${r.code}`).trim();
      }
    }
    if (ok && deleted) message = "已删除";
    steps.push({ step: `git · ${host}`, ok, message });
  }
  return steps;
}

/** 真的用 git 去问一次 GitHub：magpie 装 git 型 Skill 时走的就是这条路。 */
export async function testGit(git = "git", timeoutMs = 25000) {
  const used = await run(git, ["config", "--global", "--get-urlmatch", "http.proxy", "https://github.com/yetone/magpie"], { timeoutMs: 8000 });
  const proxy = used.code === 0 ? used.out.trim() : "";
  const started = Date.now();
  const r = await run(git, ["ls-remote", "--heads", "https://github.com/yetone/magpie"], { timeoutMs });
  const ms = Date.now() - started;
  if (r.timedOut) return { ok: false, ms, proxy, error: `超时 ${timeoutMs}ms` };
  if (r.code !== 0)
    return {
      ok: false,
      ms,
      proxy,
      error: (r.err || r.out || `git 退出码 ${r.code}`).trim().split(/\r?\n/).slice(-3).join(" "),
    };
  return { ok: true, ms, proxy, refs: r.out.split(/\r?\n/).filter(Boolean).length };
}
