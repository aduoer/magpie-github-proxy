// 「重启 magpie」这一节：找出正在运行这个插件宿主的是哪个 magpie 进程，
// 然后把它关掉再拉起来。
//
// 为什么需要它：镜像前缀通道对「插件市场 / 插件安装 / Skill / MCP」的覆盖
// 由 magpie 的 MAGPIE_MIRRORS 环境变量决定（internal/source/source.go 的
// Enabled()），而 os.Getenv 读的是进程启动时的那份环境——正在跑的 magpie
// 永远看不见我们后来写进用户环境变量的值。应用更新和更新包不受影响
// （那走 settings.updateMirror，文件一改就重读）。所以这一条通道的最后一步
// 只能是一次重启。
//
// 关掉自己再拉起来必须由「不在 magpie 作业对象里」的进程做：宿主进程本身
// 是 magpie 的子进程，直接执行的话会跟着父进程一起被杀，magpie 就再也不
// 回来了。所以脚本由 WMI 的 Win32_Process.Create 起（父进程是 WmiPrvSE，
// 在会话里、但不在 magpie 的作业里），脚本里再用 Start-Process 拉起界面。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG = join(tmpdir(), "magpie-github-proxy-restart.log");
const APP_NAME = /^magpie(-windows-[a-z0-9]+|-[\w.]+)?\.exe$/i;
const NOT_APP = /^magpie-bun/i;

function powershell() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

/** 跑一段 PowerShell，返回 stdout（去尾空白）。失败返回 { error }。 */
function ps(command, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(powershell(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return finish({ error: String(e?.message || e) });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
      finish({ error: "PowerShell 超时" });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.stderr.on("data", (c) => (err += c.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ error: String(e?.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, stdout: out.trim(), stderr: err.trim() });
    });
  });
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** 从命令行里把「exe 之后的参数」切出来（magpie 常见的是单个 tray）。 */
function appArgs(cmd) {
  const line = String(cmd || "").trim();
  if (!line) return [];
  const rest = line.startsWith('"') ? line.replace(/^"[^"]*"\s*/, "") : line.replace(/^\S+\s*/, "");
  return (rest.match(/"[^"]*"|\S+/g) || []).map((s) => s.replace(/^"|"$/g, ""));
}

/* ───────────────────────── 谁在跑这个宿主 ───────────────────────── */

let cached = { at: 0, value: null };

/** 整机找一遍 magpie 的进程（祖先链里没有时兜底）。 */
async function scanApps() {
  const script = `
Get-CimInstance Win32_Process -Filter "Name LIKE 'magpie%'" -ErrorAction SilentlyContinue |
  ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, $_.ExecutablePath, $_.CommandLine }`;
  const r = await ps(script);
  if (!r.ok) return { found: false, why: `扫描进程失败：${r.error || r.stderr || "未知错误"}` };
  const rows = String(r.stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const [pid, name, exe, cmd] = line.split("|");
      return { pid: Number(pid) || 0, name: name || "", exe: exe || "", cmd: cmd || "" };
    })
    .filter((row) => row.pid && row.name && APP_NAME.test(row.name) && !NOT_APP.test(row.name));
  // pid 大的通常是后起的那个，拿它当界面进程
  rows.sort((a, b) => b.pid - a.pid);
  for (const row of rows) {
    const args = appArgs(row.cmd);
    const arg = args.join(" ").trim();
    if (arg && !/^tray\b/i.test(arg)) continue;
    return { found: true, pid: row.pid, name: row.name, exe: row.exe, args, commandLine: row.cmd, chain: rows };
  }
  return { found: false, why: "整机里也没找到开着的 magpie 界面进程" };
}

