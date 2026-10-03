<#
  start-kb.ps1 —— 《BanG Dream! Our Notes》资料库 一键启动
  自检 → 自动补环境（ollama/kb.json/嵌入缓存）→ 交互菜单
  用法：
    .\start-kb.ps1               默认：自检后自动启动 HTTP MCP 服务器；若 kb.json/嵌入缓存
                                 比运行中的服务新，**自动重启**它（免手动停进程）
    .\start-kb.ps1 -Menu         进交互菜单（手动选 [1]~[7]）
    .\start-kb.ps1 -NoRestart    已在运行时只提示，不检查新旧、不重启
    .\start-kb.ps1 -Auto         只跑自检与自动修复（非交互，适合脚本调度）
  菜单 [1] stdio（DSH 默认注册的方式）/[6] HTTP streamable-http（http://127.0.0.1:8787/mcp，
  与 MYGO_MCP 同形态，可被任何 MCP 客户端按 URL 连）；两条传输共用同一份工具实现。
  注意：本文件必须保持 UTF-8 BOM（Windows PowerShell 5.1 依赖它识别中文），
  请用 write/完整重写的方式修改，不要用行内编辑工具（会剥掉 BOM）；
  万一行内改过，改完必须补回 BOM：
    $b=[IO.File]::ReadAllBytes('start-kb.ps1'); if($b[0] -ne 0xEF){ [IO.File]::WriteAllBytes((Resolve-Path 'start-kb.ps1'), [byte[]](0xEF,0xBB,0xBF)+$b) }
#>
param([switch]$Auto, [switch]$Menu, [switch]$NoRestart)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$OLLAMA = $env:OLLAMA_URL
if (-not $OLLAMA) { $OLLAMA = 'http://localhost:11434' }
$EMBED = $env:EMBED_MODEL
if (-not $EMBED) { $EMBED = 'qwen3-embedding:0.6b' }

function T($msg) { Write-Host $msg -ForegroundColor Cyan }
function OK($msg) { Write-Host ('  [OK] ' + $msg) -ForegroundColor Green }
function NG($msg) { Write-Host ('  [!!] ' + $msg) -ForegroundColor Yellow }
function HR { Write-Host ('-' * 60) -ForegroundColor DarkGray }
# 找某端口 LISTENING 的属主 PID：优先 netstat（不依赖 CIM，受限环境也可用），失败再退 Get-NetTCPConnection
function Get-HttpOwnerPid([int]$Port) {
  $pids = @()
  try {
    $pids = netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING' |
      ForEach-Object { ($_.ToString().Trim() -split '\s+')[-1] } | Sort-Object -Unique
  } catch {}
  if (-not $pids) {
    try { $pids = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop).OwningProcess | Sort-Object -Unique } catch {}
  }
  return @($pids)
}

# ---------- 1. node ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host '[FAIL] 未找到 node，请先安装 Node.js 18+' -ForegroundColor Red; exit 1 }
T "node 版本：$(& node --version)"

# ---------- 2. ollama ----------
$ollamaOk = $false
try {
  $r = Invoke-RestMethod "$OLLAMA/api/tags" -TimeoutSec 4 -Method Get
  $ollamaOk = $true
  $hasEmbed = $r.models | Where-Object { $_.name -like "$EMBED*" }
  OK "ollama 可达（$OLLAMA）"
  if ($hasEmbed) { OK "嵌入模型 $EMBED 已就绪" }
  else { NG "缺少嵌入模型 $EMBED —— 可运行：ollama pull $EMBED" }
} catch {
  NG "ollama 不可达（$OLLAMA），尝试启动…"
  $oll = Get-Command ollama -ErrorAction SilentlyContinue
  if ($oll) {
    Start-Process $oll.Source -ArgumentList 'serve' -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      try { $null = Invoke-RestMethod "$OLLAMA/api/tags" -TimeoutSec 2; $ollamaOk = $true; break } catch {}
    }
    if ($ollamaOk) { OK 'ollama 已启动' } else { NG 'ollama 启动超时（可手动 ollama serve）' }
  } else { NG '未找到 ollama，请先安装（https://ollama.com）' }
}

# ---------- 3. 资料库 kb.json ----------
$KB = Join-Path $Root '资料库\kb.json'
if (-not (Test-Path $KB)) {
  T '资料库 kb.json 不存在，重建中…'
  & node 工具/build_kb.mjs
  if (-not (Test-Path $KB)) { Write-Host '[FAIL] kb.json 生成失败' -ForegroundColor Red; exit 1 }
}
OK "资料库就绪：$KB"

