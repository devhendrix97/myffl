$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$secretsDir = Join-Path $repoRoot "secrets"
$outputPath = Join-Path $secretsDir "myffl-secrets.local.env"

New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null

function New-Secret {
    param([int] $ByteCount = 48)
    $bytes = New-Object byte[] $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    return [Convert]::ToBase64String($bytes)
}

$values = [ordered]@{
    ACCESS_TOKEN_SIGNING_SECRET = New-Secret 64
    REFRESH_TOKEN_HASHING_SECRET = New-Secret 64
    PASSWORD_RESET_SECRET = New-Secret 64
    EMAIL_VERIFICATION_SECRET = New-Secret 64
    VAPID_PUBLIC_KEY = "generate-during-notifications-phase"
    VAPID_PRIVATE_KEY = "generate-during-notifications-phase"
    VAPID_SUBJECT = "mailto:support@myfflapp.com"
    APPLICATION_BASE_URL = "https://app.myfflapp.com"
    API_BASE_URL = "https://api.myfflapp.com"
    EMAIL_FROM_ADDRESS = "noreply@myfflapp.com"
    EMAIL_FROM_NAME = "myFFL"
}

$lines = @(
    "# myFFL local secret record",
    "# Generated $(Get-Date -Format o)",
    "# Keep this file private. It is intentionally ignored by git.",
    ""
)

foreach ($entry in $values.GetEnumerator()) {
    $lines += "$($entry.Key)=$($entry.Value)"
}

Set-Content -LiteralPath $outputPath -Value $lines -Encoding UTF8
Write-Host "Generated secrets at $outputPath"
