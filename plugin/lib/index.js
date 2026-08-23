// @local/dsh-pet —— 鲸宝 Q 版桌宠。
// 服务端入口：负责「系统监控」数据服务 + 「半自动更新」，随 DSH 启动/停止自动启停。
//  - HTTP 服务监听 127.0.0.1:8765，提供 GET /stats（CPU/内存/GPU）
//  - GPU 数据：每 1 秒调 nvidia-smi 写入 gpu.json（client 端 fetch /stats 读取）
//  - 自动更新（半自动）：GET /check-update 对比 GitHub 版本号；GET /do-update
//    下载新版 client.js + 素材到本地（用户确认后由前端调用）
//  - 生命周期：apply 时启动，dispose 时关闭（Cordis 标准），DSH 重启自动恢复
// 前端逻辑在 ./client.js（package.json 的 "./client" 子路径导出）。
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
// ⚠️ ESM 坑（血泪教训）：package.json 声明 "type": "module"，index.js 按 ES module 解析，
//    原生没有 __dirname（CommonJS 全局变量）→ 直接用 path.resolve(__dirname) 会炸。
//    必须用 import.meta.url 补定义（dsh-bg-image 没踩坑是因为它没用 __dirname）。
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** gpu.json 固定位置（client.js 的 stats-server 逻辑与历史脚本共用）。 */
const GPU_FILE = path.join("E:\\", "Deepseek harness", "图像理解测试", "gpu.json");

/** 写 JSON（无 BOM，UTF-8；避免 PowerShell Set-Content 带 BOM 导致 JSON.parse 失败）。 */
function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj), { encoding: "utf8" });
  } catch (e) { /* 写失败静默（比如路径不可写） */ }
}