# ---------- 4. 嵌入缓存（需要 ollama） ----------
$Cache = Join-Path $Root '资料库\.kb-embeddings.json'
if ((-not (Test-Path $Cache)) -and $ollamaOk) {
  T '嵌入缓存未就绪，首次计算中（约 10~30 秒）…'
  & node mcp-canon/_selfcheck.mjs | Out-Null
  # 上面的自检只确认可加载；这里显式预热缓存
  & node -e "import('./mcp-canon/canon-tools.mjs').then(async m => { await m.loadVectors(); console.log('embeddings ready'); })"
}
if (Test-Path $Cache) {
  $kbSize = [math]::Round((Get-Item $Cache).Length / 1KB)
  OK "嵌入缓存就绪（$kbSize KB）"
} else {
  NG '嵌入缓存缺失（ollama 未就绪或构建失败；词汇检索仍可用）'
}

# ---------- 5. MCP 服务器自检 ----------
T 'MCP 服务器自检…'
$mcpOk = $false
try {
  $init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"starter","version":"1"}}}'
  $out = $init | & node mcp-canon/canon-mcp-server.mjs 2>$null | Select-Object -First 1
  $r = $out | ConvertFrom-Json
  if ($r.result.serverInfo) {
    OK "MCP 握手成功：$($r.result.serverInfo.name) v$($r.result.serverInfo.version)"
    $mcpOk = $true
  }
} catch {}
if (-not $mcpOk) {
  # 某些宿主（Windows PowerShell 5.1 / 沙箱文件重定向）下 stdin 管道不投递字节，
  # 退化为模块加载检查；真实连通性以 DSH 的 mcp_manager_list（已注册 15 工具）为准。
  try {
    $chk = & node mcp-canon/_selfcheck.mjs 2>$null | Select-Object -Last 1
    if ($chk -match 'tools:\d+') {
      OK "MCP 逻辑可加载（$chk）；stdio 握手受宿主管道限制跳过，真实连通以 DSH mcp_manager_list 为准"
    } else {
      NG "MCP 模块加载检查未通过：$chk"
    }
  } catch {
    NG "MCP 模块加载失败：$($_.Exception.Message)"
  }
}

# ---------- 5b. HTTP 端点（streamable-http，可选；与 stdio 同一份工具实现） ----------
$HttpPort = if ($env:CANON_HTTP_PORT) { [int]$env:CANON_HTTP_PORT } else { 8787 }
$HttpPath = if ($env:CANON_HTTP_PATH) { $env:CANON_HTTP_PATH } else { '/mcp' }
try {
  $h = Invoke-RestMethod ("http://127.0.0.1:$HttpPort/health") -TimeoutSec 3
  OK "HTTP MCP 已在运行：http://127.0.0.1:$HttpPort$HttpPath（$($h.server.name) v$($h.server.version)，$($h.tools) 工具）"
} catch {
  T "HTTP MCP 未运行（可选）：菜单 [6] 启动，或 node mcp-canon/canon-mcp-http.mjs"
}

HR
T "环境自检完成：ollama=$ollamaOk  嵌入缓存=$(Test-Path $Cache)"
if ($Auto) { Write-Host '（-Auto：仅自检，已结束）' -ForegroundColor DarkGray; exit 0 }

