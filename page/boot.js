// 带路页：把框架导航到本插件宿主起的本地服务。
//
// 这里必须"带路"而不是画界面：magpie 的插件页面 CSP 是 connect-src 'none'，
// 页面里发不出任何请求（fetch/XHR/WebSocket 都被拦），也用不了存储；
// 文档明说页面唯一能做的联网动作是把自身导航到别处，那个 origin 接管这个框架。
// 所以真正的界面在 http://127.0.0.1:<port>/，由 lib/server.mjs 提供。
//
// 关键：**不许等**。以前这里 await window.magpie.ready / options.get()，
// 只要桥不回答（magpie 正在启动、宿主正在重启、桥的 hello 被拒），页面就永远停在
// 「正在连接本地服务…」，magpie 的看门狗随后报「此页面已停止工作／页面没有响应」。
// 现在两件事都带超时：读到了就带上主题与端口，读不到就 1.6 秒内照走默认端口 ——
// 界面自己会重试、会在端口变了的时候找回家。

(() => {
  const DEFAULT_PORT = 3478;
  const BUDGET_MS = 900;

  const say = (text) => {
    const el = document.getElementById("said");
    if (el) el.textContent = text;
  };

  let gone = false;

  const navigate = (port, theme, tokens) => {
    if (gone) return;
    gone = true;
    const q = new URLSearchParams();
    if (theme) q.set("theme", theme);
    if (tokens && typeof tokens === "object" && Object.keys(tokens).length) {
      try {
        q.set("tokens", JSON.stringify(tokens));
      } catch {
        /* 令牌带不过去就用默认外观 */
      }
    }
    q.set("_", String(Date.now())); // 带上时间戳，别让 WebView 用旧的界面缓存
    const query = q.toString();
    location.replace(`http://127.0.0.1:${port}/?${query}`);
  };

  const within = (value, ms) =>
    Promise.race([
      Promise.resolve(value).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);

  // 兜底：不管桥有没有回话，到点就走
  setTimeout(() => navigate(DEFAULT_PORT, "", null), BUDGET_MS);
  say("正在打开本地服务…");

  (async () => {
    let port = DEFAULT_PORT;
    let theme = "";
    let tokens = null;

    try {
      const t = await within(window.magpie?.ready, 400);
      if (t) {
        if (typeof t.dark === "boolean") theme = t.dark ? "dark" : "light";
        if (t.tokens && typeof t.tokens === "object") tokens = t.tokens;
      }
    } catch {
      /* 没有 bridge 也没关系，界面自己决定浅深色 */
    }

    try {
      const o = await within(window.magpie?.options?.get?.(), 300);
      if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port);
    } catch {
      /* 读不到选项就用默认端口 */
    }

    navigate(port, theme, tokens);
  })();
})();