// ═══════════════════════════════════════════════════════════════════
//  半自动更新（检测 + 用户确认后替换，发布时同步 PET_VERSION）
// ═══════════════════════════════════════════════════════════════════
const PET_VERSION = "1.7.0";   // 当前版本（发布时与 client.js 同步 + 更新仓库 version 文件）
const REPO_OWNER = "windfind-02";
const REPO_NAME = "jingbao-voice-pet";
const RAW_BASE = "https://raw.githubusercontent.com/" + REPO_OWNER + "/" + REPO_NAME + "/main";
const VERSION_URL = RAW_BASE + "/version";
/** 本插件目录（profiles\node_modules\@local\dsh-pet\lib\）。 */
const PLUGIN_DIR = path.resolve(__dirname);
/** 素材清单（从仓库下载并写进 DSH 前端 dist；与发布包 assets 一致）。 */
const ASSETS = [
  "pet.png", "pet_blink.webp", "pet_grab.webp", "pet_heart.png", "pet_heart.webp",
  "pet_shake.webp", "pet_sleepy.png", "pet_sleepy.webp", "pet_sleepy_f0.png",
  "pet_smile.webp", "pet_wakeup.webp", "pet_wave.png", "pet_wave.webp", "pet_yawn.webp",
  "voice_ask_1.mp3", "voice_ask_2.mp3", "voice_ask_3.mp3",
  "voice_confirm_1.mp3", "voice_confirm_2.mp3", "voice_confirm_3.mp3", "voice_confirm_4.mp3",
  "voice_done_1.mp3", "voice_done_2.mp3", "voice_done_3.mp3",
  "voice_poke_1.mp3", "voice_poke_2.mp3", "voice_poke_3.mp3", "voice_poke_4.mp3"
];
/** 找 DSH 前端 dist 目录（候选路径，与 install.ps1 一致）。 */
function findDistDir() {
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist"),
    path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist")
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}
/** 版本号逐段比较：a < b 返回 true。 */
function isOlder(a, b) {
  try {
    const pa = String(a || "").split(".").map((x) => parseInt(x, 10) || 0);
    const pb = String(b || "").split(".").map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] || 0, vb = pb[i] || 0;
      if (va !== vb) return va < vb;
    }
    return false;
  } catch (e) { return false; }
}
let updateCache = null;  // { latest, checkedAt }
/** 检查 GitHub 上的最新版本（缓存 10 分钟；网络失败返回 null）。 */
async function checkUpdate() {
  try {
    if (updateCache && Date.now() - updateCache.checkedAt < 10 * 60 * 1000) return updateCache;
    const resp = await fetch(VERSION_URL, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return updateCache || null;
    const latest = (await resp.text()).trim() || null;
    if (latest) updateCache = { latest, checkedAt: Date.now() };
    return updateCache || null;
  } catch (e) {
    return updateCache || null;  // 网络失败：返回上次结果（可能为 null）
  }
}
/** 下载单个文件并写盘。 */
async function downloadFile(url, dest) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
}
/** 执行更新：下载新版 client.js + 全部素材 → 写插件目录 + dist。 */
async function doUpdate() {
  const dist = findDistDir();
  if (!dist) throw new Error("找不到 DSH 前端 dist 目录");
  // 1. 新版 client.js → 插件目录（覆盖后重启生效）
  await downloadFile(RAW_BASE + "/plugin/lib/client.js", path.join(PLUGIN_DIR, "client.js"));
  // 2. 素材 → dist
  for (const a of ASSETS) {
    await downloadFile(RAW_BASE + "/assets/" + a, path.join(dist, a));
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════
//  余额显示（DeepSeek 开放平台 /user/balance，key 存本地，server 端调）
// ═══════════════════════════════════════════════════════════════════
const BALANCE_KEY_FILE = path.join(PLUGIN_DIR, "balance.key");  // 用户菜单里填的 API key
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
/** 获取 DeepSeek API key：优先菜单里配置的 balance.key，回退到 DSH 本地凭证 .dsh/.credentials.yaml 的 DEEPSEEK_API_KEY
 * （官网 key 会隐藏无法复制，直接读 DSH 自带的凭证最省事）。 */
function getBalanceKey() {
  // 1. 菜单里配置的 key（balance.key）
  try { const k = fs.readFileSync(BALANCE_KEY_FILE, "utf8").trim(); if (k) return k; } catch (e) { /* ignore */ }
  // 2. 回退：DSH 本地凭证 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY（正则解析 YAML）
  try {
    const cred = path.join(os.homedir(), ".dsh", ".credentials.yaml");
    if (fs.existsSync(cred)) {
      const txt = fs.readFileSync(cred, "utf8");
      const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^\s"']+)/m);
      if (m && m[1]) return m[1];
    }
  } catch (e) { /* ignore */ }
  return null;
}
/** 调 DeepSeek 余额接口。 */
async function fetchBalance() {
  const key = getBalanceKey();
  if (!key) return { ok: false, error: "no_key" };
  const resp = await fetch(DEEPSEEK_BALANCE_URL, {
    headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  if (!resp.ok) return { ok: false, error: "HTTP " + resp.status };
  const data = await resp.json();
  return {
    ok: true,
    is_available: !!data.is_available,
    balance_infos: Array.isArray(data.balance_infos) ? data.balance_infos : []
  };
}

function apply(ctx) {
  let gpuCache = null;
  let lastCpu = os.cpus();

  function cpuUsage() {
    try {
      const now = os.cpus();
      let idle = 0, total = 0;
      for (let i = 0; i < now.length; i++) {
        const a = lastCpu[i].times, b = now[i].times;
        const diffIdle = b.idle - a.idle;
        const diffTotal = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + diffIdle + (b.irq - a.irq);
        idle += diffIdle; total += diffTotal;
      }
      lastCpu = now;
      return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0;
    } catch (e) { return 0; }
  }

  function memUsage() {
    try {
      const total = os.totalmem(), free = os.freemem();
      return total > 0 ? Math.max(0, Math.min(100, Math.round((1 - free / total) * 100))) : 0;
    } catch (e) { return 0; }
  }

  /** 查一次 GPU（nvidia-smi → gpu.json），失败保留上次值。 */
  function queryGpu() {
    execFile("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 8000 }, (err, stdout) => {
      if (err) return; // nvidia-smi 不可用（无 N 卡等）→ 保持旧值
      try {
        const parts = stdout.trim().split(",").map((s) => s.trim());
        const usage = parseInt(parts[0], 10);
        const memUsed = parseInt(parts[1], 10);
        const memTotal = parseInt(parts[2], 10);
        if (Number.isFinite(usage) && Number.isFinite(memUsed) && Number.isFinite(memTotal)) {
          gpuCache = { usage, memUsed, memTotal };
          writeJson(GPU_FILE, gpuCache);
        }
      } catch (e) { /* 解析失败忽略 */ }
    });
  }

  queryGpu();
  const gpuTimer = setInterval(queryGpu, 1000);

  // HTTP 服务（监听 127.0.0.1:8765，提供 /stats、/ping、/check-update、/do-update）
  const server = http.createServer((req, res) => {
    try {
      const send = (code, obj) => {
        res.writeHead(code, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store"
        });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/stats") {
        send(200, { cpu: cpuUsage(), mem: memUsage(), gpu: gpuCache });
      } else if (req.url === "/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("pong");
      } else if (req.url === "/check-update") {
        checkUpdate().then((info) => {
          const latest = info ? info.latest : null;
          send(200, {
            current: PET_VERSION,
            latest: latest,
            hasUpdate: !!(latest && isOlder(PET_VERSION, latest))
          });
        }).catch(() => send(200, { current: PET_VERSION, latest: null, hasUpdate: false }));
      } else if (req.url === "/do-update") {
        doUpdate().then(() => {
          send(200, { ok: true, message: "更新完成，重启 dsh web 生效" });
        }).catch((e) => {
          send(500, { ok: false, message: String((e && e.message) || e) });
        });
      } else if (req.url === "/balance") {
        fetchBalance().then((d) => send(200, d)).catch((e) => send(200, { ok: false, error: String((e && e.message) || e) }));
      } else if (req.url === "/balance/configure" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on("end", () => {
          try {
            const j = JSON.parse(body || "{}");
            if (!j.apiKey || !String(j.apiKey).trim()) { send(400, { ok: false, error: "empty key" }); return; }
            fs.writeFileSync(BALANCE_KEY_FILE, String(j.apiKey).trim(), "utf8");
            send(200, { ok: true });
          } catch (e) { send(400, { ok: false, error: String(e) }); }
        });
      } else {
        res.writeHead(404); res.end();
      }
    } catch (e) { res.writeHead(500); res.end(); }
  });
  server.on("error", (e) => {
    // 8765 被占用（比如旧 stats-server 还在跑）→ 记录但不崩溃，前端仍可访问旧服务
    if (e.code === "EADDRINUSE") {
      console.log("[dsh-pet] 8765 已被占用（旧 stats-server？），内置监控服务跳过监听");
    }
  });
  server.listen(8765, "127.0.0.1", () => {
    console.log("[dsh-pet] 监控服务已启动 http://127.0.0.1:8765/stats");
  });

  // 插件卸载/DSH 停止 → 关掉服务与定时器（不残留进程）
  ctx.on("dispose", () => {
    try { server.close(); } catch (e) { /* 忽略 */ }
    clearInterval(gpuTimer);
  });
}

export { apply };
