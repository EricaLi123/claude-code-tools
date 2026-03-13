# 测试 WT tab 视觉提示手段
# 用法：powershell -File scripts/test-tab-indicator.ps1
# 运行后切到另一个 tab 观察效果

$ESC = [char]0x1b
$BEL = [char]0x07
$ST  = "$ESC\"

Write-Host "Each step lasts 8 seconds. Switch to another tab to observe." -ForegroundColor Cyan
Write-Host ""

# --- 手段 1: Tab 标题 ---
Write-Host "[1] Tab title change" -ForegroundColor Yellow
[Console]::Title = "⚠ Claude Done - needs attention"
Start-Sleep -Seconds 8

# --- 手段 2: BEL (bell icon) ---
Write-Host "[2] BEL character" -ForegroundColor Yellow
Write-Host "$BEL" -NoNewline
Start-Sleep -Seconds 8

# --- 手段 3: Tab 背景色 (OSC 4;264) ---
Write-Host "[3] Tab color: RED" -ForegroundColor Yellow
Write-Host "$ESC]4;264;rgb:cc/33/33$ST" -NoNewline
Start-Sleep -Seconds 8

Write-Host "[4] Tab color: ORANGE" -ForegroundColor Yellow
Write-Host "$ESC]4;264;rgb:ff/99/00$ST" -NoNewline
Start-Sleep -Seconds 8

Write-Host "[5] Tab color: GREEN" -ForegroundColor Yellow
Write-Host "$ESC]4;264;rgb:33/cc/33$ST" -NoNewline
Start-Sleep -Seconds 8

# --- 清除：重置 tab 颜色 ---
Write-Host "$ESC]104;264$ST" -NoNewline

Write-Host ""
Write-Host "Done. Press Enter to restore title..." -ForegroundColor Green
Read-Host
[Console]::Title = ""
