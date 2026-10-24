# 鲸鱼娘陪玩 · 一键安装
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Write-Host "== 安装目录：$root" -ForegroundColor Cyan

# 1) Electron 浮层依赖
Write-Host "[1/3] 安装 Electron ..." -ForegroundColor Cyan
Push-Location (Join-Path $root 'overlay')
try {
  npm install --no-audit --no-fund
  # 有些环境会拦掉 npm 的 postinstall（electron 的二进制就下不来）⇒ 手动补一次
  $exe = Join-Path (Get-Location) 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $exe)) {
    Write-Host '    补装 electron 二进制 ...' -ForegroundColor DarkGray
    node node_modules\electron\install.js
  }
} finally { Pop-Location }

# 2) Python 抓屏依赖
Write-Host "[2/3] 准备 Python 环境（Pillow）..." -ForegroundColor Cyan
Push-Location (Join-Path $root 'bridge')
try {
  if (-not (Test-Path '.venv')) { python -m venv .venv }
  & .\.venv\Scripts\python.exe -m pip install --quiet -r requirements.txt
  if (-not (Test-Path 'AGENTS.md')) { Copy-Item 'AGENTS.example.md' 'AGENTS.md' }
} finally { Pop-Location }

# 3) 自检
Write-Host "[3/3] 自检 ..." -ForegroundColor Cyan
$py = Join-Path $root 'bridge\.venv\Scripts\python.exe'
& $py -c "from PIL import ImageGrab; print('Pillow OK')"
$electron = Join-Path $root 'overlay\node_modules\electron\dist\electron.exe'
if (Test-Path $electron) { Write-Host "Electron OK" } else { Write-Warning "Electron 没装上，浮层起不来" }

Write-Host ""
Write-Host "安装完成。执行下面这条把它挂进 DSH：" -ForegroundColor Green
Write-Host "  dsh plugin --profile web add link:$root" -ForegroundColor Yellow
Write-Host "然后重启 DSH，进 设置 → 鲸鱼娘 → 启动。"
