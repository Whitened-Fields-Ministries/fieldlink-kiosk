# FieldLink Kiosk - privileged helper.
#
# The kiosk app (main.js) runs this script for everything that needs
# administrator rights, so church staff never see or run a script themselves:
#
#   -Action Status          read-only summary as JSON (no elevation needed)
#   -Action Lockdown        turn this PC into a dedicated kiosk:
#                             * FieldLinkKiosk local account, random password,
#                               not an administrator, cannot change password
#                             * that account's shell = FieldLinkKiosk.exe
#                               (no desktop, no taskbar, no Task Manager)
#                             * auto-login on boot - password kept in the LSA
#                               "DefaultPassword" secret, never in the registry
#                             * no sleep / screen timeout
#                             * nightly self-update task (see -Action Update)
#   -Action Unlock          undo all of the above (account is disabled, not deleted)
#   -Action Update          used by the scheduled task and by the app's
#                           "Install update" button: download a newer installer
#                           from the FieldLink server, verify it, install silently,
#                           restart if the kiosk session was running
#   -Action InstallUpdater  (re)create the scheduled task only
#   -Action RemoveUpdater   delete the scheduled task
#
# Every action appends to %ProgramData%\FieldLinkKiosk-Admin\admin.log and writes
# its outcome to last-action.json in the same folder, which the app's settings
# screen reads to show progress and results.
#
# Two data folders, on purpose:
#   %ProgramData%\FieldLinkKiosk        config.json - writable by the kiosk account
#                                       (so it can re-link itself from the app)
#   %ProgramData%\FieldLinkKiosk-Admin  this script, update settings, logs -
#                                       Administrators/SYSTEM only. The updater
#                                       runs as SYSTEM and must never execute or
#                                       trust anything the kiosk account can edit.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Status', 'Lockdown', 'Unlock', 'Update', 'InstallUpdater', 'RemoveUpdater')]
  [string]$Action,
  [string]$Exe = '',            # path to FieldLinkKiosk.exe (auto-detected if empty)
  [string]$Server = '',         # https origin used by the updater (defaults to the one in config.json)
  [switch]$Relaunch,            # Update: start the app again afterwards (app-initiated updates)
  [switch]$Force                # Update: install even if the version is not newer
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$KioskUser  = 'FieldLinkKiosk'
$DataDir    = Join-Path $env:ProgramData 'FieldLinkKiosk'
$AdminDir   = Join-Path $env:ProgramData 'FieldLinkKiosk-Admin'
$LogFile    = Join-Path $AdminDir 'admin.log'
$ResultFile = Join-Path $AdminDir 'last-action.json'
$UpdateCfg  = Join-Path $AdminDir 'update.json'
$UpdateLog  = Join-Path $AdminDir 'update-status.json'
$ScriptCopy = Join-Path $AdminDir 'kiosk-admin.ps1'
$TaskName   = 'FieldLinkKiosk Update'
$WinLogon   = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$ProfilePath = "$env:SystemDrive\Users\$KioskUser"

