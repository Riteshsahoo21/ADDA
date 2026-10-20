$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$keystore = Join-Path $project 'release/adda-upload.jks'
$secrets = Join-Path $project '.play-signing.properties'

if (!(Test-Path -LiteralPath $secrets) -or !(Test-Path -LiteralPath $keystore)) {
  throw 'Upload key or signing properties missing.'
}

$envNames = @('ADDA_UPLOAD_STORE_FILE','ADDA_UPLOAD_STORE_PASSWORD','ADDA_UPLOAD_KEY_ALIAS','ADDA_UPLOAD_KEY_PASSWORD')
foreach ($name in $envNames) {
  $line = Get-Content -LiteralPath $secrets | Where-Object { $_.StartsWith("$name=") } | Select-Object -First 1
  if (!$line) { throw "Missing signing setting: $name" }
  [Environment]::SetEnvironmentVariable($name, $line.Substring($name.Length + 1), 'Process')
}

Push-Location (Join-Path $project 'android')
try {
  .\gradlew.bat assembleRelease --no-daemon
  if ($LASTEXITCODE -ne 0) { throw 'Android APK build failed.' }
  Write-Host 'SUCCESS: Release APK generated!'
} finally {
  Pop-Location
  foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
}
