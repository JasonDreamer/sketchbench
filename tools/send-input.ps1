# 開発中の動作確認: ウィンドウ内の相対位置(0〜1)をクリックし、キーを送る。
# 使い方: powershell -File tools/send-input.ps1 -Title Sketchbench -X 0.5 -Y 0.4 -Keys " "
param([string]$Title = "Sketchbench", [double]$X = 0.5, [double]$Y = 0.4, [string]$Keys = "")
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WI {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public struct RECT { public int L, T, R, B; }
}
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1
if (-not $p) { Write-Error "window not found"; exit 1 }
$h = $p.MainWindowHandle
[WI]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 200
$r = New-Object WI+RECT
[WI]::GetWindowRect($h, [ref]$r) | Out-Null
$cx = [int]($r.L + ($r.R - $r.L) * $X); $cy = [int]($r.T + ($r.B - $r.T) * $Y)
[WI]::SetCursorPos($cx, $cy) | Out-Null
[WI]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
[WI]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 200
if ($Keys) { [System.Windows.Forms.SendKeys]::SendWait($Keys) }