# -- plumbing -----------------------------------------------------------------
$script:Steps = New-Object System.Collections.ArrayList
function Ensure-AdminDir {
  if (-not (Test-Path $AdminDir)) { New-Item -ItemType Directory -Path $AdminDir -Force | Out-Null }
}
function Write-Log([string]$msg, [string]$level = 'info') {
  $line = "[{0}] {1,-5} {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $level.ToUpper(), $msg
  Write-Host $line
  try { Ensure-AdminDir; Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
}
function Step([string]$label, [string]$state = 'ok', [string]$detail = '') {
  [void]$script:Steps.Add([ordered]@{ label = $label; state = $state; detail = $detail })
  Write-Log ("{0}: {1} {2}" -f $state, $label, $detail)
  Write-Result -Ok $true -Message $label -Running $true
}
function Write-Result([bool]$Ok, [string]$Message, [bool]$NeedsRestart = $false, [bool]$Running = $false, $Extra = $null) {
  try {
    Ensure-AdminDir
    $obj = [ordered]@{
      action       = $Action
      ok           = $Ok
      running      = $Running
      message      = $Message
      needsRestart = $NeedsRestart
      steps        = @($script:Steps)
      finishedAt   = $(if ($Running) { $null } else { (Get-Date).ToString('o') })
      updatedAt    = (Get-Date).ToString('o')
      extra        = $Extra
    }
    $tmp = "$ResultFile.tmp"
    $obj | ConvertTo-Json -Depth 6 | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Path $tmp -Destination $ResultFile -Force
  } catch {}
}
function Fail([string]$msg) {
  Write-Log $msg 'error'
  [void]$script:Steps.Add([ordered]@{ label = $msg; state = 'failed'; detail = '' })
  Write-Result -Ok $false -Message $msg
  exit 1
}
function Run-Native([scriptblock]$Command) {
  # Native tools (icacls, net, powercfg, reg) print warnings to stderr; with
  # $ErrorActionPreference = 'Stop' PowerShell 5.1 turns a redirected stderr
  # line into a terminating error. Run them with 'Continue' and return exit code.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $Command 2>&1; $code = $LASTEXITCODE; if ($out) { Write-Log ("native: " + (($out | Out-String).Trim() -replace '\s+', ' ')) 'debug' } ; return $code }
  finally { $ErrorActionPreference = $prev }
}
function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Require-Admin { if (-not (Test-Admin)) { Fail "This action needs administrator rights (the app should have asked for them)." } }
function Find-Exe {
  if ($Exe -and (Test-Path $Exe)) { return (Resolve-Path $Exe).Path }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'FieldLinkKiosk\FieldLinkKiosk.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'FieldLinkKiosk\FieldLinkKiosk.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\FieldLinkKiosk\FieldLinkKiosk.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
function Get-ExeVersion([string]$path) {
  if (-not $path -or -not (Test-Path $path)) { return $null }
  try { $v = (Get-Item $path).VersionInfo.ProductVersion; if ($v) { return ([string]$v).Trim() } } catch {}
  return $null
}
function Read-Json([string]$path) {
  try { if (Test-Path $path) { return (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json) } } catch {}
  return $null
}
function Get-ConfiguredServer {
  if ($Server) { return $Server }
  $u = Read-Json $UpdateCfg
  if ($u -and $u.server) { return [string]$u.server }
  $c = Read-Json (Join-Path $DataDir 'config.json')
  if ($c -and $c.kioskUrl) { try { return ([Uri]$c.kioskUrl).GetLeftPart([UriPartial]::Authority) } catch {} }
  return $null
}
function Test-AutoLogonConfigured {
  try { $wl = Get-ItemProperty $WinLogon; return ($wl.AutoAdminLogon -eq '1' -and $wl.DefaultUserName -eq $KioskUser) } catch { return $false }
}
function Get-TaskInfo {
  try {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $i = $t | Get-ScheduledTaskInfo
    return [ordered]@{ installed = $true; state = [string]$t.State; lastRun = $(if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { $null }); lastResult = $i.LastTaskResult; nextRun = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }) }
  } catch { return [ordered]@{ installed = $false } }
}

