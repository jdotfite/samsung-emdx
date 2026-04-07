param(
  [string[]]$FrameIps = @("192.168.4.244", "192.168.4.255"),
  [int]$IntervalSeconds = 1
)

Write-Host "Watching connections to frame IPs: $($FrameIps -join ', ')" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray

while ($true) {
  Clear-Host
  Write-Host ("Frame connection watch " + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")) -ForegroundColor Cyan
  Write-Host ""

  $connections = Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object { $FrameIps -contains $_.RemoteAddress } |
    Sort-Object RemoteAddress, LocalPort

  if (-not $connections) {
    Write-Host "No active TCP connections to the configured frames." -ForegroundColor Yellow
  } else {
    $rows = foreach ($connection in $connections) {
      $processName = ""
      try {
        $processName = (Get-Process -Id $connection.OwningProcess -ErrorAction Stop).ProcessName
      } catch {
        $processName = "Unknown"
      }

      [PSCustomObject]@{
        Process      = $processName
        PID          = $connection.OwningProcess
        LocalAddress = $connection.LocalAddress
        LocalPort    = $connection.LocalPort
        Remote       = "$($connection.RemoteAddress):$($connection.RemotePort)"
        State        = $connection.State
      }
    }

    $rows | Format-Table -AutoSize
  }

  Start-Sleep -Seconds $IntervalSeconds
}
