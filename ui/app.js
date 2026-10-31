// 界面逻辑：所有动作都通过本服务的 /api/* 走，宿主进程去做真正的事
// （写 settings.json、改 git 全局配置、写用户环境变量、发探测请求）。

const $ = (id) => document.getElementById(id);
const HEADERS = { "content-type": "application/json", "x-magpie-page": "github-proxy" };

let state = null;
let filled = { proxy: null, mirror: null };
let lastRead = 0;

/* ── 连接状态：magpie 重启时这一页会短暂断掉，不能让用户只看到 Failed to fetch ── */
let online = true;

function setOnline(on, detail) {
  const el = $("offline");
  if (on) {
    const wasDown = !online;
    online = true;
    if (el) el.hidden = true;
    if (wasDown) toast("已经连回本地服务", "ok");
    return;
  }
  online = false;
  if (!el) return;
  if (!el.hidden && el.dataset.shown === detail) return;
  el.dataset.shown = detail || "";
  el.hidden = false;
  el.innerHTML =
    `本地服务暂时没应答（${escapeHTML(detail || "连接断开")}）—— magpie 可能正在重启，` +
    `它回来后这一页会自己接上。 <button type="button" class="ghost" id="offline-retry">立刻重试</button>`;
  $("offline-retry").onclick = () => {
    el.dataset.shown = "";
    refresh({ quiet: true });
  };
}

/* ── 外观：从 query 里拿 magpie 的主题与令牌 ── */
(() => {
  const q = new URLSearchParams(location.search);
  const theme = q.get("theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
  else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) document.documentElement.dataset.theme = "dark";

  const raw = q.get("tokens");
  if (raw) {
    try {
      const tokens = JSON.parse(raw);
      for (const [k, v] of Object.entries(tokens || {})) {
        if (typeof v !== "string" || !v.trim()) continue;
        const name = k.startsWith("--") ? k : "--magpie-" + k;
        document.documentElement.style.setProperty(name, v.trim());
      }
    } catch {
      /* 令牌坏了就用默认配色 */
    }
  }
})();

/* ── 工具 ── */
function toast(message, kind = "") {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast" + (kind ? " " + kind : "");
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, kind === "bad" ? 9000 : 5200);
}

/** 自己这个地址没人应了：在已知端口段里问一遍 /api/health，谁应就跳到谁。 */
async function findHome() {
  const here = Number(location.port || 80);
  const ports = [];
  for (let p = 3478; p <= 3497; p += 1) if (p !== here) ports.push(p);
  const hits = await Promise.all(
    ports.map(async (p) => {
      try {
        const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined;
        const res = await fetch(`http://127.0.0.1:${p}/api/health`, { cache: "no-store", mode: "cors", signal: ctl });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        return data && data.ok ? p : null;
      } catch {
        return null;
      }
    })
  );
  return hits.find(Boolean) || null;
}

async function api(path, body, { tries = 3 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body || {}), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setOnline(true);
      return data;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }

  // 地址本身没了（magpie 重启、服务换了端口）：找找现在谁在跑，跳过去。
  const home = await findHome();
  if (home) {
    setOnline(false, "本地服务换了端口，正在跳过去…");
    location.replace(`http://127.0.0.1:${home}/${location.search || ""}`);
    return new Promise(() => {});
  }
  setOnline(false, lastErr?.message === "Failed to fetch" ? "本地服务没应答" : lastErr?.message);
  throw new Error(lastErr?.message === "Failed to fetch" ? "本地服务没应答（端口可能变了，刷新一下这一页）" : String(lastErr?.message || lastErr));
}

async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    if (button) button.disabled = false;
  }
}

function stepsText(steps) {
  return (steps || []).map((s) => `${s.ok ? "✓" : "✗"} ${s.step}：${s.message}`).join("\n");
}

/* ── 渲染 ── */

