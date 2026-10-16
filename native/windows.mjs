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
function Set-BootstrapStage([string]$value) {
  $script:stage = $value
  # Captured by the parent only. Preserve the final phase if PowerShell hangs.
  [Console]::Error.WriteLine('rice-bootstrap-stage=' + $value)
}
Set-BootstrapStage 'identity'
try {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  Set-BootstrapStage 'identity-ready'
  function Assert-PrivatePath([string]$path, [bool]$directory) {
    Set-BootstrapStage 'inspect-private-path'
    $attributes = [System.IO.File]::GetAttributes($path)
    Set-BootstrapStage 'private-path-type'
    if ((($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'unsafe bootstrap type' }
    Set-BootstrapStage 'private-path-reparse'
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe bootstrap reparse point' }
    Set-BootstrapStage 'read-private-acl'
    $sections = [System.Security.AccessControl.AccessControlSections]'Access,Owner'
    $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($path, $sections) } else { [System.IO.File]::GetAccessControl($path, $sections) }
    Set-BootstrapStage 'private-path-owner'
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    # Elevated Windows tokens can create files owned by their TokenOwner group.
    # Directories have our explicit user owner; files still require the private DACL.
    $owners = @($sid)
    if (-not $directory) { $owners += $identity.Owner.Value }
    if ($owner -notin $owners) { throw 'unsafe bootstrap owner' }
    Set-BootstrapStage 'private-directory-inheritance'
    if ($directory -and -not $acl.AreAccessRulesProtected) { throw 'unsafe bootstrap inheritance' }
    $write = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($rule in $acl.Access) {
      Set-BootstrapStage 'private-path-writers'
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
  Set-BootstrapStage 'construct-private-acl'
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($identity.User)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  $bases = @($env:RICE_NATIVE_BOOTSTRAP_TEMP)
  if ($env:RICE_NATIVE_BOOTSTRAP_WINDOWS) { $bases += [System.IO.Path]::Combine($env:RICE_NATIVE_BOOTSTRAP_WINDOWS, 'Temp') }
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($base in $bases) {
    if (-not $base -or -not $seen.Add($base)) { continue }
    $directory = [System.IO.Path]::Combine($base, ('rice-accounts-' + $sid))
    $existed = [System.IO.Directory]::Exists($directory)
    Set-BootstrapStage 'create-private-directory'
    try { [void][System.IO.Directory]::CreateDirectory($directory, $security) } catch { continue }
    Assert-PrivatePath $directory $true
    $plain = $directory
    if ($plain -match '\s') {
      Set-BootstrapStage 'shorten-directory'
      try {
        Add-Type -TypeDefinition $shortPathSource
        $buffer = [System.Text.StringBuilder]::new(32768)
        $length = [RiceNativeBootstrapPath]::GetShortPathName($directory, $buffer, [uint32]$buffer.Capacity)
        if ($length -gt 0 -and $length -lt $buffer.Capacity -and [System.IO.Directory]::Exists($buffer.ToString())) { $plain = $buffer.ToString() }
      } catch { <# A plain fallback base does not require the optional short-path API. #> }
    }
    if ($plain -match '\s') {
      if (-not $existed -and [System.IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) { [System.IO.Directory]::Delete($directory) }
      continue
    }
    $file = [System.IO.Path]::Combine($directory, $env:RICE_NATIVE_BOOTSTRAP_FILE)
    if ([System.IO.File]::Exists($file) -or [System.IO.Directory]::Exists($file)) { Assert-PrivatePath $file $false }
    Set-BootstrapStage 'return-private-path'
    # No cmdlet auto-loading in the required path: a stripped child environment
    # can block Windows PowerShell module discovery under an isolated profile.
    $json = [System.Text.StringBuilder]::new()
    [void]$json.Append('{"directory":"')
    foreach ($character in $plain.ToCharArray()) {
      $code = [int]$character
      if ($code -eq 34) { [void]$json.Append('\"') }
      elseif ($code -eq 92) { [void]$json.Append('\\') }
      elseif ($code -lt 32) { [void]$json.Append('\u').Append($code.ToString('x4')) }
      else { [void]$json.Append($character) }
    }
    [void]$json.Append('"}')
    [Console]::Out.WriteLine($json.ToString())
    exit 0
  }
  throw 'no private plain bootstrap path'
} catch {
  [Console]::Error.WriteLine('Windows native bootstrap could not establish a private, space-free path. stage=' + $stage + '; class=' + $_.Exception.GetType().Name)
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
  const stage = Array.from(result.stderr?.matchAll(/stage=([a-z-]+)/g) ?? []).at(-1)?.[1]
  const timeout = result.error?.code === 'ETIMEDOUT'
  throw failure(`Windows native bootstrap ${timeout ? 'timed out establishing' : 'needs'} a private, space-free temporary path${stage ? ` (stage=${stage})` : ''}. Check your user TEMP permissions, then run /rice-account setup-native again.`)
}

export const WINDOWS_LAUNCHER_MARKER = '@echo off\r\nrem rice-session-accounts installed launcher\r\n'
export function windowsLauncher(node) {
  if (!absoluteWindowsPath(node) || /"/.test(node)) throw failure('The Windows launcher requires an absolute Node executable.')
  return WINDOWS_LAUNCHER_MARKER + 'setlocal DisableDelayedExpansion\r\n"' + node.replace(/%/g, '%%') + '" "%~dp0rice-account-claude.mjs" %*\r\nexit /b %errorlevel%\r\n'
}
