// @magpie-community/page-github-proxy
//
// 两件事：
//   1. 作为 OpenCode v1 插件被 magpie 的 Bun 宿主加载（不注册供应商，只借宿主的进程）。
//   2. 加载时在 127.0.0.1 上起一个本地服务：页面把自己导航过去，界面与 API 都在那里。
//
// 为什么要宿主这一层：magpie 的插件页面是 sandbox="allow-scripts" 的框架，
// CSP 的 connect-src 是 'none'，页面自己发不了请求、也改不了 magpie 的配置；
// 只有宿主进程（Bun）能读写 settings.json、调 git、写用户环境变量。

import { startServer, optionsFor, DEFAULT_PORT } from "./lib/server.mjs";
import { defaultConfigDir } from "./lib/config.mjs";
import { scheduleEnsureMirrorEnv } from "./lib/hook.mjs";

const configDir = process.env.MAGPIE_GITHUB_PROXY_CONFIG || defaultConfigDir();

let current = null;
let autoApply = true;

async function boot(port) {
  const info = await startServer({ port, configDir, gitPath: process.env.MAGPIE_GITHUB_PROXY_GIT || "" });
  current = info;
  console.log(`[page-github-proxy] 打开 magpie → 侧边栏「GitHub 代理」，或直接访问 ${info.url}`);
  return info;
}

const envPort = Number(process.env.MAGPIE_GITHUB_PROXY_PORT);
const firstPort = envPort > 0 ? envPort : DEFAULT_PORT;

// 宿主一加载就把端口占上：页面 900 毫秒后就会导航过来，这里不能等读文件。
const early = boot(firstPort).catch((err) => {
  console.error("[page-github-proxy] 服务没起来:", err?.message || err);
  return null;
});

const started = (async () => {
  const info = await early;
  let port = firstPort;
  try {
    const opts = await optionsFor(configDir);
    if (Number(opts?.port) > 0) port = Number(opts.port);
    if (opts?.autoApply === false) autoApply = false;
  } catch {
    /* 读不到 plugins.json 就用默认端口 */
  }
  if (envPort > 0) port = envPort;
  // 不看页面也能起作用的那一半：magpie 一起来就把「前缀变量在不在这个进程里」对上。
  // 变量没开 / 已经生效 / 刚重启过，都什么也不做。
  if (autoApply) scheduleEnsureMirrorEnv({ delayMs: 8000 });
  if (!info) {
    try {
      return await boot(port);
    } catch (err) {
      console.error("[page-github-proxy] 换端口再试也没起来:", err?.message || err);
      return null;
    }
  }
  if (port !== info.port) {
    try {
      await info.close();
    } catch {
      /* 关不掉就直接换 */
    }
    try {
      return await boot(port);
    } catch (err) {
      console.error("[page-github-proxy] 换到 " + port + " 没成功:", err?.message || err);
      return info;
    }
  }
  return info;
})();

// magpie 会把每个导出的函数当成一个插件调用；这里用 OpenCode v1 的形式只给服务器。
export default {
  id: "page-github-proxy",
  server: async (input, options) => {
    await started.catch(() => null);
    const want = Number(options?.port);
    if (Number.isFinite(want) && want > 0 && current && want !== current.port) {
      try {
        await current.close();
      } catch {
        /* 关不掉就直接换 */
      }
      try {
        await boot(want);
      } catch (err) {
        console.error("[page-github-proxy] 换端口失败:", err?.message || err);
      }
    }
    return {};
  },
};
