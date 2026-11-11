# AI Admin Starter — ตัวเปิดบน Windows 10/11 (PowerShell 5.1 ขึ้นไป)
#   .\ai-admin.ps1 <คำสั่ง>     (ไม่ใส่คำสั่ง = ดูรายการคำสั่ง)
# ไม่ต้องใช้สิทธิ์ admin: ถ้าเครื่องยังไม่มี Node.js 22 จะดาวน์โหลดตัวทางการจาก nodejs.org
# มาไว้ในโฟลเดอร์ .runtime ของชุดนี้ และตรวจลายนิ้วมือ SHA-256 ก่อนใช้
# ต้องมี OpenSSH Client (มากับ Windows 10 1809 ขึ้นไป) — ตรวจด้วย .\ai-admin.ps1 check

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # แถบความคืบหน้าทำให้ดาวน์โหลดช้ามากบน PowerShell 5.1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$App = $PSScriptRoot
$Runtime = Join-Path $App '.runtime'
$NodeMajor = 22
Set-Location $App

function Say([string]$Text) { Write-Host $Text }
function Stop-WithError([string]$Text) { Write-Host "❌ $Text" -ForegroundColor Red; exit 1 }

function Test-NodeNewEnough {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  try { $major = [int](& node -p "process.versions.node.split('.')[0]") } catch { return $false }
  return $major -ge $NodeMajor
}

function Install-PortableNode {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  Say "⬇️  กำลังดาวน์โหลด Node.js $NodeMajor (ตัวทางการจาก nodejs.org) มาไว้ในโฟลเดอร์ .runtime"
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n" | ForEach-Object { $_.Trim() }
  $line = $sums | Where-Object { $_ -match "^[0-9a-f]{64}\s+node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Stop-WithError "ไม่พบ Node.js สำหรับ Windows $arch" }
  $parts = $line -split '\s+'
  $sha = $parts[0]
  $file = $parts[1]
  $tmp = Join-Path $env:TEMP ("ai-admin-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp $file
  Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $sha.ToLower()) {
    Remove-Item $tmp -Recurse -Force
    Stop-WithError "ไฟล์ Node.js ที่ได้ไม่ตรงกับที่ nodejs.org ประกาศ — หยุดเพื่อความปลอดภัย"
  }
  $target = Join-Path $Runtime 'node'
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  Expand-Archive $zip -DestinationPath $Runtime -Force
  Rename-Item (Join-Path $Runtime ($file -replace '\.zip$', '')) 'node'
  Remove-Item $tmp -Recurse -Force
  Say "✅ Node.js พร้อม (อยู่ในโฟลเดอร์ชุดนี้เท่านั้น ไม่แตะระบบ)"
}

function Use-Node {
  $portable = Join-Path $Runtime 'node'
  if (Test-Path (Join-Path $portable 'node.exe')) { $env:Path = "$portable;$env:Path" }
  if (Test-NodeNewEnough) { return }
  Install-PortableNode
  $env:Path = "$portable;$env:Path"
}

Use-Node
& node (Join-Path $App 'starter\cli.mjs') @args
exit $LASTEXITCODE
