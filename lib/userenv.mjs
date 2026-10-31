// Windows 的用户环境变量（HKCU\Environment）。
//
// magpie 读 MAGPIE_MIRRORS / MAGPIE_GITHUB_MIRROR 是在发请求时现读的，
// 但那是 magpie 自己的进程环境，插件改不了；写进用户环境变量以后，
// 下次启动的 magpie（以及它拉起来的 git、bun、agent CLI）才会带上。

import { run } from "./git.mjs";

const isWindows = process.platform === "win32";

/** 读一个用户环境变量；没有时返回 ""。 */
export async function readUserEnv(name) {
  if (!isWindows) return "";
  const r = await run("reg", ["query", "HKCU\\Environment", "/v", name], { timeoutMs: 8000 });
  if (r.code !== 0) return "";
  const line = r.out.split(/\r?\n/).find((l) => l.trim().toLowerCase().startsWith(name.toLowerCase()));
  if (!line) return "";
  const parts = line.trim().split(/\s{2,}/);
  return (parts[parts.length - 1] || "").trim();
}

/** 写一个用户环境变量（REG_SZ）。 */
export async function setUserEnv(name, value) {
  if (!isWindows) return { ok: false, message: "只有 Windows 才有这一步（$HOME 下的 shell 请自己 export）" };
  const r = await run("reg", ["add", "HKCU\\Environment", "/v", name, "/t", "REG_SZ", "/d", value, "/f"], { timeoutMs: 8000 });
  return { ok: r.code === 0, message: r.code === 0 ? "已写入用户环境变量" : (r.err || r.out || `reg 退出码 ${r.code}`).trim() };
}

/** 删一个用户环境变量。 */
export async function delUserEnv(name) {
  if (!isWindows) return { ok: true, message: "非 Windows，跳过" };
  const r = await run("reg", ["delete", "HKCU\\Environment", "/v", name, "/f"], { timeoutMs: 8000 });
  return { ok: r.code === 0 || r.code === 1, message: r.code === 0 ? "已删除" : "本来就没有" };
}

/** 一次读齐插件关心的几项。 */
export async function readAllUserEnv(names) {
  const out = {};
  for (const n of names) out[n] = await readUserEnv(n);
  return out;
}
