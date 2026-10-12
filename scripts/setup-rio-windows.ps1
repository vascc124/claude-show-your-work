# Sets Rio up so Claude Code can draw pictures on Windows: Microsoft's newer
# ConPTY next to rio.exe (the console host built into Windows drops the escape
# codes pictures travel in), and the variables Claude Code needs, set in Rio's
# config so only Rio's sessions get them.
#
# Run it once in an admin PowerShell, from the plugin's folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-rio-windows.ps1
param(
  [string]$Rio = "$env:ProgramFiles\Rio",
  [string]$Version = '1.25.260930003',
  [string]$Sha256 = '02B07B349AF66D801159BDF9E440D4A1CE78BB951F37FC8609731665AFDAE7EE'
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path "$Rio\rio.exe")) { throw "Rio isn't in $Rio. Install it first: winget install raphamorim.rio" }
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in an admin PowerShell: it copies two files into Rio's folder."
}

# The package as Microsoft publishes it, checked against the pinned hash.
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$package = Join-Path $env:TEMP "conpty-$Version.nupkg"
$unpacked = Join-Path $env:TEMP "conpty-$Version"
Invoke-WebRequest -UseBasicParsing -OutFile $package `
  -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$Version/microsoft.windows.console.conpty.$Version.nupkg"
if ((Get-FileHash $package -Algorithm SHA256).Hash -ne $Sha256) {
  Remove-Item $package
  throw 'The ConPTY package does not match the pinned hash.'
}

# conpty.dll and OpenConsole.exe must come from the same package: conpty.dll
# alone falls back to Windows' own host, and pictures stop without an error.
New-Item -ItemType Directory -Force $unpacked | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($package)
try {
  foreach ($entry in $zip.Entries) {
    if ($entry.FullName -in @("runtimes/win-$arch/native/conpty.dll", "build/native/runtimes/$arch/OpenConsole.exe")) {
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $unpacked $entry.Name), $true)
    }
  }
} finally {
  $zip.Dispose()
}
foreach ($file in 'conpty.dll', 'OpenConsole.exe') {
  $signature = Get-AuthenticodeSignature (Join-Path $unpacked $file)
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Corporation,') {
    throw "$file is not signed by Microsoft."
  }
}
Copy-Item (Join-Path $unpacked 'conpty.dll'), (Join-Path $unpacked 'OpenConsole.exe') -Destination $Rio -Force
Remove-Item $package, $unpacked -Recurse -Force
"ConPTY $Version is next to rio.exe."

# Claude Code turns pictures on by itself only in kitty and Ghostty, and needs
# at least 256 colors to tell pictures apart; Rio has both, so it is told so.
$config = Join-Path $env:LOCALAPPDATA 'rio\config.toml'
$text = if (Test-Path $config) { Get-Content -Raw $config } else { '' }
if ($text -match 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES') {
  'Rio config already sets the variables.'
} elseif ($text -match '(?m)^\s*env-vars\s*=') {
  "Rio config has its own env-vars: add CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 and FORCE_COLOR=3 to them in $config."
} else {
  # Top-level keys go before any [table] in TOML, so the list goes first.
  $vars = "env-vars = [`n  `"CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`",`n  `"FORCE_COLOR=3`",`n  `"COLORTERM=truecolor`",`n]`n`n"
  New-Item -ItemType Directory -Force (Split-Path $config) | Out-Null
  [IO.File]::WriteAllText($config, $vars + $text, (New-Object Text.UTF8Encoding $false))
  "Added the variables to $config."
}
'Done. Open Rio and run claude.'
