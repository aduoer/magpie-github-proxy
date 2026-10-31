// 连通性自检：对 magpie 真正会用到的几个 GitHub 地址，
// 分别从「直连」和「经代理」两条路各探一次，给出耗时与状态。
//
// 直连用 https.request（Node/Bun 都不看环境变量代理）；
// 经代理优先用 Bun 的 fetch({proxy})，没有就自己开一条 CONNECT 隧道。
// 两者都只发 HEAD，不下载内容。

import https from "node:https";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

/** magpie 从 GitHub 拉东西的几类地址。 */
export const TARGETS = [
  {
    id: "api",
    name: "GitHub API",
    url: "https://api.github.com/repos/yetone/magpie/releases/latest",
    what: "检查更新、插件市场的仓库发现",
  },
  {
    id: "raw",
    name: "raw.githubusercontent.com",
    url: "https://raw.githubusercontent.com/yetone/magpie/main/README.md",
    what: "插件的 package.json、Skill 的 SKILL.md、README",
  },
  {
    id: "codeload",
    name: "codeload.github.com",
    url: "https://codeload.github.com/yetone/magpie/tar.gz/refs/heads/main",
    what: "插件与 Skill 的 tarball 下载",
  },
  {
    id: "web",
    name: "github.com",
    url: "https://github.com/yetone/magpie",
    what: "仓库页面、README、图标",
  },
  {
    id: "assets",
    name: "release 资产域",
    url: "https://objects.githubusercontent.com/",
    what: "更新包与 release 附件（下载重定向到这里）",
    // 这个域名只提供带签名的长路径（/github-production-release-asset-…?X-Amz-…），
    // 根路径本来就没有内容：403/404 说明请求被原样转过去了，不是坏。
    okCodes: [200, 206, 301, 302, 307, 400, 403, 404],
    note: "根路径本来就没有内容（资产都是带签名的长路径）；能应答 403/404 就说明前缀把它转过去了",
  },
];

const UA = "magpie-page-github-proxy/0.1";

const hasBunProxy = () => typeof globalThis.Bun?.version === "string";

/** 把地址解析成 {host, port, path}。 */
function split(url) {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === "http:" ? 80 : 443));
  return { u, host: u.hostname, port, path: u.pathname + u.search, tls: u.protocol === "https:" };
}

/** 直连探一次：只看 HTTP 状态，不跟重定向。 */
function directOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    const { u, tls: isTLS, host, port, path } = split(url);
    const mod = isTLS ? https : http;
    const started = Date.now();
    const req = mod.request(
      { method: "HEAD", host, port, path, servername: isTLS ? host : undefined, headers: { "user-agent": UA, accept: "*/*" } },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode, ms: Date.now() - started });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`超时 ${timeoutMs}ms`), { code: "ETIMEDOUT" })));
    req.on("error", (err) => resolve({ ok: false, ms: Date.now() - started, error: describe(err) }));
    req.end();
    void u;
  });
}

