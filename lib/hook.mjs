// 「让 magpie 自己走镜像前缀」这件事有个绕不过去的物理事实：
//
//   internal/source/source.go 的 Enabled() / githubBase() 每次都读 **进程环境**
//   （MAGPIE_MIRRORS、MAGPIE_GITHUB_MIRROR），而 Windows 没有办法改一个已经在跑的进程的环境。
//
// 所以「在 magpie 里设置镜像源」= 变量写进用户环境 + 让 magpie 带着它启动。这个函数就是后半句：
// 宿主每次被 magpie 拉起时看一眼「变量写了吗 / 现在这个 magpie 读到了吗」，没读到就替用户重启一次，
// 变量直接放进新进程（不依赖启动器会不会传），有冷却时间，绝不反复重启。
//
// 它不需要页面、不需要端口、不需要人点：magpie 一起来就自己修好。

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAllUserEnv } from "./userenv.mjs";
import { findApp, liveEnv, restartApp } from "./restart.mjs";

const MARK = join(tmpdir(), "magpie-github-proxy-hook.json");
const COOLDOWN_MS = 30 * 60 * 1000;
const ON = /^(on|true|1|cn)$/i;

function readMark() {
  try {
    const j = JSON.parse(readFileSync(MARK, "utf8"));
    return Number(j?.at) > 0 ? j : null;
  } catch {
    return null;
  }
}

function writeMark(info) {
  try {
    writeFileSync(MARK, JSON.stringify({ at: Date.now(), ...info }), "utf8");
  } catch {
    /* 写不了就算了，冷却只是保险 */
  }
}

/**
 * 需要时把 magpie 重启一次，让它带上镜像变量。
 * @returns {Promise<{action: "skip"|"restart"|"fail", why?: string, ...}>}
 */
export async function ensureMirrorEnv({ delayMs = 800, waitMs = 6000, dryRun = false } = {}) {
  const env = await readAllUserEnv(["MAGPIE_MIRRORS", "MAGPIE_GITHUB_MIRROR"]);
  if (!ON.test(String(env.MAGPIE_MIRRORS || "").trim())) {
    return { action: "skip", why: "用户环境里没有 MAGPIE_MIRRORS=on（前缀通道没开）" };
  }

  const live = liveEnv();
  if (live.mirrorsOn && live.base) {
    return { action: "skip", why: `当前 magpie 已经读到前缀 ${live.base}` };
  }

  const mark = readMark();
  if (mark && Date.now() - mark.at < COOLDOWN_MS) {
    const ago = Math.round((Date.now() - mark.at) / 1000);
    return { action: "skip", why: `${ago} 秒前刚重启过一次（${mark.why || "同上"}），${Math.round((COOLDOWN_MS - (Date.now() - mark.at)) / 1000)} 秒后再看` };
  }

  const app = await findApp({ fresh: true });
  if (!app?.found) {
    return { action: "fail", why: app?.why || "没找到 magpie 的界面进程，没法重启" };
  }

  const payload = { ...env };
  if (dryRun) {
    return { action: "restart", dryRun: true, app, env: payload, why: "试运行：只报告将要做什么" };
  }

  writeMark({ why: `magpie ${app.pid} 没读到变量`, pid: app.pid });
  const out = await restartApp(app, { delayMs, env: payload });
  if (!out?.ok) {
    return { action: "fail", why: out?.error || "重启脚本没能跑起来", out };
  }
  // 新进程起来再确认一次；没读到就把冷却缩短，让下一次宿主加载再试
  await new Promise((r) => setTimeout(r, waitMs));
  const after = liveEnv();
  if (!(after.mirrorsOn && after.base)) {
    return { action: "fail", why: "重启完了，但新进程仍没读到变量（可能被别的启动器又拉起一次）", out, after };
  }
  return { action: "restart", from: app.pid, to: after.pid, base: after.base, out };
}

/** 后台跑，别挡住宿主启动 */
export function scheduleEnsureMirrorEnv(opts = {}) {
  const delay = Number(opts.delayMs) >= 0 ? Number(opts.delayMs) : 8000;
  const timer = setTimeout(() => {
    ensureMirrorEnv(opts)
      .then((r) => {
        if (r.action === "restart") console.log(`[page-github-proxy] 已让 magpie 带上前缀 ${r.base}（${r.from} → ${r.to}）`);
        else if (r.action === "fail") console.warn(`[page-github-proxy] 前缀没生效：${r.why}`);
        else console.log(`[page-github-proxy] 前缀检查：${r.why}`);
      })
      .catch((err) => console.warn(`[page-github-proxy] 前缀检查出错：${err?.message || err}`));
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
