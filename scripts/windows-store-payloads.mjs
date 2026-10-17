// Pure static payloads shared by the native plugin and its terminal helper.
// Account references and credential bytes travel on stdin, never in arguments.

/** Exit codes of the Windows payloads; 0 is success and 46 stays the catch-all. */
export const WINDOWS_EXIT = Object.freeze({
  /** The credential store has no item for this reference. */
  NOT_FOUND_CREDENTIAL: 44,
  /** Anything else, including a refused link, junction or foreign owner; stderr names the cause. */
  FAILED: 46,
  /** The folder path is too long for Windows PowerShell 5.1 (about 248 characters for a folder). */
  PATH_TOO_LONG: 48,
  /** PowerShell runs in ConstrainedLanguage mode, which blocks Add-Type and the .NET security APIs. */
  CONSTRAINED_LANGUAGE: 49,
  /** Windows denied access. */
  ACCESS_DENIED: 51,
  /** A drive or parent folder does not exist. */
  NOT_FOUND: 52,
  /** No interactive Windows sign-in, so Credential Manager is unavailable (SSH, services, scheduled tasks). */
  NO_LOGON_SESSION: 53,
})

/** Folders this long or longer fail in Windows PowerShell 5.1 on .NET Framework. */
export const WINDOWS_FOLDER_LIMIT = 248

/**
 * The person-readable cause for a payload exit code. `subject` names what was
 * being prepared, and `detail` is the payload's own one-line cause, if any.
 */
export function windowsStoreProblem(exitCode, subject = 'the isolated login folder', detail = '') {
  const cause = typeof detail === 'string' && detail.trim() ? ` (${detail.trim()})` : ''
  switch (exitCode) {
    case WINDOWS_EXIT.PATH_TOO_LONG:
      return `The path of ${subject} is too long for Windows PowerShell 5.1, which handles folders of up to ${WINDOWS_FOLDER_LIMIT - 1} characters. Use a shorter Claude config folder (CLAUDE_CONFIG_DIR) or a shorter account name, then rerun setup.`
    case WINDOWS_EXIT.CONSTRAINED_LANGUAGE:
      return 'Windows PowerShell runs in ConstrainedLanguage mode here (usually set by an AppLocker, WDAC or Device Guard policy), which blocks Add-Type and the Windows security APIs that setup needs. Ask your administrator to allow Windows PowerShell scripts for your account, then rerun setup.'
    case WINDOWS_EXIT.ACCESS_DENIED:
      return `Windows denied access to ${subject}${cause}. Check that your Windows user owns it and may change its permissions, then rerun setup.`
    case WINDOWS_EXIT.NOT_FOUND:
      return `A drive or parent folder of ${subject} does not exist${cause}. Check the Claude config folder path, then rerun setup.`
    case WINDOWS_EXIT.NO_LOGON_SESSION:
      return 'Windows Credential Manager is unavailable in this session because there is no interactive Windows sign-in (as in SSH, a service or a scheduled task). Run setup from a signed-in desktop session.'
    default:
      return `Windows could not secure ${subject} for your user${cause || ` (exit ${exitCode})`}. Run the same setup command to retry.`
  }
}

// Exits 49 before anything that ConstrainedLanguage mode would refuse.
const LANGUAGE_GUARD = String.raw`
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  try { [Console]::Error.WriteLine('PowerShell language mode is ' + $ExecutionContext.SessionState.LanguageMode + '.') } catch {}
  exit 49
}`

// Classifies a caught failure; the base exception type names the real cause.
const FAILURE_EXITS = String.raw`
  $failure = $_.Exception.GetBaseException()
  $code = 46
  if ($failure -is [System.IO.PathTooLongException]) { $code = 48 }
  if ($code -eq 46 -and ($failure -is [System.UnauthorizedAccessException] -or $failure -is [System.Security.AccessControl.PrivilegeNotHeldException])) { $code = 51 }
  if ($code -eq 46 -and ($failure -is [System.IO.DirectoryNotFoundException] -or $failure -is [System.IO.DriveNotFoundException] -or $failure -is [System.IO.FileNotFoundException] -or $failure -is [System.Management.Automation.ItemNotFoundException])) { $code = 52 }
  if ($code -eq 46 -and $failure -is [System.ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 5) { $code = 51 }
  if ($code -eq 46 -and $failure -is [System.ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 1312) { $code = 53 }`

