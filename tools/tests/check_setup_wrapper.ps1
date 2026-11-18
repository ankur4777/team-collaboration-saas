# Standalone wrapper checks: use a fake Docker command; never contact an engine.
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('mail setup ' + [guid]::NewGuid())
$originalLocation = Get-Location
$global:MailSetupCalls = [Collections.Generic.List[object]]::new()
$global:MailSetupFailAt = 0
function global:docker {
    $global:MailSetupCalls.Add(@($args))
    $global:LASTEXITCODE = if ($global:MailSetupCalls.Count -eq $global:MailSetupFailAt) { 1 } else { 0 }
}
function Assert-Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
try {
    New-Item -ItemType Directory -Path (Join-Path $testRoot 'tools') -Force | Out-Null
    $wrapper = Join-Path $testRoot 'tools/setup-mail.ps1'
    Copy-Item (Join-Path $PSScriptRoot '../setup-mail.ps1') $wrapper
    Set-Content (Join-Path $testRoot '.env') 'EXISTING=fixture'
    $googleJson = Join-Path $testRoot 'client with spaces.json'
    Set-Content $googleJson '{}'
    & $wrapper -Provider gmail -GoogleClientJson $googleJson
    Assert-Check ($global:MailSetupCalls.Count -eq 4) 'Expected build/start, wizard, restart and configuration check.'
    $wizard = $global:MailSetupCalls[1]
    Assert-Check ($wizard -contains "${testRoot}:/mail-setup") 'Project path with spaces must be one argument.'
    Assert-Check ($wizard -contains "${googleJson}:/mail-client.json:ro") 'Credential JSON must be mounted read-only.'
    Assert-Check ($wizard -contains '--google-client-json') 'Import option must reach the Python helper.'
    Assert-Check (($global:MailSetupCalls[3] -join ' ') -eq 'compose exec -T api python manage.py check_mail_setup --provider gmail') 'Check the selected provider.'
    Assert-Check ((Get-Location).Path -eq $originalLocation.Path) 'Restore the caller location after success.'

    $global:MailSetupCalls.Clear()
    $global:MailSetupFailAt = 2
    $failed = $false
    try { & $wrapper -Provider outlook } catch { $failed = $true }
    Assert-Check $failed 'A failed wizard must fail the wrapper.'
    Assert-Check ($global:MailSetupCalls.Count -eq 2) 'Do not restart the API after a failed wizard.'
    Assert-Check ((Get-Location).Path -eq $originalLocation.Path) 'Restore the caller location after failure.'
    Write-Host 'PowerShell wrapper checks passed.'
}
finally {
    Set-Location $originalLocation
    Remove-Item Function:\docker
    Remove-Item -LiteralPath $testRoot -Recurse -Force
    Remove-Variable MailSetupCalls, MailSetupFailAt -Scope Global
}
