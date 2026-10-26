# AI WALLET CURVE — start local board (Windows)
$ErrorActionPreference = 'Stop'
$dest = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dest

$env:HTTP_PROXY = 'http://127.0.0.1:18081'
$env:HTTPS_PROXY = 'http://127.0.0.1:18081'
$env:NODE_USE_ENV_PROXY = '1'
$env:NO_PROXY = '127.0.0.1,localhost'
$env:PORT = if ($env:PORT) { $env:PORT } else { '3847' }
$env:CACHE_MS = '15000'
$env:NEAR_MIN_PCT = '50'
$env:NEAR_MIN_MC_USD = '10000'
$env:FOUR_LOOKBACK_BLOCKS = '4000'
$env:FLAP_LOOKBACK_BLOCKS = '8000'
$env:FOUR_LOG_MS = '12000'
$env:FLAP_LOG_MS = '10000'
$env:FOUR_MAX_ENRICH = '30'
# Prefer endpoints that currently answer under Windows proxy (publicnode/dataseed often rate-limit).
if (-not $env:BSC_RPC) {
  $env:BSC_RPC = 'https://bsc.blockrazor.xyz,https://1rpc.io/bnb,https://bsc-rpc.publicnode.com,https://bsc-dataseed.bnbchain.org'
}
if (-not $env:GANG_RPC_URL) {
  $env:GANG_RPC_URL = ($env:BSC_RPC -split ',')[0].Trim()
}
# Stable local key (override with BOARD_KEY if needed)
if (-not $env:BOARD_KEY) { $env:BOARD_KEY = 'REPLACE_WITH_YOUR_BOARD_KEY' }

# Fixed main-wallet recipient for board 转主钱包 (server ignores client recipient)
if (-not $env:MAIN_WALLET) { $env:MAIN_WALLET = '0xYOUR_MAIN_WALLET_ADDRESS' }

# GMGN OpenAPI key for FLAP/FOUR near+graduated backfill (exist-auth trenches)
if (-not $env:GMGN_API_KEY) {
  $gmgnEnv = Join-Path $env:USERPROFILE '.config\gmgn\.env'
  if (Test-Path $gmgnEnv) {
    Get-Content $gmgnEnv | ForEach-Object {
      if ($_ -match '^\s*GMGN_API_KEY=(.+)$') { $env:GMGN_API_KEY = $Matches[1].Trim().Trim('"').Trim("'") }
    }
  }
}
if (-not $env:GMGN_TRENCH_LIMIT) { $env:GMGN_TRENCH_LIMIT = '60' }

# Soft/内盘 curve rows on board (gang CLI). Set 0 to hide.
if (-not $env:GANG_INCLUDE_SOFT) { $env:GANG_INCLUDE_SOFT = '1' }


# free port if occupied
Get-NetTCPConnection -LocalPort ([int]$env:PORT) -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Write-Host "Starting SENSU on 127.0.0.1:$($env:PORT) ..."
Write-Host "BSC_RPC=$($env:BSC_RPC)"
node server.mjs
