$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '..\dist\Pi Web Box Portable-0.4.1.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pi Web Box.lnk'
$log = Join-Path $env:APPDATA 'Pi Web Box\logs\pi-web.log'
$before = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Pi Web Box.exe', 'Pi Web Box Portable.exe') }).ProcessId
$newProcesses = @()

try {
  Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
  $env:PI_WEB_BOX_SKIP_UPDATE_CHECK = '1'
  Start-Process -FilePath $exe

  $healthy = $false
  $bodyFile = Join-Path $env:TEMP 'pi-web-box-verify.html'
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Seconds 1
    $curlError = Join-Path $env:TEMP 'pi-web-box-verify-error.txt'
    $curl = Start-Process -FilePath 'curl.exe' -ArgumentList @('--silent', '--max-time', '3', 'http://127.0.0.1:30141/') -RedirectStandardOutput $bodyFile -RedirectStandardError $curlError -NoNewWindow -Wait -PassThru
    if ($curl.ExitCode -eq 0 -and (Test-Path $bodyFile) -and (Get-Content -LiteralPath $bodyFile -Raw) -match 'Pi Web') {
      $healthy = $true
      break
    }
  }
  if (-not $healthy) {
    $logContent = if (Test-Path $log) { Get-Content -LiteralPath $log -Raw } else { '(no log)' }
    throw "Pi Web HTTP health verification failed. Log: $logContent"
  }

  $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Pi Web Box.exe', 'Pi Web Box Portable.exe') })
  $newProcesses = @($processes | Where-Object { $before -notcontains $_.ProcessId })
  if ($newProcesses.Count -eq 0) { throw 'Pi Web Box did not stay running.' }

  $shortcutTarget = $null
  if (Test-Path $shortcut) {
    $shortcutTarget = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
  }
  $logContent = Get-Content -LiteralPath $log -Raw
  if ($logContent -notmatch 'Pi Web is ready at port 30141') {
    throw "Pi Web Box did not report ready. Log: $logContent"
  }

  [ordered]@{
    ProcessIds = @($newProcesses.ProcessId)
    ProcessNames = @($newProcesses.Name)
    ShortcutExists = Test-Path $shortcut
    ShortcutTarget = $shortcutTarget
    ExpectedTarget = (Resolve-Path $exe).Path
    PiWebPageDetected = $healthy
    LogReadyDetected = $logContent -match 'Pi Web is ready at port 30141'
  } | ConvertTo-Json -Depth 4

  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeClose {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
'@
  foreach ($processInfo in $newProcesses) {
    $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne 0) {
      [NativeClose]::PostMessage($process.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    }
  }
  Start-Sleep -Seconds 8

  $remaining = @(Get-CimInstance Win32_Process | Where-Object { $newProcesses.ProcessId -contains $_.ProcessId })
  if ($remaining.Count -gt 0) { throw "Pi Web Box did not exit cleanly: $($remaining.ProcessId -join ', ')" }
  $afterBody = Join-Path $env:TEMP 'pi-web-box-verify-after.html'
  $afterError = Join-Path $env:TEMP 'pi-web-box-verify-after-error.txt'
  $afterCurl = Start-Process -FilePath 'curl.exe' -ArgumentList @('--silent', '--max-time', '3', 'http://127.0.0.1:30141/') -RedirectStandardOutput $afterBody -RedirectStandardError $afterError -NoNewWindow -Wait -PassThru
  if ($afterCurl.ExitCode -eq 0) { throw 'Owned Pi Web service was still reachable after closing the window.' }
  Write-Output 'CLEAN_EXIT_OK'
} finally {
  $cleanup = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('Pi Web Box.exe', 'Pi Web Box Portable.exe') -and $before -notcontains $_.ProcessId
  })
  $cleanup | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