/** 「现在生效」：每条通道的值 + magpie 此刻真的会怎么走。 */
function renderNow() {
  const s = state.settings || {};
  const route = state.route || {};
  const m = state.mirror || {};
  const hosts = state.git?.hosts || [];
  const gitOn = hosts.filter((h) => h.proxy).length;
  const proxySet = Boolean(s.proxy && s.proxy !== "direct");
  const envProxy = String(route.hostProxy?.value || "");
  const envOn = /^(on|true|1|cn)$/i.test(String(m.envMirrors || ""));
  const liveOn = Boolean(m.live?.on);
  const liveBase = String(m.live?.base || "");
  const envBase = String(m.envBase || "");
  const update = String(m.update || "");
  const prefix = state.prefixInUse || "";

  const kind = (on) => (on ? "on" : on === null ? "warn" : "skip");
  const pill = (on, text) => `<span class="pill ${kind(on)}">${text}</span>`;

  const proxyNow = proxySet ? pill(true, "走代理") : route.source === "environment" ? pill(null, "走环境变量") : pill(false, "直连 / 系统代理");
  const prefixNow = liveOn
    ? pill(true, `已生效 · ${escapeHTML(liveBase || "https://gh-proxy.com")}`)
    : envOn
      ? pill(null, "变量已写，等重启 magpie")
      : pill(false, "未设置：只走官方");

  const rows = [
    ["代理通道", proxySet ? `<code>${escapeHTML(s.proxy)}</code>` : envProxy ? `<code>${escapeHTML(envProxy)}</code>（环境变量）` : "未设置", proxyNow, "立即", !proxySet && route.source !== "environment"],
    ["应用更新 / 下载更新包", update ? `<code>${escapeHTML(update)}</code>` : "未设置", update ? pill(true, "走镜像") : pill(false, "直连官方"), "立即", !update],
    ["插件市场 · 插件安装 · Skill · MCP", prefix ? `<code>${escapeHTML(prefix)}</code>` : "未设置", prefixNow, liveOn ? "已生效" : envOn ? "重启后" : "—", !liveOn],
    ["插件自带 npm 包（bun / npm）", m.chinaMirror ? "国内镜像 npmmirror" : envOn ? "官方失败后试 npmmirror" : "官方", m.chinaMirror ? pill(true, "走 npmmirror") : envOn ? pill(null, "有退路") : pill(false, "只走官方"), m.chinaMirror ? "立即" : liveOn ? "已生效" : "重启后", false],
    ["Skill 的 git 克隆", `${gitOn}/${hosts.length} 个域名有代理`, gitOn ? pill(true, "走代理") : pill(false, gitOn === 0 ? "直连（容易被墙）" : "部分"), "立即", gitOn === 0],
  ];

  $("now-table").querySelector("tbody").innerHTML =
    `<tr><th>通道</th><th>设置值</th><th>现在</th><th>生效</th></tr>` +
    rows
      .map(
        ([what, value, now, when, gap]) =>
          `<tr><td>${what}</td><td class="muted">${value}</td><td>${now}</td><td class="muted">${when}${gap ? ` <span class="pill warn">待配</span>` : ""}</td></tr>`,
      )
      .join("");

  const gaps = rows.filter((r) => r[4]).length;
  $("now-badge").textContent = gaps ? `${gaps} 项没配` : "全部就位";
  $("now-badge").className = "badge" + (gaps ? "" : " ok");

  // 变量写进注册表了，但现在跑着的 magpie 没读到（它是由别的程序启动的，
  // 继承的是那个程序启动时的环境）——给一个就地重启的按钮。
  const hint = $("now-hint");
  if (envOn && !liveOn && state.app?.found) {
    hint.hidden = false;
    hint.innerHTML = `前缀变量已经写进用户环境变量，但<b>现在跑着的 magpie 没读到</b>（它是由别的程序启动的，继承的是那个程序启动时的环境）。插件会在启动后 8 秒内自动修一次（重启 magpie，把变量直接放进新进程）；也可以现在点：<button id="now-restart" class="primary">重启 magpie 让它生效</button>`;
  } else {
    hint.hidden = true;
    hint.innerHTML = "";
  }
}

