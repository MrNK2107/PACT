# Window control for recordings: find a top-level window by title substring, bring it to the front,
# maximise / restore it, and keep the display awake while a capture runs.
#   . .\winctl.ps1; Show-Win "Gazebo Sim" -Maximize; Get-WinRect "Gazebo Sim"
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WinCtl {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);
  public static List<KeyValuePair<IntPtr,string>> Windows() {
    var list = new List<KeyValuePair<IntPtr,string>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.Length > 0) list.Add(new KeyValuePair<IntPtr,string>(h, sb.ToString()));
      return true; }, IntPtr.Zero);
    return list;
  }
}
"@

function Find-Win([string]$Title) {
  [WinCtl]::Windows() | Where-Object { $_.Value -like "*$Title*" } | Select-Object -First 1
}

function Show-Win([string]$Title, [switch]$Maximize, [switch]$Minimize) {
  $w = Find-Win $Title
  if (-not $w) { throw "no window titled *$Title*" }
  # an Alt tap lets SetForegroundWindow take focus from another process
  [WinCtl]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [WinCtl]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  if ($Minimize) { [void][WinCtl]::ShowWindow($w.Key, 6); return }
  [void][WinCtl]::ShowWindow($w.Key, $(if ($Maximize) { 3 } else { 9 }))
  [void][WinCtl]::BringWindowToTop($w.Key)
  [void][WinCtl]::SetForegroundWindow($w.Key)
}

function Get-WinRect([string]$Title) {
  $w = Find-Win $Title
  $r = New-Object WinCtl+RECT
  [void][WinCtl]::GetWindowRect($w.Key, [ref]$r)
  [pscustomobject]@{ X = $r.L; Y = $r.T; W = $r.R - $r.L; H = $r.B - $r.T }
}

# ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED: display and system stay on while this thread lives
function Stay-Awake { [void][WinCtl]::SetThreadExecutionState([uint32]"0x80000003") }