# -- LSA secret for autologon (what Sysinternals Autologon does) --------------
function Ensure-LsaType {
  if (([System.Management.Automation.PSTypeName]'FieldLink.LsaSecret').Type) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace FieldLink {
  public static class LsaSecret {
    [StructLayout(LayoutKind.Sequential)]
    public struct LSA_UNICODE_STRING { public UInt16 Length; public UInt16 MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    public struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
    [DllImport("advapi32.dll", PreserveSig = true)]
    private static extern uint LsaOpenPolicy(IntPtr SystemName, ref LSA_OBJECT_ATTRIBUTES ObjectAttributes, uint DesiredAccess, out IntPtr PolicyHandle);
    [DllImport("advapi32.dll", PreserveSig = true)]
    private static extern uint LsaStorePrivateData(IntPtr PolicyHandle, ref LSA_UNICODE_STRING KeyName, ref LSA_UNICODE_STRING PrivateData);
    [DllImport("advapi32.dll", PreserveSig = true, EntryPoint = "LsaStorePrivateData")]
    private static extern uint LsaStorePrivateDataNull(IntPtr PolicyHandle, ref LSA_UNICODE_STRING KeyName, IntPtr PrivateData);
    [DllImport("advapi32.dll")] private static extern uint LsaNtStatusToWinError(uint status);
    [DllImport("advapi32.dll")] private static extern uint LsaClose(IntPtr PolicyHandle);
    private const uint POLICY_CREATE_SECRET = 0x00000020;
    private static LSA_UNICODE_STRING Make(string s) {
      LSA_UNICODE_STRING u = new LSA_UNICODE_STRING();
      u.Buffer = Marshal.StringToHGlobalUni(s);
      u.Length = (UInt16)(s.Length * 2);
      u.MaximumLength = (UInt16)(s.Length * 2 + 2);
      return u;
    }
    public static void Set(string key, string value) {
      LSA_OBJECT_ATTRIBUTES attrs = new LSA_OBJECT_ATTRIBUTES();
      attrs.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
      IntPtr handle;
      uint status = LsaOpenPolicy(IntPtr.Zero, ref attrs, POLICY_CREATE_SECRET, out handle);
      if (status != 0) throw new Exception("LsaOpenPolicy failed, win32 error " + LsaNtStatusToWinError(status));
      LSA_UNICODE_STRING k = Make(key);
      try {
        if (value == null) {
          status = LsaStorePrivateDataNull(handle, ref k, IntPtr.Zero);
        } else {
          LSA_UNICODE_STRING v = Make(value);
          try { status = LsaStorePrivateData(handle, ref k, ref v); }
          finally { Marshal.FreeHGlobal(v.Buffer); }
        }
        if (status != 0) throw new Exception("LsaStorePrivateData failed, win32 error " + LsaNtStatusToWinError(status));
      } finally {
        Marshal.FreeHGlobal(k.Buffer);
        LsaClose(handle);
      }
    }
  }
}
'@
}
function New-RandomPassword {
  $chars = ([char[]](48..57) + [char[]](65..90) + [char[]](97..122))
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

# -- building blocks ----------------------------------------------------------
function Ensure-KioskAccount {
  $secure = ConvertTo-SecureString (New-RandomPassword) -AsPlainText -Force
  $plain  = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure))
  if (-not (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
    New-LocalUser -Name $KioskUser -Password $secure -FullName 'Field Link Kiosk' -Description 'FieldLink kiosk display (managed by the app)' -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    Step "Created local account $KioskUser"
  } else {
    # A fresh random password every time - this is also how a broken/blank
    # autologon from an older setup gets repaired.
    Set-LocalUser -Name $KioskUser -Password $secure -PasswordNeverExpires $true -UserMayChangePassword $false -AccountNeverExpires
    Step "Reset password on existing account $KioskUser"
  }
  Enable-LocalUser -Name $KioskUser
  try { Remove-LocalGroupMember -Group 'Administrators' -Member $KioskUser -ErrorAction Stop; Step "Removed $KioskUser from Administrators" } catch {}
  if (-not (Get-LocalGroupMember -Group 'Users' -Member $KioskUser -ErrorAction SilentlyContinue)) { Add-LocalGroupMember -Group 'Users' -Member $KioskUser -ErrorAction SilentlyContinue }
  Run-Native { net user $KioskUser /logonpasswordchg:no } | Out-Null
  return $plain
}

function Ensure-DataDirs {
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  Ensure-AdminDir
  # Admin folder: Administrators + SYSTEM full, everyone else read-only. The
  # updater runs as SYSTEM from here, so the kiosk account must not be able
  # to change anything in it.
  $rc = Run-Native { icacls "$AdminDir" /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'Users:(OI)(CI)RX' }
  if ($rc -ne 0) { throw "icacls on $AdminDir failed (exit $rc)" }
  Step 'Prepared data folders' 'ok' "$DataDir (kiosk may write), $AdminDir (admins only)"
}

# Called only once the kiosk account exists.
function Grant-KioskDataAcl {
  $rc = Run-Native { icacls "$DataDir" /grant "${KioskUser}:(OI)(CI)M" /T }
  if ($rc -ne 0) { throw "icacls on $DataDir failed (exit $rc)" }
  Step "Kiosk account may update $DataDir (for re-linking from the app)"
}

function Ensure-Profile {
  if (Test-Path "$ProfilePath\NTUSER.DAT") { return }
  if (-not ([System.Management.Automation.PSTypeName]'Win32Functions.UserEnv').Type) {
    Add-Type -Namespace Win32Functions -Name UserEnv -MemberDefinition @'
[DllImport("userenv.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern int CreateProfile(
    [MarshalAs(UnmanagedType.LPWStr)] string pszUserSid,
    [MarshalAs(UnmanagedType.LPWStr)] string pszUserName,
    [Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszProfilePath,
    uint cchProfilePath);
'@
  }
  $sid = (Get-LocalUser -Name $KioskUser).SID.Value
  $sb  = New-Object System.Text.StringBuilder(260)
  $hr  = [Win32Functions.UserEnv]::CreateProfile($sid, $KioskUser, $sb, $sb.Capacity)
  # 0 = S_OK, 0x800700B7 = already exists
  if ($hr -ne 0 -and $hr -ne -2147024713) { Write-Log ("CreateProfile returned 0x{0:X8}" -f $hr) 'warn' }
  $tries = 0
  while (-not (Test-Path "$ProfilePath\NTUSER.DAT") -and $tries -lt 20) { Start-Sleep -Milliseconds 500; $tries++ }
  if (-not (Test-Path "$ProfilePath\NTUSER.DAT")) { Fail "Windows did not create a profile for $KioskUser. Sign in as $KioskUser once (Ctrl+Alt+Del > Switch user), sign out, then run kiosk mode again." }
  Step "Created Windows profile for $KioskUser"
}

function Set-KioskShell([string]$exePath, [bool]$lock) {
  $hive = "$ProfilePath\NTUSER.DAT"
  if (-not (Test-Path $hive)) { if ($lock) { Fail "Profile hive not found at $hive" } else { return } }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
  & reg load 'HKU\FLKiosk' $hive 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  if ($lock) {
    & reg add 'HKU\FLKiosk\Software\Microsoft\Windows NT\CurrentVersion\Winlogon' /v Shell /t REG_SZ /d "`"$exePath`"" /f 2>&1 | Out-Null
    & reg add 'HKU\FLKiosk\Software\Microsoft\Windows\CurrentVersion\Policies\System'   /v DisableTaskMgr     /t REG_DWORD /d 1 /f 2>&1 | Out-Null
    & reg add 'HKU\FLKiosk\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer' /v NoViewContextMenu  /t REG_DWORD /d 1 /f 2>&1 | Out-Null
    & reg add 'HKU\FLKiosk\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer' /v NoRun              /t REG_DWORD /d 1 /f 2>&1 | Out-Null
  } else {
    & reg delete 'HKU\FLKiosk\Software\Microsoft\Windows NT\CurrentVersion\Winlogon' /v Shell /f 2>&1 | Out-Null
    & reg delete 'HKU\FLKiosk\Software\Microsoft\Windows\CurrentVersion\Policies\System'   /v DisableTaskMgr    /f 2>&1 | Out-Null
    & reg delete 'HKU\FLKiosk\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer' /v NoViewContextMenu /f 2>&1 | Out-Null
    & reg delete 'HKU\FLKiosk\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer' /v NoRun             /f 2>&1 | Out-Null
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers(); Start-Sleep -Seconds 2
  & reg unload 'HKU\FLKiosk' 2>&1 | Out-Null
  $ErrorActionPreference = $prev
  if ($lock) { Step "Locked $KioskUser's shell to the kiosk app" 'ok' $exePath } else { Step "Restored the normal Windows desktop for $KioskUser" }
}

function Set-AutoLogon([string]$password) {
  Ensure-LsaType
  [FieldLink.LsaSecret]::Set('DefaultPassword', $password)
  Set-ItemProperty $WinLogon -Name 'AutoAdminLogon'    -Value '1'
  Set-ItemProperty $WinLogon -Name 'DefaultUserName'   -Value $KioskUser
  Set-ItemProperty $WinLogon -Name 'DefaultDomainName' -Value $env:COMPUTERNAME
  # Never leave a plain-text password or a login counter behind, and never
  # force the login (admins must be able to sign out and switch user).
  foreach ($n in 'DefaultPassword', 'AutoLogonCount', 'ForceAutoLogon') { Remove-ItemProperty $WinLogon -Name $n -ErrorAction SilentlyContinue }
  # Blank passwords are no longer needed - restore the Windows default.
  Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' -Name 'LimitBlankPasswordUse' -Value 1 -Type DWord -ErrorAction SilentlyContinue
  Step 'Auto-login on boot configured' 'ok' 'password stored in the LSA secret, not the registry'
}

function Clear-AutoLogon {
  Set-ItemProperty $WinLogon -Name 'AutoAdminLogon' -Value '0'
  if ((Get-ItemProperty $WinLogon).DefaultUserName -eq $KioskUser) { Remove-ItemProperty $WinLogon -Name 'DefaultUserName' -ErrorAction SilentlyContinue }
  foreach ($n in 'DefaultPassword', 'AutoLogonCount', 'ForceAutoLogon') { Remove-ItemProperty $WinLogon -Name $n -ErrorAction SilentlyContinue }
  try { Ensure-LsaType; [FieldLink.LsaSecret]::Set('DefaultPassword', $null) } catch {}
  Step 'Auto-login disabled'
}

function Set-PowerSettings([bool]$kiosk) {
  if ($kiosk) {
    Run-Native { powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c } | Out-Null
    Run-Native { powercfg /change monitor-timeout-ac 0 } | Out-Null
    Run-Native { powercfg /change monitor-timeout-dc 0 } | Out-Null
    Run-Native { powercfg /change standby-timeout-ac 0 } | Out-Null
    Run-Native { powercfg /change standby-timeout-dc 0 } | Out-Null
    Run-Native { powercfg /hibernate off } | Out-Null
    New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' -Force -ErrorAction SilentlyContinue | Out-Null
    Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' -Name 'ScreenSaveActive' -Value '0' -ErrorAction SilentlyContinue
    Run-Native { reg add 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OOBE' /v SkipMachineOOBE /t REG_DWORD /d 1 /f } | Out-Null
    Run-Native { reg add 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OOBE' /v SkipUserOOBE    /t REG_DWORD /d 1 /f } | Out-Null
    Step 'Sleep, screen timeout and screensaver disabled'
  } else {
    Run-Native { powercfg /change monitor-timeout-ac 30 } | Out-Null
    Run-Native { powercfg /change standby-timeout-ac 60 } | Out-Null
    Remove-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' -Name 'ScreenSaveActive' -ErrorAction SilentlyContinue
    Step 'Power settings restored (30 min display, 60 min sleep)'
  }
}

function Install-Updater([string]$serverOrigin) {
  Ensure-DataDirs
  Copy-Item -Path $PSCommandPath -Destination $ScriptCopy -Force
  if ($serverOrigin) {
    if ($serverOrigin -notmatch '^https://') { Fail "Updates are only fetched over https ($serverOrigin)" }
    [ordered]@{ server = $serverOrigin; savedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Path $UpdateCfg -Encoding UTF8
  }
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptCopy`" -Action Update"
  $action   = New-ScheduledTaskAction -Execute $ps -Argument $arg
  $triggers = @(
    (New-ScheduledTaskTrigger -Daily -At 3:15am),
    (New-ScheduledTaskTrigger -AtStartup)
  )
  $triggers[1].Delay = 'PT3M'
  $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Installs newer FieldLink Kiosk builds from the FieldLink server (nightly and after boot).' -Force | Out-Null
  Step 'Automatic updates scheduled' 'ok' 'nightly at 03:15 and 3 min after boot, as SYSTEM'
}

function Remove-Updater {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Step 'Automatic update task removed'
}

function Write-UpdateStatus($obj) {
  try { Ensure-AdminDir; $obj | ConvertTo-Json -Depth 4 | Set-Content -Path $UpdateLog -Encoding UTF8 } catch {}
}

# -- actions ------------------------------------------------------------------
try {
switch ($Action) {

  'Status' {
    $exe = Find-Exe
    $status = [ordered]@{
      exe             = $exe
      version         = Get-ExeVersion $exe
      isAdmin         = Test-Admin
      accountExists   = [bool](Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)
      accountEnabled  = $(try { (Get-LocalUser -Name $KioskUser -ErrorAction Stop).Enabled } catch { $false })
      profileExists   = (Test-Path "$ProfilePath\NTUSER.DAT")
      autoLogon       = Test-AutoLogonConfigured
      updater         = Get-TaskInfo
      updateStatus    = Read-Json $UpdateLog
      updateServer    = Get-ConfiguredServer
      lastAction      = Read-Json $ResultFile
      currentUser     = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      isKioskSession  = ([Security.Principal.WindowsIdentity]::GetCurrent().Name -like "*\$KioskUser")
      dataDir         = $DataDir
      adminDir        = $AdminDir
      logFile         = $LogFile
    }
    $status.lockedDown = ($status.accountExists -and $status.autoLogon -and $status.profileExists)
    $status | ConvertTo-Json -Depth 6
    exit 0
  }

  'Lockdown' {
    Require-Admin
    Write-Result -Ok $true -Message 'Starting...' -Running $true
    $exe = Find-Exe
    if (-not $exe) { Fail 'FieldLinkKiosk.exe was not found. Install the kiosk app first.' }
    Step 'Kiosk app found' 'ok' "$exe (v$(Get-ExeVersion $exe))"
    Ensure-DataDirs
    $password = Ensure-KioskAccount
    Grant-KioskDataAcl
    Ensure-Profile
    Set-KioskShell -exePath $exe -lock $true
    Set-AutoLogon -password $password
    $password = $null
    Set-PowerSettings -kiosk $true
    try { Install-Updater -serverOrigin (Get-ConfiguredServer) } catch { Write-Log "Updater not installed: $_" 'warn'; Step 'Automatic updates could not be scheduled' 'warn' "$_" }
    # verify
    $ok = (Test-AutoLogonConfigured) -and (Test-Path "$ProfilePath\NTUSER.DAT") -and (Get-LocalUser -Name $KioskUser).Enabled
    if (-not $ok) { Fail 'Verification failed - see admin.log' }
    Step 'Verified' 'ok' 'account, profile and auto-login all in place'
    Write-Result -Ok $true -Message "Kiosk mode is set up. Restart to boot straight into the display." -NeedsRestart $true
    exit 0
  }

  'Unlock' {
    Require-Admin
    Write-Result -Ok $true -Message 'Starting...' -Running $true
    Clear-AutoLogon
    Set-KioskShell -exePath '' -lock $false
    Set-PowerSettings -kiosk $false
    Remove-Updater
    if (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue) { Disable-LocalUser -Name $KioskUser; Step "Account $KioskUser disabled (not deleted)" }
    Write-Result -Ok $true -Message 'Kiosk mode removed. Restart to apply.' -NeedsRestart $true
    exit 0
  }

  'InstallUpdater' {
    Require-Admin
    Write-Result -Ok $true -Message 'Starting...' -Running $true
    Install-Updater -serverOrigin (Get-ConfiguredServer)
    Write-Result -Ok $true -Message 'Automatic updates are on.'
    exit 0
  }

  'RemoveUpdater' {
    Require-Admin
    Write-Result -Ok $true -Message 'Starting...' -Running $true
    Remove-Updater
    Write-Result -Ok $true -Message 'Automatic updates are off.'
    exit 0
  }

  'Update' {
    Require-Admin
    $startedAt = (Get-Date).ToString('o')
    $status = [ordered]@{ checkedAt = $startedAt; installed = $null; latest = $null; result = 'none'; error = $null; server = $null }
    try {
      $exe = Find-Exe
      $installed = Get-ExeVersion $exe
      $status.installed = $installed
      $origin = Get-ConfiguredServer
      $status.server = $origin
      if (-not $origin) { throw 'No FieldLink server configured yet (link the display first).' }
      if ($origin -notmatch '^https://') { throw "Refusing to update from a non-https server ($origin)." }
      Write-Log "Update check: installed=$installed server=$origin"
      $info = Invoke-RestMethod -Uri "$origin/api/kiosk/installer/version" -TimeoutSec 30 -UseBasicParsing -Headers @{ 'User-Agent' = "FieldLinkKiosk-Updater/$installed" }
      $latest = [string]$info.version
      $status.latest = $latest
      if (-not $latest) { throw 'Server did not report an installer version.' }
      $newer = $false
      try { $newer = (-not $installed) -or ([version]$latest -gt [version]$installed) } catch { $newer = ($latest -ne $installed) }
      if (-not $newer -and -not $Force) {
        $status.result = 'up-to-date'; Write-UpdateStatus $status; Write-Log "Up to date ($installed)"
        Write-Result -Ok $true -Message "Up to date (FieldLinkKiosk $installed)." -Extra $status
        exit 0
      }
      $dlDir = Join-Path $AdminDir 'updates'
      New-Item -ItemType Directory -Path $dlDir -Force | Out-Null
      Get-ChildItem $dlDir -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
      $file = Join-Path $dlDir "FieldLinkKiosk-Setup-$latest.exe"
      Write-Log "Downloading $latest from $origin/api/kiosk/installer"
      Write-Result -Ok $true -Message "Downloading FieldLinkKiosk $latest..." -Running $true
      Invoke-WebRequest -Uri "$origin/api/kiosk/installer" -OutFile $file -TimeoutSec 900 -UseBasicParsing -Headers @{ 'User-Agent' = "FieldLinkKiosk-Updater/$installed" }
      $len = (Get-Item $file).Length
      if ($info.size -and [int64]$info.size -ne $len) { throw "Download size mismatch (got $len, expected $($info.size))." }
      if ($info.sha256) {
        $hash = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLower()
        if ($hash -ne ([string]$info.sha256).ToLower()) { throw 'Download checksum mismatch - not installing.' }
      }
      $sig = Get-AuthenticodeSignature -FilePath $file
      Write-Log "Installer signature: $($sig.Status)"
      $wasRunning = [bool](Get-Process -Name 'FieldLinkKiosk' -ErrorAction SilentlyContinue)
      Write-Result -Ok $true -Message "Installing FieldLinkKiosk $latest..." -Running $true
      Get-Process -Name 'FieldLinkKiosk' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      $p = Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru
      if ($p.ExitCode -ne 0) { throw "Installer exited with code $($p.ExitCode)." }
      $exe = Find-Exe
      $now = Get-ExeVersion $exe
      Write-Log "Installed $now"
      # keep our own copy current for the next scheduled run
      $newScript = Join-Path (Split-Path $exe -Parent) 'resources\kiosk-admin.ps1'
      if (Test-Path $newScript) { Copy-Item $newScript $ScriptCopy -Force }
      Remove-Item $file -Force -ErrorAction SilentlyContinue
      $status.result = 'installed'; $status.installed = $now
      Write-UpdateStatus $status
      if ($Relaunch) {
        # Launched from an admin's interactive session: start the app again
        # de-elevated (explorer launches things as the desktop user).
        Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList "`"$exe`""
        Write-Result -Ok $true -Message "Updated to FieldLinkKiosk $now." -Extra $status
      } elseif ($wasRunning) {
        # Scheduled run while the kiosk account was signed in: the app was its
        # shell, so the screen is black until the next sign-in. Restart.
        Write-Result -Ok $true -Message "Updated to FieldLinkKiosk $now - restarting." -NeedsRestart $true -Extra $status
        Run-Native { shutdown.exe /r /t 20 /c "FieldLink Kiosk was updated to $now" /d p:4:2 } | Out-Null
      } else {
        Write-Result -Ok $true -Message "Updated to FieldLinkKiosk $now." -Extra $status
      }
      exit 0
    } catch {
      $status.result = 'failed'; $status.error = "$_"
      Write-UpdateStatus $status
      Write-Log "Update failed: $_" 'error'
      Write-Result -Ok $false -Message "Update failed: $_" -Extra $status
      exit 1
    }
  }
}
} catch {
  $where = ''
  try { $where = " (line $($_.InvocationInfo.ScriptLineNumber))" } catch {}
  Fail ("$Action failed: " + $_.Exception.Message + $where)
}