# ---------- 6. 默认自动启动（免手动选菜单；kb 比服务新则自动重启） ----------
if (-not $Menu) {
  HR
  T '默认模式：自检完成，自动启动 HTTP MCP 服务器（加 -Menu 可进交互菜单）'

  $running = $null
  try { $running = Invoke-RestMethod ("http://127.0.0.1:$HttpPort/health") -TimeoutSec 3 } catch {}
  $needStart = $true

  if ($running) {
    # 服务启动时刻 = 现在 − uptime；资料库最新修改时间 = max(kb.json, 嵌入缓存)
    $serverStart = $null
    if ($null -ne $running.uptimeSec) { $serverStart = (Get-Date).AddSeconds(-1 * [double]$running.uptimeSec) }
    $kbTime = (Get-Item $KB).LastWriteTime
    $newest = $kbTime
    if ((Test-Path $Cache) -and (Get-Item $Cache).LastWriteTime -gt $newest) { $newest = (Get-Item $Cache).LastWriteTime }

    if ($NoRestart) {
      OK "HTTP MCP 已在运行：http://127.0.0.1:$HttpPort$HttpPath —— 按 -NoRestart，不比较新旧"
      $needStart = $false
    } elseif ($null -eq $serverStart) {
      NG "HTTP MCP 已在运行，但服务未提供 uptime，无法判断是否比资料库新；如需生效请手动重启"
      $needStart = $false
    } elseif ($newest -le $serverStart.AddSeconds(2)) {
      OK "HTTP MCP 已在运行且是最新（服务启动 $($serverStart.ToString('HH:mm:ss')) ｜ kb $($kbTime.ToString('HH:mm:ss'))）—— 无需重启"
      $needStart = $false
    } else {
      NG "资料库比运行中的服务新（服务 $($serverStart.ToString('HH:mm:ss')) 启动 ｜ 最新 $($newest.ToString('HH:mm:ss'))）→ 自动重启"
      foreach ($procId in (Get-HttpOwnerPid -Port $HttpPort)) {
        $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($pr -and $pr.ProcessName -eq 'node') { Stop-Process -Id $procId -Force; OK "已停旧服务（PID $procId）" }
        else { NG "端口属主 PID $procId 不是 node，未处理" }
      }
      # 等端口真正释放，避免新进程 EADDRINUSE
      for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Milliseconds 250
        $alive = $false
        try { $null = Invoke-RestMethod ("http://127.0.0.1:$HttpPort/health") -TimeoutSec 1; $alive = $true } catch {}
        if (-not $alive) { break }
      }
      $needStart = $true
    }
  }

  if ($needStart) {
    Write-Host "启动 MCP 服务器（streamable-http）→ http://127.0.0.1:$HttpPort$HttpPath …按 Ctrl+C 停止" -ForegroundColor Cyan
    & node mcp-canon/canon-mcp-http.mjs
    Write-Host '服务器已退出' -ForegroundColor DarkGray
  }
  exit 0
}

# ---------- 6b. 交互菜单（-Menu） ----------
while ($true) {
  HR
  Write-Host ''
  Write-Host '  [1] 启动 MCP 服务器（stdio，前台，Ctrl+C 退出）' -ForegroundColor White
  Write-Host '  [2] 资料库冒烟测试（_test-tools.mjs）' -ForegroundColor White
  Write-Host '  [3] 资料库 CLI 检索（工具/canon.mjs 交互）' -ForegroundColor White
  Write-Host '  [4] 重建资料库（build_kb + 重算嵌入）' -ForegroundColor White
  Write-Host '  [5] 重新自检' -ForegroundColor White
  Write-Host '  [6] 启动 MCP 服务器（HTTP/streamable-http，前台，Ctrl+C 退出）' -ForegroundColor White
  Write-Host '  [7] HTTP 端点体检（/health + /tools）' -ForegroundColor White
  Write-Host '  [0] 退出' -ForegroundColor DarkGray
  $c = Read-Host '请选择'
  switch ($c) {
    '1' {
      Write-Host '启动 MCP 服务器（stdio）…按 Ctrl+C 停止' -ForegroundColor Cyan
      & node mcp-canon/canon-mcp-server.mjs
    }
    '2' { & node mcp-canon/_test-tools.mjs }
    '3' {
      Write-Host '输入 canon.mjs 命令，例如：char 灯 / search 一辈子 / rel 灯 祥子 / who ……' -ForegroundColor Cyan
      while ($true) {
        $q = Read-Host 'canon>'
        if ($q -in @('q', 'exit', 'quit', '')) { break }
        Invoke-Expression ('node 工具/canon.mjs ' + $q)
      }
    }
    '4' {
      & node 工具/build_kb.mjs
      Remove-Item $Cache -ErrorAction SilentlyContinue
      & node -e "import('./mcp-canon/canon-tools.mjs').then(async m => { await m.loadVectors(); console.log('embeddings rebuilt'); })"
      Write-Host '重建完成' -ForegroundColor Green
    }
    '5' { }
    '6' {
      Write-Host "启动 MCP 服务器（streamable-http）→ http://127.0.0.1:$HttpPort$HttpPath …按 Ctrl+C 停止" -ForegroundColor Cyan
      & node mcp-canon/canon-mcp-http.mjs
    }
    '7' {
      try {
        $h = Invoke-RestMethod ("http://127.0.0.1:$HttpPort/health") -TimeoutSec 4
        OK "运行中：$($h.server.name) v$($h.server.version) · $($h.tools) 工具 · 端点 http://127.0.0.1:$HttpPort$HttpPath"
        $t = Invoke-RestMethod ("http://127.0.0.1:$HttpPort/tools") -TimeoutSec 4
        Write-Host ('  工具：' + (($t.tools | ForEach-Object { $_.name }) -join '、')) -ForegroundColor Gray
      } catch {
        NG "连不上 http://127.0.0.1:$HttpPort/health —— 先按 [6] 启动（$($_.Exception.Message)）"
      }
    }
    '0' { exit 0 }
    default { }
  }
}