function render() {
  if (!state) return;
  const s = state.settings || {};
  const route = state.route || {};

  $("ver").textContent = "v" + (state.version || "?");
  $("cfgdir").textContent = state.configDir || "?";

  const proxySet = Boolean(s.proxy && s.proxy !== "direct");
  const mirrorSet = Boolean(s.updateMirror);

  if (state.settings?.error && toast.shown !== state.settings.error) {
    toast.shown = state.settings.error;
    toast(state.settings.error, "bad");
  }

  if (filled.proxy === null && document.activeElement !== $("proxy")) {
    if (!$("proxy").value) {
      $("proxy").value = proxySet ? s.proxy : route.hostProxy?.value || "";
      filled.proxy = $("proxy").value;
    }
  }
  if (filled.mirror === null && document.activeElement !== $("mirror")) {
    if (!$("mirror").value) {
      const m = state.mirror || {};
      $("mirror").value = mirrorSet
        ? String(s.updateMirror).replace(/\/+$/, "")
        : String(m.envBase || m.live?.base || (m.live?.on ? m.defaultBase : "") || "");
      filled.mirror = $("mirror").value;
    }
  }

  const hosts = state.git?.hosts || [];
  const tbody = $("git-hosts").querySelector("tbody");
  if (!hosts.length) {
    tbody.innerHTML = `<tr><td class="muted">没找到 git${state.git?.binary ? "" : "（PATH 里没有，可在插件选项里写 gitPath）"}</td></tr>`;
  } else {
    tbody.innerHTML =
      `<tr><th>域名</th><th>git 里的代理</th></tr>` +
      hosts
        .map(
          (h) =>
            `<tr><td class="host">${escapeHTML(h.host)}</td><td>${h.proxy ? `<span class="pill ok">${escapeHTML(h.proxy)}</span>` : `<span class="pill skip">未设置</span>`}</td></tr>`,
        )
        .join("");
  }

  const targets = state.targets || [];
  const test = $("test-table").querySelector("tbody");
  if (!test.dataset.filled) {
    test.innerHTML =
      `<tr><th>地址</th><th>用途</th><th>直连</th><th>经代理</th></tr>` +
      targets
        .map(
          (t) =>
            `<tr data-id="${t.id}"><td class="url">${escapeHTML(t.name)}</td><td class="muted">${escapeHTML(t.what)}</td><td class="num" data-cell="direct">—</td><td class="num" data-cell="proxy">—</td></tr>`,
        )
        .join("");
    test.dataset.filled = "1";
  }

  const prefixTbody = $("prefix-table").querySelector("tbody");
  if (!prefixTbody.dataset.filled) {
    prefixTbody.innerHTML =
      `<tr><th>地址</th><th>经前缀的完整地址</th><th>结果</th></tr>` +
      (state.prefixTargets || targets)
        .map(
          (t) =>
            `<tr data-id="${t.id}"><td class="url">${escapeHTML(t.name)}</td><td class="url muted" data-cell="url">—</td><td class="num" data-cell="prefix">—</td></tr>`,
        )
        .join("");
    prefixTbody.dataset.filled = "1";
  }

  renderMirror();
  renderNow();

  $("now-note").textContent = lastRead ? `最后读取 ${new Date(lastRead).toLocaleTimeString()}` : "";
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** soft：镜像站能应答但状态码是 4xx 时，只算「应答了」，不当成绿。 */
function cell(result, { soft = false, note = "" } = {}) {
  if (!result) return `<span class="pill skip">跳过</span>`;
  const ms = result.ms >= 1000 ? (result.ms / 1000).toFixed(1) + "s" : result.ms + "ms";
  if (result.ok) {
    const code = result.status || 200;
    const yes = result.expected === undefined ? code < 400 : result.expected;
    if (!yes) {
      return `<span class="pill warn" title="${escapeHTML(note || "这个地址本来就没有内容，能应答就说明请求转过去了")}">${code} · ${ms}</span>`;
    }
    if (soft && code >= 400) return `<span class="pill warn" title="镜像应答了，但这个地址本身没有内容">${code} · ${ms}</span>`;
    return `<span class="pill ok" title="${escapeHTML(note || "")}">${code} · ${ms}</span>`;
  }
  return `<span class="pill bad" title="${escapeHTML(result.error || "")}">失败 · ${ms}</span>`;
}

/** 前缀通道那张表：每条路现在是不是真走前缀、什么时候生效。 */
function renderMirror() {
  const m = state.mirror || {};
  const update = String(m.update || "");
  const envOn = /^(on|true|1|cn)$/i.test(String(m.envMirrors || ""));
  const envBase = String(m.envBase || "");
  const liveOn = Boolean(m.live?.on);
  const liveBase = String(m.live?.base || m.defaultBase || "https://gh-proxy.com");

  const liveCell = liveOn
    ? `<span class="pill ok">已生效 · ${escapeHTML(liveBase)}</span>`
    : envOn
      ? `<span class="pill warn">变量已写（${escapeHTML(envBase || m.defaultBase || "")}），等重启</span>`
      : `<span class="pill skip">未设置：只走官方</span>`;
  const liveWhen = liveOn ? "已生效" : envOn ? "重启后" : "—";

  const rows = [
    [
      "检查更新 / 下载更新包",
      update
        ? `<span class="pill ok">updateMirror = ${escapeHTML(update)}</span>`
        : `<span class="pill skip">未设置：直连官方</span>`,
      "立即",
    ],
    ["插件市场（topic 搜索、package.json、README）", liveCell, liveWhen],
    ["插件安装 / 更新（github: 源，codeload 压缩包）", liveCell, liveWhen],
    ["Skill 列表与压缩包", liveCell, liveWhen],
    ["MCP 列表、图标、安装", liveCell, liveWhen],
    [
      "插件本体（npm 包，走 bun）",
      m.chinaMirror
        ? `<span class="pill ok">国内镜像已开 · npmmirror</span>`
        : envOn
          ? `<span class="pill warn">变量已写，官方失败后试 npmmirror</span>`
          : `<span class="pill skip">未设置：只走官方</span>`,
      m.chinaMirror ? "立即" : liveWhen,
    ],
  ];
  $("mirror-route").querySelector("tbody").innerHTML =
    `<tr><th>要去哪</th><th>现在</th><th>生效</th></tr>` +
    rows.map(([what, now, when]) => `<tr><td>${what}</td><td>${now}</td><td class="muted">${when}</td></tr>`).join("");

  const app = state.app || {};
  const notes = [];
  notes.push("前缀只在<b>官方地址失败后</b>才用（magpie 的 URLs() 把官方排在最前），不会顶替官方；镜像请求不带你的 GitHub token。");
  notes.push("「国内镜像」开关对 npm、jsDelivr、bun 是<b>优先</b>用镜像，那个走 settings.chinaMirror，改了立即生效。");
  if (app.found) notes.push(`重启按钮会关掉并重开 <code>${escapeHTML(app.exe || "")}</code>（pid ${app.pid}）。`);
  else if (app.why) notes.push(`这次不能自动重启：${escapeHTML(app.why)}——自己关掉 magpie 再打开也一样。`);
  $("mirror-note").innerHTML = notes.join("<br>");

  const log = state.restart;
  const pre = $("restart-log");
  if (log?.rows?.length) {
    pre.hidden = false;
    pre.textContent = `上一次重启（${log.path}）：\n` + log.rows.join("\n");
  } else {
    pre.hidden = true;
  }
}

/* ── 动作 ── */
async function refresh({ quiet = false } = {}) {
  try {
    state = await api("/api/state", {}, { tries: quiet ? 1 : 3 });
    lastRead = Date.now();
    refresh.fails = 0;
    render();
  } catch (err) {
    if (!quiet) toast("读状态失败：" + err.message, "bad");
    // 断线时继续试：magpie 重启完，服务会自己回到同一个端口（或换个端口，由 api() 跳过去）。
    // 头几次密一点，之后放到 4 秒，免得重启期间每 3 秒刷屏一次日志。
    clearTimeout(refresh.retry);
    const wait = refresh.fails ? 4000 : 1200;
    refresh.fails = (refresh.fails || 0) + 1;
    refresh.retry = setTimeout(() => refresh({ quiet: true }), wait);
  }
}

async function apply(button, body, okText) {
  return busy(button, async () => {
    try {
      const out = await api("/api/apply", body);
      if (out.state) {
        state = out.state;
        render();
      }
      const bad = (out.steps || []).filter((s) => !s.ok);
      toast(stepsText(out.steps), bad.length ? "bad" : "ok");
      if (!bad.length && okText) console.log(okText);
      return out;
    } catch (err) {
      const text = String(err?.message || err);
      if (text.includes("本地服务没应答")) {
        // magpie 在重启：这一页会自己接上，不用重开，也不用重填（表单值还在）
        toast("magpie 正在重启，服务回来后这一页会自己接上；等几秒再点一次就行", "bad");
        refresh({ quiet: true });
      } else {
        toast("没成功：" + text, "bad");
      }
      return null;
    }
  });
}

function proxyValue() {
  return $("proxy").value.trim();
}

function mirrorValue() {
  return $("mirror").value.trim();
}

$("proxy-apply").addEventListener("click", async (e) => {
  const envProxy = $("envproxy").checked;
  await apply(e.currentTarget, { proxy: proxyValue(), git: "apply", envProxy }, "代理已应用");
  filled.proxy = null;
});

$("proxy-clear").addEventListener("click", async (e) => {
  $("proxy").value = "";
  filled.proxy = null;
  await apply(e.currentTarget, { proxy: "direct", git: "clear" }, "已清空");
});

$("mirror-apply").addEventListener("click", async (e) => {
  const out = await apply(e.currentTarget, { mirror: mirrorValue(), userEnvMirror: true }, "前缀已应用");
  filled.mirror = null;
  if (out?.state && !out.state.mirror?.live?.on) {
    toast(`前缀已写：更新/更新包现在就走。插件市场、插件安装、Skill、MCP 要重启 magpie（右上「应用并重启」）`, "");
  }
});

$("mirror-restart").addEventListener("click", async (e) => {
  if (!confirm("会关掉 magpie 再重新打开（正在跑的请求和会话会断一下）。继续？")) return;
  const out = await busy(e.currentTarget, async () => {
    try {
      return await api("/api/apply", { mirror: mirrorValue(), userEnvMirror: true, restart: true, restartDelayMs: 1200 });
    } catch (err) {
      // magpie 已经关掉了，请求可能打到一半就断了
      return { steps: [{ step: "重启 magpie", ok: true, message: "magpie 已经关掉了（这一页马上会断开）：" + err.message }] };
    }
  });
  filled.mirror = null;
  const bad = (out?.steps || []).filter((s) => !s.ok);
  toast(stepsText(out?.steps || []) + "\n\nmagpie 回来以后再打开这一页，「运行中」那一列应该变绿。", bad.length ? "bad" : "ok");
});

$("mirror-clear").addEventListener("click", async (e) => {
  $("mirror").value = "";
  filled.mirror = null;
  await apply(e.currentTarget, { mirror: "off", userEnvMirror: false }, "已清除");
});

$("now-refresh").addEventListener("click", async (e) => {
  await busy(e.currentTarget, () => refresh());
});

/* 「现在生效」里的就地重启按钮（每次渲染都会重建，所以用事件代理） */
document.addEventListener("click", async (e) => {
  const btn = e.target?.closest?.("#now-restart");
  if (!btn) return;
  if (!confirm("会关掉 magpie 再重新打开（正在跑的请求和会话会断一下）。继续？")) return;
  btn.disabled = true;
  const prefix = state?.prefixInUse || mirrorValue();
  try {
    const out = await api("/api/apply", { mirror: prefix, userEnvMirror: true, restart: true, restartDelayMs: 1200 }, { tries: 1 });
    const bad = (out.steps || []).filter((s) => !s.ok);
    toast(stepsText(out.steps), bad.length ? "bad" : "ok");
  } catch (err) {
    toast("magpie 已经关掉了，这一页马上会断；它自己会再起来，回来以后这一行应该变绿：" + err.message, "");
  }
  setTimeout(() => refresh({ quiet: true }), 8000);
});

$("run-prefix").addEventListener("click", async (e) => {
  await busy(e.currentTarget, async () => {
    const tbody = $("prefix-table").querySelector("tbody");
    for (const row of tbody.querySelectorAll("tr[data-id]")) {
      row.querySelector('[data-cell="prefix"]').innerHTML = `<span class="pill skip">…</span>`;
    }
    $("prefix-note").textContent = "拼上前缀逐个探测（每个最多 30 秒，大包会慢）…";
    try {
      const out = await api("/api/test", { target: "prefix", prefix: mirrorValue() }, { tries: 2 });
      if (out.error) {
        $("prefix-note").textContent = out.error;
        for (const row of tbody.querySelectorAll("tr[data-id]")) {
          row.querySelector('[data-cell="prefix"]').innerHTML = `<span class="pill skip">—</span>`;
        }
        return;
      }
      for (const row of out.rows || []) {
        const tr = tbody.querySelector(`tr[data-id="${row.id}"]`);
        if (!tr) continue;
        tr.querySelector('[data-cell="url"]').textContent = row.viaPrefix?.url || row.url;
        tr.querySelector('[data-cell="prefix"]').innerHTML = cell(row.viaPrefix, { soft: true, note: row.note });
      }
      const bad = (out.rows || []).filter((r) => !r.viaPrefix?.ok).length;
      $("prefix-note").textContent = bad
        ? `${bad} 个地址经前缀不通（这些 magpie 会退回直连）· 前缀 ${out.prefix}`
        : `经前缀全部可达 · 前缀 ${out.prefix}`;
    } catch (err) {
      $("prefix-note").textContent = "";
      toast("前缀自检失败：" + err.message, "bad");
    }
  });
});

$("git-apply").addEventListener("click", async (e) => {
  const value = proxyValue();
  const body = value ? { proxy: value, git: "apply" } : { git: "apply" };
  await apply(e.currentTarget, body, "git 已配置");
});

$("git-clear").addEventListener("click", async (e) => {
  await apply(e.currentTarget, { git: "clear" }, "git 配置已清除");
});

$("git-test").addEventListener("click", async (e) => {
  await busy(e.currentTarget, async () => {
    $("test-note").textContent = "git ls-remote 正在问 GitHub…";
    try {
      const out = await api("/api/git/test");
      $("test-note").textContent = "";
      const via = out.proxy ? `（git 用的是 ${out.proxy}）` : "（git 没设代理，走直连）";
      toast(
        out.ok ? `✓ git 能连上 GitHub：${out.ms}ms，${out.refs || 0} 个分支${via}` : `✗ git 连不上：${out.error}${via}`,
        out.ok ? "ok" : "bad",
      );
      await refresh();
    } catch (err) {
      $("test-note").textContent = "";
      toast("自检失败：" + err.message, "bad");
    }
  });
});

$("run-test").addEventListener("click", async (e) => {
  await busy(e.currentTarget, async () => {
    const proxy = proxyValue();
    if (!proxy) {
      toast("先在上面填代理地址，才有「经代理」这一列可测", "bad");
      return;
    }
    const tbody = $("test-table").querySelector("tbody");
    for (const row of tbody.querySelectorAll("tr[data-id]")) {
      row.querySelector('[data-cell="direct"]').innerHTML = `<span class="pill skip">…</span>`;
      row.querySelector('[data-cell="proxy"]').innerHTML = `<span class="pill skip">…</span>`;
    }
    $("test-note").textContent = "逐个探测中（每个最多 12 秒）…";
    try {
      const out = await api("/api/test", { target: "all", proxy });
      for (const row of out.rows || []) {
        const tr = tbody.querySelector(`tr[data-id="${row.id}"]`);
        if (!tr) continue;
        tr.querySelector('[data-cell="direct"]').innerHTML = cell(row.direct, { note: row.note });
        tr.querySelector('[data-cell="proxy"]').innerHTML = cell(row.viaProxy, { note: row.note });
      }
      const bad = (out.rows || []).filter((r) => r.viaProxy && !r.viaProxy.ok).length;
      $("test-note").textContent = bad ? `${bad} 个地址经代理仍不通` : "经代理全部可达";
    } catch (err) {
      $("test-note").textContent = "";
      toast("自检失败：" + err.message, "bad");
    }
  });
});

refresh();

/* 每 8 秒自己重读：设置改完、magpie 重启完，这一页会自己跟上 */
setInterval(() => {
  if (document.hidden) return;
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
  refresh({ quiet: true });
}, 8000);
