# Release check (ADR-0004): fails unless the installer and the application executable carry a
# valid Authenticode signature. Run after `npm run package` on the release build:
#   powershell -File apps/desktop/scripts/verify-signature.ps1
param([string]$Release = (Join-Path $PSScriptRoot '..\release'))

$files = @(Get-ChildItem -Path $Release -Filter 'mmap-setup-*.exe' -File) +
  @(Get-Item -Path (Join-Path $Release 'win-unpacked\mmap.exe') -ErrorAction SilentlyContinue)
if ($files.Count -lt 2) {
  Write-Error "Expected the installer and win-unpacked\mmap.exe in $Release. Run 'npm run package' first."
  exit 1
}
$failed = $false
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -FilePath $file.FullName
  $signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { 'none' }
  Write-Output ("{0}: {1} (signer: {2})" -f $file.Name, $signature.Status, $signer)
  if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) { $failed = $true }
}
if ($failed) {
  Write-Error 'Not releasable: every file needs a valid, timestamped signature.'
  exit 1
}
Write-Output 'All files are signed and timestamped.'