/** 经代理探一次：Bun 的 fetch 能直接用 proxy 选项。 */
async function bunOnce(url, proxy, timeoutMs) {
  const started = Date.now();
  const res = await fetch(url, {
    method: "HEAD",
    redirect: "manual",
    proxy,
    headers: { "user-agent": UA, accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    await res.body?.cancel?.();
  } catch {
    /* 关掉就好 */
  }
  return { ok: true, status: res.status, ms: Date.now() - started };
}

/**
 * 自己开 CONNECT 隧道探一次，给没有 Bun 的环境（或 Bun 拒绝了这条代理）用。
 * 只支持 http:// 与 https:// 代理；SOCKS 需要 Bun。
 */
function tunnelOnce(url, proxy, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const { host, port, path, tls: isTLS } = split(url);
    const p = new URL(proxy);
    const proxyPort = Number(p.port || (p.protocol === "https:" ? 443 : 80));
    const socket = net.connect({ host: p.hostname, port: proxyPort });
    const fail = (err) => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - started, error: describe(err) });
    };
    socket.setTimeout(timeoutMs, () => fail(Object.assign(new Error(`超时 ${timeoutMs}ms`), { code: "ETIMEDOUT" })));
    socket.on("error", fail);
    socket.once("connect", () => {
      const auth = p.username ? "Proxy-Authorization: Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64") + "\r\n" : "";
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (head.length > 8192) fail(new Error("代理回了太长的头"));
          return;
        }
        socket.removeListener("data", onData);
        const line = head.slice(0, end).toString("latin1").split("\r\n")[0] || "";
        const code = Number((line.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1] || 0);
        if (code !== 200) {
          fail(new Error(`代理拒绝了 CONNECT：${line || "没有回应"}`));
          return;
        }
        const link = isTLS ? tls.connect({ socket, servername: host }) : socket;
        link.on("error", fail);
        if (isTLS) link.once("secureConnect", () => write(link));
        const write = (s) => {
          s.write(`HEAD ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
          let got = Buffer.alloc(0);
          s.on("data", (d) => {
            got = Buffer.concat([got, d]);
            const e = got.indexOf("\r\n");
            if (e < 0) return;
            const statusLine = got.slice(0, e).toString("latin1");
            const status = Number((statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1] || 0);
            s.destroy();
            resolve({ ok: true, status, ms: Date.now() - started });
          });
          s.on("end", () => resolve({ ok: false, ms: Date.now() - started, error: "没有拿到响应" }));
        };
        if (!isTLS) write(socket);
      };
      socket.on("data", onData);
    });
  });
}

function describe(err) {
  const code = err?.code || err?.cause?.code;
  const map = {
    ENOTFOUND: "域名解析失败（DNS）",
    ECONNREFUSED: "连接被拒绝（端口没开代理？）",
    ECONNRESET: "连接被重置（多半被墙）",
    ETIMEDOUT: "超时",
    EHOSTUNREACH: "主机不可达",
    EPROTO: "TLS 握手失败",
    CERT_HAS_EXPIRED: "证书过期",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "证书链不完整",
  };
  const msg = err?.message || String(err);
  if (code && map[code]) return `${map[code]}（${code}）`;
  if (/UnsupportedProxyProtocol/i.test(msg)) return "这条代理协议 Bun 不认（只认 http/https，SOCKS 要走桥）";
  if (/timed? ?out/i.test(msg)) return "超时";
  return msg.split("\n")[0].slice(0, 160);
}

/** 这个状态码对这条地址算不算「通」。 */
function judge(t, r) {
  if (!r || !r.ok) return { ...r, expected: false };
  const codes = t.okCodes;
  const code = Number(r.status) || 0;
  const expected = codes ? codes.includes(code) : code > 0 && code < 400;
  return { ...r, expected };
}

/** 探一次；proxy 为空表示直连。 */
export async function probe(url, { proxy = "", timeoutMs = 12000 } = {}) {
  // magpie 允许裸写 host:port（意思是 http），这里也照样认。
  let via = String(proxy || "").trim();
  if (via && !/^[a-z0-9+.-]+:\/\//i.test(via)) via = "http://" + via;
  if (!via) return directOnce(url, timeoutMs);
  if (hasBunProxy()) {
    try {
      return await bunOnce(url, via, timeoutMs);
    } catch (err) {
      const msg = describe(err);
      // Bun 处理不了的代理（比如没桥接的 socks5）再用隧道试一次
      if (/UnsupportedProxyProtocol/i.test(err?.message || "") && /^https?:/i.test(via)) {
        return tunnelOnce(url, via, timeoutMs);
      }
      return { ok: false, ms: 0, error: msg };
    }
  }
  if (!/^https?:/i.test(via)) return { ok: false, ms: 0, error: "没有 Bun 时自检只支持 http(s) 代理（SOCKS 要用 Bun）" };
  return tunnelOnce(url, via, timeoutMs);
}

/** 拼接前缀：镜像站的规则是「前缀 + 原地址」，中间只有一个斜杠。 */
export function joinPrefix(prefix, url) {
  const p = String(prefix || "").trim().replace(/\/+$/, "");
  if (!p) return url;
  return p + "/" + url;
}

/** 拿到响应头就断开，不下载内容 —— 镜像站不一定认 HEAD，所以发 GET。 */
function headedOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    const { tls: isTLS, host, port, path } = split(url);
    const mod = isTLS ? https : http;
    const started = Date.now();
    const req = mod.request(
      { method: "GET", host, port, path, servername: isTLS ? host : undefined, headers: { "user-agent": UA, accept: "*/*", range: "bytes=0-1023" } },
      (res) => {
        const ms = Date.now() - started;
        const status = res.statusCode;
        const type = String(res.headers["content-type"] || "");
        res.destroy();
        resolve({ ok: true, status, ms, type });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`超时 ${timeoutMs}ms`), { code: "ETIMEDOUT" })));
    req.on("error", (err) => resolve({ ok: false, ms: Date.now() - started, error: describe(err) }));
    req.end();
  });
}

/** 经前缀探一次。 */
export async function probePrefix(prefix, url, { timeoutMs = 25000 } = {}) {
  if (!String(prefix || "").trim()) return { ok: false, ms: 0, error: "没有填前缀" };
  const target = joinPrefix(prefix, url);
  const r = await headedOnce(target, timeoutMs);
  return { ...r, url: target };
}

/** 全套前缀自检：每个地址拼上前缀各探一次。 */
export async function probePrefixAll(prefix, { timeoutMs = 25000 } = {}) {
  return Promise.all(
    TARGETS.map(async (t) => ({ ...t, viaPrefix: judge(t, await probePrefix(prefix, t.url, { timeoutMs })) })),
  );
}

/** 全套自检：每个地址直连 + 经代理。 */
export async function probeAll(proxy, { timeoutMs = 12000 } = {}) {
  const rows = [];
  for (const t of TARGETS) {
    const [d, p] = await Promise.all([
      probe(t.url, { timeoutMs }),
      proxy ? probe(t.url, { proxy, timeoutMs }) : Promise.resolve(null),
    ]);
    rows.push({ ...t, direct: judge(t, d), viaProxy: p ? judge(t, p) : null });
  }
  return rows;
}
