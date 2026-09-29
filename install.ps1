# 鲸宝桌宠 · 一键安装脚本
# 用法：右键「使用 PowerShell 运行」，或在本目录执行 .\install.ps1
#
# ── ⭐ 首选安装方式：官方 CLI（推荐） ─────────────────────────────────────
# 本目录现在就是一个标准的 DSH **组合包（bundle）**（package.json 里有
# dsh.bundle，并带 cordis.patch.yml），所以可以直接用 dsh 自己的插件命令安装，
# 它会自动把这个包加进目标 profile 的 bundles 列表，无需手工改配置：
#
#     dsh plugin --profile web add github:windfind-02/jingbao-voice-pet
#     # 本机已克隆/解压时也可以直接指定目录：
#     dsh plugin --profile web add "E:\path\to\jingbao-voice-pet"
#
# 桌面端同理（用桌面端自带 CLI）：
#     & 'E:\DeepSeek harness桌面端\resources\runtime\cli\bin\dsh.cmd' `
#         --profile desktop plugin add github:windfind-02/jingbao-voice-pet
#
# ── 本脚本：不依赖 pnpm 的兜底安装方式 ───────────────────────────────────
# 旧方式把素材复制进 DSH 前端 dist，**桌面端行不通**（dist 打包在只读 app.asar
# 里）。现在素材放在**插件自己的 assets/** 里，由插件在 DSH 本体的 webserver 上
# 注册路由提供 —— 桌面端会把 dsh-app://app/<非 /assets/ 路径> 的请求转发给本体
# webserver，所以同一套插件在 Web 端与桌面端都能工作。
# 附带好处：client.js 一个字都不用改（它原本就用 /pet_*.webp 这种根路径）。
$ErrorActionPreference = "Stop"
$HomeDsh = Join-Path $env:USERPROFILE ".dsh"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "🐳 鲸宝桌宠安装脚本（兜底方式，推荐优先用 dsh plugin add）" -ForegroundColor Cyan
Write-Host "================================"

# 1. 插件本体（所有 profile 共用这一份）
Write-Host "📦 [1/4] 复制插件..." -ForegroundColor Yellow
$pluginDir = Join-Path $HomeDsh "profiles\node_modules\@local\dsh-pet"
New-Item -ItemType Directory -Force (Join-Path $pluginDir "lib") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $pluginDir "assets") | Out-Null
Copy-Item (Join-Path $Here "package.json") $pluginDir -Force
Copy-Item (Join-Path $Here "lib\index.js") (Join-Path $pluginDir "lib") -Force
Copy-Item (Join-Path $Here "lib\client.js") (Join-Path $pluginDir "lib") -Force

# 2. 素材 → 插件自带 assets（不再进前端 dist）
Write-Host "🎨 [2/4] 部署素材到插件 assets..." -ForegroundColor Yellow
Copy-Item (Join-Path $Here "assets\*") (Join-Path $pluginDir "assets") -Force
$assetCount = (Get-ChildItem (Join-Path $pluginDir "assets") -File).Count
Write-Host "   已部署 $assetCount 个素材" -ForegroundColor Green

# 3. 为每个已存在的 profile 建立 @local 解析并注册插件
Write-Host "📝 [3/4] 注册到 profile..." -ForegroundColor Yellow
$sharedLocal = Join-Path $HomeDsh "profiles\node_modules\@local"
$profilesDir = Join-Path $HomeDsh "profiles"
$targets = @()
if (Test-Path $profilesDir) {
  $targets = @(Get-ChildItem $profilesDir -Directory |
    Where-Object { $_.Name -ne "node_modules" -and (Test-Path (Join-Path $_.FullName "cordis.patch.yml")) })
}
if ($targets.Count -eq 0) {
  # 一个 profile 都没有：至少把默认的 web 建出来
  New-Item -ItemType Directory -Force (Join-Path $profilesDir "web") | Out-Null
  $targets = @(Get-Item (Join-Path $profilesDir "web"))
}

foreach ($profile in $targets) {
  $name = $profile.Name
  $localLink = Join-Path $profile.FullName "node_modules\@local"
  New-Item -ItemType Directory -Force (Split-Path $localLink) | Out-Null
  if (-not (Test-Path $localLink)) {
    # junction 让该 profile 能解析 @local/*（Windows 上不需要管理员权限）
    New-Item -ItemType Junction -Path $localLink -Target $sharedLocal | Out-Null
    Write-Host "   [$name] 已建立 @local 解析（junction）" -ForegroundColor Green
  }

  $patchFile = Join-Path $profile.FullName "cordis.patch.yml"
  $needRegister = -not (Test-Path $patchFile) -or -not (Select-String -Path $patchFile -Pattern "id: pet" -Quiet)
  if ($needRegister) {
    $entry = @"

# 🐳 鲸宝桌宠（素材由插件自己在 webserver 上注册路由提供，见 assets/）
- insert:
    - id: pet
      name: '@local/dsh-pet'
"@
    Add-Content -Path $patchFile -Value $entry -Encoding UTF8
    Write-Host "   [$name] 已注册 pet 插件" -ForegroundColor Green
  } else {
    Write-Host "   [$name] 已注册过，跳过" -ForegroundColor Green
  }
}

# 4. 提示重启
Write-Host "🚀 [4/4] 完成！" -ForegroundColor Yellow
Write-Host ""
Write-Host "✅ 鲸宝桌宠安装完成！" -ForegroundColor Green
Write-Host "已为以下 profile 注册：$((($targets | ForEach-Object { $_.Name }) -join ', '))" -ForegroundColor Gray
Write-Host ""
Write-Host "重启后生效：" -ForegroundColor Gray
Write-Host "  · 网页版：重启 dsh web，浏览器 Ctrl+F5" -ForegroundColor Gray
Write-Host "  · 桌面端：托盘图标右键退出后重新打开（桌面端没有刷新快捷键，需要真重启）" -ForegroundColor Gray
Write-Host ""
Write-Host "（可选）系统监控已内置：右键菜单开启后自动运行，无需额外启动服务" -ForegroundColor Gray