/** 从本进程往上找祖先，挑出 magpie 的应用进程（界面/托盘那个）。 */
export async function findApp({ fresh = false, fromPid = 0 } = {}) {
  if (!fresh && cached.value && Date.now() - cached.at < 8000) return cached.value;

  if (process.platform !== "win32") {
    const value = { found: false, why: "只有 Windows 上能自动重启，自己关掉 magpie 再打开即可" };
    cached = { at: Date.now(), value };
    return value;
  }

  const start = Number(fromPid) || Number(process.ppid) || 0;
  const script = `
$id = ${start}
$hops = 0
while ($id -gt 0 -and $hops -lt 10) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if (-not $p) { break }
  $exe = $p.ExecutablePath
  if (-not $exe) { $exe = '' }
  $cmd = $p.CommandLine
  if (-not $cmd) { $cmd = '' }
  '{0}|{1}|{2}|{3}' -f $p.ProcessId, $p.Name, $exe, $cmd
  $id = $p.ParentProcessId
  $hops++
}`;

  const r = await ps(script);
  if (!r.ok) {
    const value = { found: false, why: `查进程失败：${r.error || r.stderr || "未知错误"}` };
    cached = { at: Date.now(), value };
    return value;
  }

  const rows = String(r.stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const [pid, name, exe, cmd] = line.split("|");
      return { pid: Number(pid) || 0, name: name || "", exe: exe || "", cmd: cmd || "" };
    })
    .filter((row) => row.pid && row.name);

  let value = { found: false, why: "没找到 magpie 的界面进程（宿主可能是 magpie CLI 起的临时实例）" };
  for (const row of rows) {
    if (!APP_NAME.test(row.name) || NOT_APP.test(row.name)) continue;
    // 界面/托盘：没有子命令，或者只有 tray；带 plugin/serve/web/daemon 的是别的入口
    const args = appArgs(row.cmd);
    const arg = args.join(" ").trim();
    if (arg && !/^tray\b/i.test(arg)) {
      value = { found: false, why: `宿主由 magpie 的 ${args[0]} 子命令起的（不是应用窗口），不从这里重启` };
      break;
    }
    value = { found: true, pid: row.pid, name: row.name, exe: row.exe, args, commandLine: row.cmd, chain: rows };
    break;
  }

  // 祖先里没有（比如插件服务是 node index.mjs 独立跑的）：退一步，在整机里找 magpie 的界面进程。
  if (!value.found) {
    const scan = await scanApps();
    if (scan.found) value = { ...scan, note: "祖先里没有 magpie，按整机搜索结果挑的" };
  }

  cached = { at: Date.now(), value };
  return value;
}

/* ───────────────────────── 重启 ───────────────────────── */

const RESTART_SCRIPT = (pid, exe, name, log, scriptPath, args = [], envPairs = []) => `
$ErrorActionPreference = 'Continue'
$log = ${q(log)}
function Say([string]$m) {
  try { ('{0}  {1}' -f (Get-Date).ToString('HH:mm:ss'), $m) | Out-File -LiteralPath $log -Append -Encoding utf8 } catch {}
}
Say 'restart: 收到请求'
Start-Sleep -Milliseconds 900
$target = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($target) {
  Say 'restart: 关闭 magpie（先请求关窗口，再强制结束）'
  try { $target.CloseMainWindow() | Out-Null } catch {}
  Start-Sleep -Milliseconds 600
  Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue
}
for ($i = 0; $i -lt 80; $i++) {
  if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 250
}
if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {
  Say 'restart: 关不掉，放弃启动，免得开两个'
  Remove-Item -LiteralPath ${q(scriptPath)} -Force -ErrorAction SilentlyContinue
  return
}
Say 'restart: 已关闭'
Start-Sleep -Milliseconds 800
$exe = ${q(exe)}
$argList = @(${args.length ? args.map(q).join(",") : ""})
$envPairs = @(${envPairs.map(([k, v]) => `@(${q(k)},${q(v)})`).join(",")})
# 注册表里的用户环境变量不会自动进这个旧进程，拉起来之前先按要用的值改这里的环境
foreach ($pr in $envPairs) {
  try {
    if ($pr[1]) { Set-Item -Path ('Env:' + $pr[0]) -Value $pr[1] } else { Remove-Item -Path ('Env:' + $pr[0]) -ErrorAction SilentlyContinue }
  } catch {}
}
function Launch {
  try {
    if ($argList.Count -gt 0) {
      Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory (Split-Path -Parent $exe)
    } else {
      Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
    }
  } catch { Say ('restart: 启动失败 ' + $_.Exception.Message) }
}
if ($exe -and (Test-Path -LiteralPath $exe)) {
  Say ('restart: 启动 ' + $exe + ' ' + ($argList -join ' '))
  Say ('restart: 新进程环境 MAGPIE_MIRRORS=' + $env:MAGPIE_MIRRORS + ' MAGPIE_GITHUB_MIRROR=' + $env:MAGPIE_GITHUB_MIRROR + ' HTTPS_PROXY=' + $env:HTTPS_PROXY)
  for ($try = 1; $try -le 3; $try++) {
    Launch
    Start-Sleep -Seconds 3
    $now = @(Get-CimInstance Win32_Process -Filter "Name=${q(name)}" -ErrorAction SilentlyContinue)
    if ($now.Count -gt 0) { break }
    Say ('restart: 好像没起来（第 ' + $try + ' 次），再拉一次')
  }
} else {
  Say ('restart: 找不到可执行文件 ' + $exe)
}
$now = @(Get-CimInstance Win32_Process -Filter "Name=${q(name)}" -ErrorAction SilentlyContinue)
$sid = '?'
try { $sid = (Get-Process -Id $PID).SessionId } catch {}
Say ('restart: helper 会话 ' + $sid + '，现在跑着的 ' + $($now.Count) + ' 个：' + (($now | ForEach-Object { $_.ProcessId }) -join ','))
# 让资源管理器刷新环境变量，之后从开始菜单/托盘起的 magpie 也能拿到
try {
  $sig = 'using System;using System.Runtime.InteropServices;public class MgpEnv{[DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Auto)]public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint Msg,UIntPtr wParam,string lParam,uint fuFlags,uint uTimeout,out UIntPtr lpdwResult);}'
  Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
  $res = [UIntPtr]::Zero
  [MgpEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$res) | Out-Null
} catch {}
Say 'restart: 结束'
Remove-Item -LiteralPath ${q(scriptPath)} -Force -ErrorAction SilentlyContinue
`;

