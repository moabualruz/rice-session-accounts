// Windows bootstrap algorithm shared with rice-multi-models (MIT).
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { win32 } from 'node:path'
const failure = message => Object.assign(new Error(message), { code: 'RICE_ACCOUNT_NATIVE' })
export const absoluteWindowsPath = value => typeof value === 'string' && !/[\0\r\n]/.test(value) && win32.isAbsolute(value) && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))

/** Paths travel in environment fields, never through PowerShell interpolation. */
export const WINDOWS_BOOTSTRAP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  function Assert-PrivatePath([string]$path, [bool]$directory) {
    $item = Get-Item -Force -LiteralPath $path
    if ($item.PSIsContainer -ne $directory -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe bootstrap type' }
    $sections = [System.Security.AccessControl.AccessControlSections]'Access,Owner'
    $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($path, $sections) } else { [System.IO.File]::GetAccessControl($path, $sections) }
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    # Elevated tokens can create files owned by their TokenOwner group.
    # The directory still has our explicit user owner and files need its private DACL.
    $owners = @($sid)
    if (-not $directory) { $owners += $identity.Owner.Value }
    if ($owner -notin $owners -or ($directory -and -not $acl.AreAccessRulesProtected)) { throw 'unsafe bootstrap owner' }
    $write = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.Access) {
      $writer = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $write) -ne 0 -and $writer -notin @($sid, 'S-1-5-18', 'S-1-5-32-544')) { throw 'unsafe bootstrap writer' }
    }
  }
  $shortPathSource = @'
using System.Text;
using System.Runtime.InteropServices;
public static class RiceNativeBootstrapPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetShortPathName(string path, StringBuilder output, uint length);
}
'@
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($identity.User)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  $bases = @($env:RICE_NATIVE_BOOTSTRAP_TEMP)
  if ($env:RICE_NATIVE_BOOTSTRAP_WINDOWS) { $bases += Join-Path $env:RICE_NATIVE_BOOTSTRAP_WINDOWS 'Temp' }
  foreach ($base in $bases | Select-Object -Unique) {
    if (-not $base) { continue }
    $directory = Join-Path $base ('rice-accounts-' + $sid)
    $existed = [System.IO.Directory]::Exists($directory)
    try { [void][System.IO.Directory]::CreateDirectory($directory, $security) } catch { continue }
    Assert-PrivatePath $directory $true
    $plain = $directory
    if ($plain -match '\s') {
      try {
        Add-Type -TypeDefinition $shortPathSource
        $buffer = New-Object System.Text.StringBuilder(32768)
        $length = [RiceNativeBootstrapPath]::GetShortPathName($directory, $buffer, [uint32]$buffer.Capacity)
        if ($length -gt 0 -and $length -lt $buffer.Capacity -and [System.IO.Directory]::Exists($buffer.ToString())) { $plain = $buffer.ToString() }
      } catch { <# A plain fallback base does not need the optional short-path API. #> }
    }
    if ($plain -match '\s') {
      if (-not $existed -and [System.IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) { [System.IO.Directory]::Delete($directory) }
      continue
    }
    $file = Join-Path $directory $env:RICE_NATIVE_BOOTSTRAP_FILE
    if (Test-Path -LiteralPath $file) { Assert-PrivatePath $file $false }
    [pscustomobject]@{directory=$plain} | ConvertTo-Json -Compress
    exit 0
  }
  throw 'no private plain bootstrap path'
} catch {
  [Console]::Error.WriteLine('Windows native bootstrap could not establish a private, space-free path.')
  exit 1
}
`


/** Keep the real lowercase filename: Bun does not resolve an 8.3 uppercase .MJS alias. */
export function windowsBootstrapDirectory(filename, options = {}) {
  if (process.platform !== 'win32' || !/^[a-f0-9]{64}\.mjs$/.test(filename)) throw failure('Invalid Windows native bootstrap request.')
  const windowsDirectory = options.windowsDirectory ?? process.env.SystemRoot ?? process.env.WINDIR
  const powershell = windowsDirectory ? join(windowsDirectory, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe'
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_BOOTSTRAP_SCRIPT], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024,
    env: { ...process.env, RICE_NATIVE_BOOTSTRAP_TEMP: options.temporaryDirectory ?? tmpdir(), RICE_NATIVE_BOOTSTRAP_WINDOWS: windowsDirectory, RICE_NATIVE_BOOTSTRAP_FILE: filename },
  })
  if (result.status === 0) {
    try {
      const value = JSON.parse(result.stdout)
      if (typeof value.directory === 'string' && absoluteWindowsPath(value.directory) && !/\s/.test(value.directory)) return value.directory
    } catch { /* Only a validated private path may be used for executable code. */ }
  }
  throw failure('Windows native bootstrap needs a private, space-free temporary path. Check your user TEMP permissions, then run /rice-account setup-native again.')
}

export const WINDOWS_LAUNCHER_MARKER = '@echo off\r\nrem rice-session-accounts installed launcher\r\n'
export function windowsLauncher(node) {
  if (!absoluteWindowsPath(node) || /"/.test(node)) throw failure('The Windows launcher requires an absolute Node executable.')
  return WINDOWS_LAUNCHER_MARKER + 'setlocal DisableDelayedExpansion\r\n"' + node.replace(/%/g, '%%') + '" "%~dp0rice-account-claude.mjs" %*\r\nexit /b %errorlevel%\r\n'
}
