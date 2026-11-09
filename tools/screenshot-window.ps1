# 指定したタイトルのウィンドウを画面から取り込んでPNGに保存する(開発中の動作確認用)。
# 使い方: powershell -File tools/screenshot-window.ps1 -Title Sketchbench -Out shot.png
param([string]$Title = "Sketchbench", [string]$Out = "shot.png")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int L, T, R, B; }
}
"@
$h = [W]::FindWindow($null, $Title)
if ($h -eq [IntPtr]::Zero) { $p = Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1; if ($p) { $h = $p.MainWindowHandle } }
if ($h -eq [IntPtr]::Zero) { Write-Error "window not found: $Title"; exit 1 }
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $hgt = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"$w x $hgt -> $Out"
