$ErrorActionPreference = "Stop"

$domain = "myfflapp.com"
$databases = @(
    "myffl-core",
    "myffl-nfl",
    "myffl-leagues-001"
)
$r2Buckets = @(
    "myffl-assets",
    "myffl-provider-archive"
)
$queues = @(
    "myffl-espn-updates",
    "myffl-scoring",
    "myffl-notifications",
    "myffl-audit",
    "myffl-waivers"
)
$pagesProject = "myffl-mobile"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$wrangler = Join-Path $repoRoot "node_modules/.bin/wrangler.cmd"

function Invoke-Wrangler {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Args)
    Write-Host "wrangler $($Args -join ' ')"
    & $wrangler @Args
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler command failed with exit code ${LASTEXITCODE}: wrangler $($Args -join ' ')"
    }
}

Write-Host "Checking Wrangler authentication..."
Invoke-Wrangler whoami

Write-Host "Creating D1 databases..."
foreach ($database in $databases) {
    Invoke-Wrangler d1 create $database
}

Write-Host "Creating R2 buckets..."
foreach ($bucket in $r2Buckets) {
    Invoke-Wrangler r2 bucket create $bucket
}

Write-Host "Creating Queues..."
foreach ($queue in $queues) {
    Invoke-Wrangler queues create $queue
}

Write-Host "Creating Pages project..."
Invoke-Wrangler pages project create $pagesProject --production-branch main

Write-Host "Enabling Cloudflare Email Sending for $domain..."
Invoke-Wrangler email sending enable $domain

Write-Host "Fetching Email Sending DNS requirements..."
Invoke-Wrangler email sending dns get $domain

Write-Host "Provisioning complete. Copy any generated D1 database IDs into Worker wrangler.jsonc files."