export const WINDOWS_PRIVATE_DIRECTORY = String.raw`
$ErrorActionPreference = 'Stop'
${LANGUAGE_GUARD}
function Stop-Setup([int]$code, [string]$text) {
  [Console]::Error.WriteLine($text)
  exit $code
}
# Expands 8.3 short components such as RUNNER~1 so every check and access rule names the real folder.
function Get-LongPath([string]$value) {
  $full = [System.IO.Path]::GetFullPath($value)
  if (-not $full.Contains('~')) { return $full }
  $root = [System.IO.Path]::GetPathRoot($full)
  $current = $root
  foreach ($part in $full.Substring($root.Length).Split([char[]]@([char]92, [char]47), [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $directory = [System.IO.DirectoryInfo]::new($current)
    $match = @()
    if ($directory.Exists) { $match = @($directory.GetFileSystemInfos($part)) }
    $name = $part
    if ($match.Count -eq 1) { $name = $match[0].Name }
    $current = [System.IO.Path]::Combine($current, $name)
  }
  return $current
}
# Owner-only: protected from inheritance, owned by this user, and no other identity allowed except, optionally, SYSTEM.
function Test-Private([string]$target, [string]$sid) {
  $acl = [System.IO.Directory]::GetAccessControl($target, [System.Security.AccessControl.AccessControlSections]'Access,Owner')
  if (-not $acl.AreAccessRulesProtected) { return $false }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { return $false }
  foreach ($entry in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $entry.IdentityReference.Value -ne $sid -and $entry.IdentityReference.Value -ne 'S-1-5-18') { return $false }
  }
  return $true
}
function Test-Folder([string]$target) {
  $item = Get-Item -Force -LiteralPath $target
  return $item.PSIsContainer -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0
}
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [string]$inputValue.path
  $root = [string]$inputValue.root
  $absolute = '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)'
  if ($path -notmatch $absolute -or $path.Contains([char]0)) { Stop-Setup 46 'The login folder is not an absolute Windows path.' }
  if ($root -and ($root -notmatch $absolute -or $root.Contains([char]0))) { Stop-Setup 46 'The Claude config folder is not an absolute Windows path.' }
  $path = (Get-LongPath $path).TrimEnd([char[]]@([char]92, [char]47))
  if ($path.Length -ge ${WINDOWS_FOLDER_LIMIT}) { Stop-Setup 48 ('The login folder path has ' + $path.Length + ' characters.') }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $user = $identity.User
  if ($root) {
    # Every existing folder from the config folder down to the login folder must be a real folder, never a link or junction.
    $root = (Get-LongPath $root).TrimEnd([char[]]@([char]92, [char]47))
    if (-not $path.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Setup 46 'The login folder is not inside the Claude config folder.' }
    $cursor = [System.IO.Path]::GetDirectoryName($path)
    while ($cursor -and $cursor.Length -gt $root.Length) {
      if ((Test-Path -LiteralPath $cursor) -and -not (Test-Folder $cursor)) { Stop-Setup 46 ($cursor + ' is a link, junction or file, not a folder. Remove it, then rerun setup.') }
      $cursor = [System.IO.Path]::GetDirectoryName($cursor)
    }
  }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  if (Test-Path -LiteralPath $path) {
    if (-not (Test-Folder $path)) { Stop-Setup 46 'The login folder is a link, junction or file, not a folder. Remove it, then rerun setup.' }
    $owner = [System.IO.Directory]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]'Owner').GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    # An elevated administrator's new folders are owned by the Administrators group; that owner is this user's own.
    $elevated = [System.Security.Principal.WindowsPrincipal]::new($identity).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($owner -ne $user.Value -and -not ($owner -eq 'S-1-5-32-544' -and $elevated)) { Stop-Setup 46 'The login folder belongs to another Windows user. Remove it or run setup as its owner.' }
    if (-not (Test-Private $path $user.Value)) {
      # CreateDirectory leaves an existing folder's rules unchanged, so repair them: inheritance is cut,
      # only this user is allowed, and the owner becomes this user when it was the Administrators group.
      # When the owner is already this user only the access rules are written, which the owner may always do.
      $repair = New-Object System.Security.AccessControl.DirectorySecurity
      $repair.SetAccessRuleProtection($true, $false)
      if ($owner -ne $user.Value) { $repair.SetOwner($user) }
      $repair.AddAccessRule($rule)
      [System.IO.Directory]::SetAccessControl($path, $repair)
    }
  } else {
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($user)
    $security.AddAccessRule($rule)
    [void][System.IO.Directory]::CreateDirectory($path, $security)
  }
  if (-not (Test-Folder $path)) { Stop-Setup 46 'The login folder is a link, junction or file, not a folder.' }
  if (-not (Test-Private $path $user.Value)) { Stop-Setup 46 'Windows did not keep owner-only access rules on the login folder.' }
  exit 0
} catch {
${FAILURE_EXITS}
  [Console]::Error.WriteLine('Cannot secure the isolated Windows login directory for its current owner: ' + $failure.GetType().Name + '.')
  exit $code
}
`

