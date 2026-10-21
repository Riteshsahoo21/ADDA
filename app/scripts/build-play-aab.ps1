param([switch]$GenerateKey)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$keystore = Join-Path $project 'release/adda-upload.jks'
$secrets = Join-Path $project '.play-signing.properties'
$gradle = Join-Path $project 'android/app/build.gradle'

if ($GenerateKey) {
  if ((Test-Path -LiteralPath $keystore) -or (Test-Path -LiteralPath $secrets)) {
    throw 'Upload key or signing properties already exist. Refusing to overwrite them.'
  }
  New-Item -ItemType Directory -Path (Split-Path $keystore) -Force | Out-Null
  $randomBytes = New-Object byte[] 36
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
  $password = [Convert]::ToBase64String($randomBytes)
  & keytool -genkeypair -v -keystore $keystore -storetype PKCS12 -alias adda-upload `
    -keyalg RSA -keysize 4096 -validity 10000 -storepass $password -keypass $password `
    -dname 'CN=ADDA Upload, OU=Android, O=ADDA, C=IN'
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed to generate upload key.' }
  [IO.File]::WriteAllLines($secrets, @(
    "ADDA_UPLOAD_STORE_FILE=$keystore",
    "ADDA_UPLOAD_STORE_PASSWORD=$password",
    'ADDA_UPLOAD_KEY_ALIAS=adda-upload',
    "ADDA_UPLOAD_KEY_PASSWORD=$password"
  ))
  Write-Host 'Created local upload key and signing properties. Back up both files securely; losing the upload key complicates future releases.'
}

if (!(Test-Path -LiteralPath $secrets) -or !(Test-Path -LiteralPath $keystore)) {
  throw 'Upload key missing. Run this script once with -GenerateKey, or restore your existing key and signing properties.'
}
if (!(Test-Path -LiteralPath $gradle)) { throw 'Android native project missing. Generate it before building.' }

$envNames = @('ADDA_UPLOAD_STORE_FILE','ADDA_UPLOAD_STORE_PASSWORD','ADDA_UPLOAD_KEY_ALIAS','ADDA_UPLOAD_KEY_PASSWORD')
foreach ($name in $envNames) {
  $line = Get-Content -LiteralPath $secrets | Where-Object { $_.StartsWith("$name=") } | Select-Object -First 1
  if (!$line) { throw "Missing signing setting: $name" }
  [Environment]::SetEnvironmentVariable($name, $line.Substring($name.Length + 1), 'Process')
}

Push-Location $project
try {
  $previousGradleHome = $env:GRADLE_USER_HOME
  if (!$env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME = (Join-Path (Split-Path $project) '.gradle') }
  node -e "const fs=require('fs');const p='android/app/build.gradle';const patch=require('./plugins/with-play-signing').patchGradle;fs.writeFileSync(p,patch(fs.readFileSync(p,'utf8')))"
  if ($LASTEXITCODE -ne 0) { throw 'Could not configure release signing.' }
  Push-Location android
  try {
    .\gradlew.bat bundleRelease --no-daemon '-PreactNativeArchitectures=armeabi-v7a,arm64-v8a'
    if ($LASTEXITCODE -ne 0) { throw 'Android bundle build failed.' }
  } finally { Pop-Location }
  Write-Host 'AAB: android/app/build/outputs/bundle/release/app-release.aab'
} finally {
  Pop-Location
  $env:GRADLE_USER_HOME = $previousGradleHome
  foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
}
