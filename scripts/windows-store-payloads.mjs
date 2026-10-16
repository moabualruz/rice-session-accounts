// Pure static payloads shared by the native plugin and its terminal helper.
// Account references and credential bytes travel on stdin, never in arguments.
export const WINDOWS_PRIVATE_DIRECTORY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [string]$inputValue.path
  if ($path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)' -or $path.Contains([char]0)) { throw 'invalid directory' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if (Test-Path -LiteralPath $path) {
    $old = Get-Item -Force -LiteralPath $path
    $oldAcl = [System.IO.Directory]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]'Access,Owner')
    if (-not $old.PSIsContainer -or ($old.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $oldAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'unsafe existing login directory' }
  }
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($identity.User)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  [void][System.IO.Directory]::CreateDirectory($path, $security)
  $item = Get-Item -Force -LiteralPath $path
  $acl = [System.IO.Directory]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]'Access,Owner')
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'unsafe login directory' }
  foreach ($entry in $acl.Access) {
    if ($entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'unsafe login directory access' }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine('Cannot secure the isolated Windows login directory for its current owner.')
  exit 46
}
`

export const WINDOWS_CREDENTIAL_STORE = String.raw`
$ErrorActionPreference = 'Stop'
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
  [Console]::Error.WriteLine('Windows Credential Manager operation failed.')
  exit 46
}
`