export const WINDOWS_CREDENTIAL_STORE = String.raw`
$ErrorActionPreference = 'Stop'
${LANGUAGE_GUARD}
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($inputValue.operation -notin @('read','write','delete') -or $inputValue.service -isnot [string] -or $inputValue.account -isnot [string] -or -not $inputValue.service -or -not $inputValue.account) { throw 'invalid credential reference' }
  $reference = ConvertTo-Json -InputObject @($inputValue.service, $inputValue.account) -Compress
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($reference)) } finally { $sha.Dispose() }
  $target = 'Rice.SessionAccounts/' + ([System.BitConverter]::ToString($digest)).Replace('-','').ToLowerInvariant()
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class RiceAccountsCredentialStore {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool ReadNative(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool WriteNative(ref Credential value, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)] static extern bool DeleteNative(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr pointer;
    if (!ReadNative(target, 1, 0, out pointer)) {
      int code = Marshal.GetLastWin32Error();
      if (code == 1168) return null;
      throw new Win32Exception(code);
    }
    byte[] bytes = null;
    try {
      Credential value = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (value.CredentialBlobSize > 2560) throw new InvalidOperationException();
      bytes = new byte[value.CredentialBlobSize];
      Marshal.Copy(value.CredentialBlob, bytes, 0, bytes.Length);
      return new UTF8Encoding(false, true).GetString(bytes);
    } finally { if (bytes != null) Array.Clear(bytes, 0, bytes.Length); CredFree(pointer); }
  }
  public static void Write(string target, string secret) {
    byte[] bytes = new UTF8Encoding(false, true).GetBytes(secret);
    if (bytes.Length == 0 || bytes.Length > 2560) { Array.Clear(bytes, 0, bytes.Length); throw new InvalidOperationException(); }
    IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, pointer, bytes.Length);
      Credential value = new Credential { Type=1, TargetName=target, Comment="Rice Accounts OAuth token", CredentialBlobSize=(uint)bytes.Length, CredentialBlob=pointer, Persist=2, UserName="Rice Accounts" };
      if (!WriteNative(ref value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { for (int n=0; n<bytes.Length; n++) Marshal.WriteByte(pointer,n,0); Marshal.FreeHGlobal(pointer); Array.Clear(bytes,0,bytes.Length); }
  }
  public static void Delete(string target) {
    if (!DeleteNative(target,1,0)) { int code=Marshal.GetLastWin32Error(); if (code!=1168) throw new Win32Exception(code); }
  }
}
'@
  if ($inputValue.operation -eq 'read') {
    $secret = [RiceAccountsCredentialStore]::Read($target)
    if ($null -eq $secret) { exit 44 }
    [Console]::Out.Write($secret)
  } elseif ($inputValue.operation -eq 'write') {
    if ($inputValue.secret -isnot [string]) { throw 'invalid credential input' }
    [RiceAccountsCredentialStore]::Write($target, $inputValue.secret)
  } else { [RiceAccountsCredentialStore]::Delete($target) }
  exit 0
} catch {
${FAILURE_EXITS}
  [Console]::Error.WriteLine('Windows Credential Manager operation failed: ' + $failure.GetType().Name + '.')
  exit $code
}
`
