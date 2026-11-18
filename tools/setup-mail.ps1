[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('gmail', 'outlook')]
    [string]$Provider,
    [string]$GoogleClientJson
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Install/start Docker Desktop before running mail setup.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env') -PathType Leaf)) {
    throw 'The project needs its existing root .env file before mail setup.'
}
if ($GoogleClientJson -and $Provider -ne 'gmail') {
    throw '-GoogleClientJson is only supported with -Provider gmail.'
}
$importPath = $null
if ($GoogleClientJson) {
    $importPath = (Resolve-Path -LiteralPath $GoogleClientJson).ProviderPath
    if (-not (Test-Path -LiteralPath $importPath -PathType Leaf)) {
        throw 'Choose the Google Web application client JSON file.'
    }
}

Push-Location $projectRoot
try {
    & docker compose up -d --build api
    if ($LASTEXITCODE -ne 0) { throw 'API startup failed. Check Docker Desktop and docker compose logs api.' }
    $runArgs = @('compose', 'run', '--rm', '--no-deps', '--volume', "${projectRoot}:/mail-setup")
    if ($importPath) {
        $runArgs += @('--volume', "${importPath}:/mail-client.json:ro")
    }
    $runArgs += @('api', 'python', '/mail-setup/tools/setup_mail.py', '--root', '/mail-setup', '--provider', $Provider)
    if ($importPath) { $runArgs += @('--google-client-json', '/mail-client.json') }
    & docker @runArgs
    if ($LASTEXITCODE -ne 0) { throw 'Mail setup did not finish. The API was not restarted with new settings.' }
    & docker compose up -d --force-recreate api
    if ($LASTEXITCODE -ne 0) { throw 'Settings were saved, but restarting the API failed. Run docker compose up -d api.' }
    & docker compose exec -T api python manage.py check_mail_setup --provider $Provider
    if ($LASTEXITCODE -ne 0) { throw 'Mail settings were saved, but the API configuration check failed. See the messages above.' }
    Write-Host 'Open http://localhost:5173 -> Email inbox -> Manage mailboxes and connect the provider.'
    Write-Host 'Verify your TeamWorkspace email before connecting; real delivery is confirmed only after your send/reply test.'
}
finally {
    Pop-Location
}
