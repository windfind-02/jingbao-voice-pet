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
const PET_VERSION = "1.8.0";   // 当前版本（发布时与 client.js 同步 + 更新仓库 version 文件）
/** ⚠️ 低于此版本的安装无法再自更新，必须卸载重装。
 *  1.8.0 是「仓库从 plugin/ 子目录改为官方组合包结构（仓库根即包）」的那次破坏性
 *  改动，旧版写死的下载地址 /plugin/lib/client.js 在新仓库里已不存在。 */
const MIN_REINSTALL_VERSION = "1.8.0";
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
// ═══════════════════════════════════════════════════════════════════
//  素材静态路由（Web 端 + 桌面端通用）—— 桌面端适配的关键
//  ── 背景：素材以前被复制进 DSH 前端 dist 目录，靠 webserver 的 SPA 静态
//     回退（frontend-static）顺带提供。但桌面端（Electron）的 dist 打包在
//     只读的 app.asar 里，既写不进也换不掉。
//  ── 出路：桌面端把 dsh-app://app/<非 /assets/ 路径> 的请求原样转发给 DSH
//     本体的 webserver（见桌面端 main.js 的 forwardWebRequest）。于是插件
//     自己注册具名路由，两个宿主就都通了，而且 client.js 一行都不用改
//     （这点很重要：桌宠的半自动更新会覆盖 client.js，改它会被冲掉）。
//  ── 路由用 exact 逐文件注册：webserver 匹配顺序是「精确 → 最长前缀 →
//     回退」，精确路由赢过 frontend-static 的回退席位，且 client.js 里的
//     `?v=3` 查询串不参与匹配，不影响命中。
// ═══════════════════════════════════════════════════════════════════
/** 素材扩展名 → MIME。 */
const MIME_TYPES = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml"
};
/** 素材根目录：插件自带 assets/（首选，随插件走）。 */
const ASSET_DIR = path.resolve(__dirname, "..", "assets");
/** 按优先级找一个素材文件；找不到返回 null。 */
function findAsset(name) {
  const dirs = [ASSET_DIR];
  const dist = findDistDir();          // 兼容旧安装：素材曾被复制进前端 dist
  if (dist) dirs.push(dist);
  for (const dir of dirs) {
    try {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    } catch (e) { /* ignore */ }
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
/** 执行更新：下载新版 client.js + 全部素材 → 写插件目录 + 自带 assets。 */
async function doUpdate() {
  // 1. 新版 client.js → 插件目录（覆盖后重启生效）
  // 注意路径：仓库已按官方组合包规范重组，**仓库根就是包本身**，所以是 /lib/client.js
  // （旧结构是 /plugin/lib/client.js，那个路径现在会 404）
  await downloadFile(RAW_BASE + "/lib/client.js", path.join(PLUGIN_DIR, "client.js"));
  // 2. 素材 → 插件自带 assets/（桌面端 dist 在只读 asar 里写不进，
  //    且插件注册的 exact 路由优先于 frontend-static 的静态回退）
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  for (const a of ASSETS) {
    await downloadFile(RAW_BASE + "/assets/" + a, path.join(ASSET_DIR, a));
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

  // ═══ 素材静态路由：放在最前面 ═══
  // 把 client.js 引用的 /pet_*.png|webp、/voice_*.mp3 直接由插件自己在 DSH 本体
  // 的 webserver 上提供（桌面端经 dsh-app:// 转发命中，Web 端则优先于 SPA 静态
  // 回退）。文件每次请求现读，换素材无需重启。放在 apply 开头是刻意的：素材服务
  // 是「客户端能不能正常显示」的硬需求，不该被后面任何初始化（nvidia-smi、端口
  // 占用等）失败拖累。
  ctx.inject(["webServer"], (webCtx) => {
    for (const name of ASSETS) {
      const route = "/" + name;
      try {
        webCtx.effect(() => webCtx.webServer.register({
          kind: "exact",
          path: route,
          handler: (req, res) => {
            const file = findAsset(name);
            if (!file) {
              res.writeHead(404, { "Cache-Control": "no-store" });
              res.end();
              return;
            }
            const type = MIME_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream";
            fs.stat(file, (err, stat) => {
              if (err) {
                res.writeHead(500, { "Cache-Control": "no-store" });
                res.end();
                return;
              }
              const total = stat.size;
              // ⚠️ 必须支持 HTTP Range：Chromium 播 MP3 时会发 `Range: bytes=0-`
              // 并期待 206。若一律回 200 全量（且桌面端转发时 content-length 还被
              // Electron 删掉），播放器会反复重连、从头解码 —— 听感就是「语音截断
              // 并重复播放几次」。旧方式把素材放 dist、由 DSH 静态服务器提供时，
              // Range 是天然支持的，所以这个坑只在插件自建路由时出现。
              const range = req.headers.range;
              const commonHeaders = {
                "Content-Type": type,
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=604800",
                "Access-Control-Allow-Origin": "*"
              };
              if (range) {
                const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
                let start = m && m[1] !== "" ? parseInt(m[1], 10) : 0;
                let end = m && m[2] !== "" ? parseInt(m[2], 10) : total - 1;
                if (!Number.isFinite(start) || start < 0) start = 0;
                if (!Number.isFinite(end) || end >= total) end = total - 1;
                if (start > end || start >= total) {
                  res.writeHead(416, { "Content-Range": "bytes */" + total });
                  res.end();
                  return;
                }
                res.writeHead(206, {
                  ...commonHeaders,
                  "Content-Range": "bytes " + start + "-" + end + "/" + total,
                  "Content-Length": end - start + 1
                });
                if (req.method === "HEAD") { res.end(); return; }
                fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
                return;
              }
              res.writeHead(200, { ...commonHeaders, "Content-Length": total });
              if (req.method === "HEAD") { res.end(); return; }
              fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
            });
          }
        }), "pet.asset:" + name);
      } catch (e) {
        console.warn("[dsh-pet] 素材路由注册失败 " + route + "：" + String((e && e.message) || e));
      }
    }
  });

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
    // try/catch 是必需的：execFile 在 spawn 阶段就会**同步**抛错（例如
    // nvidia-smi 不在 PATH、或被沙箱禁止 spawn 子进程），不接住的话整个 apply
    // 会被中断，8765 监控服务和素材路由都会一起消失。
    try {
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
    } catch (e) { /* spawn 失败 → 静默，保持旧值 */ }
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
          // ⚠️ 1.8.0 是「仓库结构从 plugin/ 移到根」的那次破坏性改动：
          //    旧结构的下载路径（/plugin/lib/client.js）在新仓库里已不存在，
          //    所以低于 MIN_REINSTALL_VERSION 的安装**无法再自更新**，必须重装。
          const needReinstall = isOlder(PET_VERSION, MIN_REINSTALL_VERSION);
          send(200, {
            current: PET_VERSION,
            latest: latest,
            hasUpdate: !!(latest && isOlder(PET_VERSION, latest)),
            minVersion: MIN_REINSTALL_VERSION,
            requiresReinstall: needReinstall,
            notice: needReinstall
              ? "当前安装是 " + MIN_REINSTALL_VERSION + " 之前的旧结构，已无法自动更新。请卸载后重新安装新版（见 README 的安装说明）。"
              : ""
          });
        }).catch(() => send(200, { current: PET_VERSION, latest: null, hasUpdate: false }));
      } else if (req.url === "/do-update") {
        doUpdate().then(() => {
          send(200, { ok: true, message: "更新完成，重启后生效。（这里只更新了客户端与素材；若涉及服务端改动，请用 dsh plugin update 完整更新）" });
        }).catch((e) => {
          const msg = String((e && e.message) || e);
          // 旧结构（1.8.0 之前）下载路径已失效 → 给可操作的提示，而不是干巴巴的 HTTP 404
          const friendly = /40[34]/.test(msg)
            ? "更新失败（" + msg + "）：很可能是 1.8.0 之前的旧安装结构，下载地址已变更。请卸载后重新安装新版，之后再更新就正常了（见 README）。"
            : msg;
          send(500, { ok: false, message: friendly });
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
