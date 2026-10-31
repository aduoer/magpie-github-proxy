// 配置目录与 magpie 的配置文件读写。
//
// 桌面版 magpie 的窗口跑在 wails:// 上，插件宿主拿不到 HTTP 上的 /api，
// 所以这里只做一件事：像 magpie 自己那样读写 ~/.config/magpie/settings.json。
// magpie 的 settings.Load() 用 filememo 按内容记忆化，文件一变就重读，
// 因此写完立刻生效，不需要重启 magpie。

import { readFile, writeFile, rename, copyFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** magpie 放自己文件的地方：~/.config/magpie，便携版是 exe 旁边的 data。 */
export function defaultConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "magpie");
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, ".config", "magpie");
}

export function paths(configDir) {
  return {
    dir: configDir,
    settings: join(configDir, "settings.json"),
    plugins: join(configDir, "plugins.json"),
    updates: join(configDir, "plugin-updates.json"),
  };
}

/** 读 settings.json；没有文件时当作空对象。 */
export async function readSettings(configDir) {
  const p = paths(configDir).settings;
  let text;
  try {
    text = await readFile(p, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw new Error(`读不了 ${p}: ${err.message}`);
  }
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ""));
    return v && typeof v === "object" ? v : {};
  } catch (err) {
    throw new Error(`${p} 不是合法的 JSON（${err.message}），先修好它再让插件改`);
  }
}

/**
 * 改 settings.json 里的几个键：值为 undefined 表示删掉这个键。
 * 写之前留一份 settings.json.github-proxy.bak（只在还没有时写），
 * 再原子替换，避免 magpie 读到半个文件。
 */
export async function patchSettings(configDir, patch) {
  const p = paths(configDir).settings;
  const current = await readSettings(configDir);
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "") delete next[k];
    else next[k] = v;
  }
  const text = JSON.stringify(next, null, 2) + "\n";
  const before = JSON.stringify(current, null, 2) + "\n";
  if (text === before) return { changed: false, path: p, next };

  try {
    await stat(p);
    const bak = p + ".github-proxy.bak";
    try {
      await stat(bak);
    } catch {
      await copyFile(p, bak);
    }
  } catch {
    // 还没有 settings.json，不用备份
  }

  const tmp = p + ".tmp-" + process.pid;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, p);
  return { changed: true, path: p, next };
}

/**
 * plugins.json 里这个插件的 options。宿主启动得比选项注册早，
 * 所以端口这类东西从这里补读一次就够了。
 */
export async function pluginOptions(configDir, names) {
  const p = paths(configDir).plugins;
  let text;
  try {
    text = await readFile(p, "utf8");
  } catch {
    return {};
  }
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
  const list = Array.isArray(doc?.plugins) ? doc.plugins : [];
  for (const item of list) {
    const spec = String(item?.spec || "");
    if (names.some((n) => spec === n || spec.includes(n))) {
      return item?.options && typeof item.options === "object" ? item.options : {};
    }
  }
  return {};
}