/** 写脚本 → 用 WMI 起（在 magpie 作业之外）→ 它等一会儿关掉 magpie 再拉起。 */
export async function restartApp(app, { delayMs = 900, dryRun = false, env = null } = {}) {
  if (!app?.found) return { ok: false, error: app?.why || "没找到 magpie 进程" };
  if (!app.exe) return { ok: false, error: "拿不到 magpie 的可执行文件路径，只能手动重启" };
  if (process.platform !== "win32") return { ok: false, error: "只有 Windows 上能自动重启" };

  const scriptPath = join(tmpdir(), `magpie-github-proxy-restart-${Date.now()}.ps1`);
  const name = String(app.name || app.exe.split(/[\\/]/).pop() || "magpie-windows-amd64.exe");
  const args = Array.isArray(app.args) ? app.args.filter((a) => typeof a === "string" && a) : [];
  const envPairs = Object.entries(env || {})
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => [k, v == null ? "" : String(v)]);
  const body = RESTART_SCRIPT(app.pid, app.exe, name, LOG, scriptPath, args, envPairs)
    .replace("Start-Sleep -Milliseconds 900", `Start-Sleep -Milliseconds ${Math.max(300, Number(delayMs) || 900)}`);
  try {
    writeFileSync(scriptPath, "\uFEFF" + body, "utf8");
  } catch (e) {
    return { ok: false, error: `写重启脚本失败：${e.message}` };
  }
  if (dryRun) return { ok: true, dryRun: true, script: scriptPath, body };

  const cmd = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`;
  // WMI 起的进程父级是 WmiPrvSE，不在 magpie 的作业里，所以 magpie 一关它还在
  const wmi = await ps(
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(cmd)} } | ForEach-Object { '{0}|{1}' -f $_.ReturnValue, $_.ProcessId }`,
  );
  let launched = "wmi";
  const answer = String(wmi.stdout || "").trim();
  const [code, childPid] = answer.split("|");
  if (!(wmi.ok && answer && Number(code) === 0)) {
    launched = "spawn";
    try {
      const child = spawn(powershell(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (e) {
      return { ok: false, error: `起不了重启脚本：${wmi.stderr || e.message}` };
    }
  }

  return {
    ok: true,
    pid: app.pid,
    exe: app.exe,
    launched,
    helperPid: Number(childPid) || null,
    script: scriptPath,
    log: LOG,
    waitMs: Math.max(300, Number(delayMs) || 900) + 3000,
  };
}

/** 重启日志的最后几行，界面拿它显示结果。 */
export function restartLog(lines = 12) {
  try {
    const text = readFileSync(LOG, "utf8");
    const rows = text.split(/\r?\n/).filter(Boolean);
    return { path: LOG, rows: rows.slice(-lines) };
  } catch {
    return { path: LOG, rows: [] };
  }
}

export function clearRestartLog() {
  try {
    unlinkSync(LOG);
  } catch {
    /* 本来就没有 */
  }
}

/** 宿主（也就是正在跑的 magpie）自己看到的环境变量。 */
export function liveEnv() {
  const pick = (k) => String(process.env[k] || "").trim();
  const mirrors = pick("MAGPIE_MIRRORS");
  return {
    mirrors,
    mirrorsOn: /^(on|true|1|cn)$/i.test(mirrors),
    base: pick("MAGPIE_GITHUB_MIRROR"),
    npm: pick("MAGPIE_NPM_REGISTRY"),
    nodeEnvProxy: pick("NODE_USE_ENV_PROXY"),
    pid: process.pid,
  };
}

export { LOG as RESTART_LOG };
