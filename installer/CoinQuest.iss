; CoinQuest installer (Inno Setup 6). Built by CI; `iscc /DVersion=x.y.z /DStage=..\publish CoinQuest.iss` locally.
; Installs to Program Files, registers the Guardian service, locks down the data folder, launches setup.

#ifndef Version
  #define Version "0.1.0"
#endif
#ifndef Stage
  #define Stage "..\publish"
#endif
#ifndef Redist
  #define Redist "..\redist"
#endif

[Setup]
AppId={{7E2A6B0C-5B1E-4C7B-9F5A-3D1C0E9A77B1}
AppName=CoinQuest
AppVersion={#Version}
AppPublisher=CoinQuest contributors
AppPublisherURL=https://github.com/drs-vision/Windows-Learning
DefaultDirName={autopf}\CoinQuest
DefaultGroupName=CoinQuest
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=CoinQuest-Setup-{#Version}
SetupIconFile=coinquest.ico
UninstallDisplayIcon={app}\CoinQuest.ParentConsole.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Prerequisites, staged by CI. Extracted to {tmp} and run only when the machine needs them.
Source: "{#Redist}\windowsdesktop-runtime-win-x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist
Source: "{#Redist}\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist
Source: "{#Redist}\vc_redist.x86.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist
Source: "{#Redist}\vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist

[Dirs]
; Data folder: SYSTEM + Administrators full control, Users read-only. The child can't touch the ledger or config.
Name: "{commonappdata}\CoinQuest"; Permissions: system-full admins-full users-readexec
Name: "{commonappdata}\CoinQuest\arcade"; Permissions: system-full admins-full users-readexec
Name: "{commonappdata}\CoinQuest\logs"; Permissions: system-full admins-full users-readexec

[Icons]
Name: "{group}\CoinQuest Parent Console"; Filename: "{app}\CoinQuest.ParentConsole.exe"
Name: "{group}\CoinQuest (child app)"; Filename: "{app}\CoinQuest.Scholar.exe"
Name: "{commondesktop}\CoinQuest Parent Console"; Filename: "{app}\CoinQuest.ParentConsole.exe"

[Run]
; .NET 8 Desktop Runtime (needed by all four CoinQuest executables). Skipped when already present.
Filename: "{tmp}\windowsdesktop-runtime-win-x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing the .NET 8 runtime (one time, about a minute)..."; Flags: waituntilterminated skipifdoesntexist; Check: NeedsDotNet
; WebView2 runtime is on every supported Windows 10/11 machine; install it if it's somehow missing.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing WebView2 runtime..."; Flags: waituntilterminated skipifdoesntexist; Check: NeedsWebView2
; Microsoft Visual C++ runtime: the 16-bit helper (otvdm) for Read, Write & Type! and other 16-bit discs needs it.
Filename: "{tmp}\vc_redist.x86.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing the Microsoft Visual C++ runtime..."; Flags: waituntilterminated skipifdoesntexist; Check: NeedsVcRuntime('{syswow64}')
Filename: "{tmp}\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing the Microsoft Visual C++ runtime..."; Flags: waituntilterminated skipifdoesntexist; Check: NeedsVcRuntime('{sys}')
Filename: "sc.exe"; Parameters: "stop CoinQuestGuardian"; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "sc.exe"; Parameters: "delete CoinQuestGuardian"; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "sc.exe"; Parameters: "create CoinQuestGuardian binPath= ""{app}\CoinQuest.Guardian.exe"" start= auto DisplayName= ""CoinQuest Guardian"" obj= LocalSystem"; Flags: runhidden waituntilterminated
Filename: "sc.exe"; Parameters: "description CoinQuestGuardian ""Enforces CoinQuest allowlists and keeps the coin ledger for managed child accounts."""; Flags: runhidden waituntilterminated
Filename: "sc.exe"; Parameters: "failure CoinQuestGuardian reset= 60 actions= restart/5000/restart/5000/restart/5000"; Flags: runhidden waituntilterminated
Filename: "sc.exe"; Parameters: "start CoinQuestGuardian"; Flags: runhidden waituntilterminated
Filename: "{app}\CoinQuest.ParentConsole.exe"; Description: "Open the Parent Console to finish setup"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "sc.exe"; Parameters: "stop CoinQuestGuardian"; Flags: runhidden waituntilterminated; RunOnceId: "stopsvc"
Filename: "{app}\CoinQuest.Guardian.exe"; Parameters: "--clear-policies"; Flags: runhidden waituntilterminated; RunOnceId: "clearpol"
Filename: "sc.exe"; Parameters: "delete CoinQuestGuardian"; Flags: runhidden waituntilterminated; RunOnceId: "delsvc"

[Code]
function ServiceExists: Boolean;
var R: Integer;
begin
  Result := Exec('sc.exe', 'query CoinQuestGuardian', '', SW_HIDE, ewWaitUntilTerminated, R) and (R = 0);
end;

function NeedsVcRuntime(Dir: String): Boolean;
begin
  Result := not (FileExists(ExpandConstant(Dir) + '\vcruntime140.dll') and FileExists(ExpandConstant(Dir) + '\msvcp140.dll'));
end;

function NeedsWebView2: Boolean;
var V: String;
begin
  Result := not (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
  if Result then
    Result := not (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

// The .NET installer registers under the 32-bit registry view (WOW6432Node), so read HKLM32.
// Also accept the runtime folder on disk, so detection never depends on one mechanism.
function HasDesktopRuntime8: Boolean;
var Names: TArrayOfString; I: Integer; FR: TFindRec;
begin
  Result := False;
  if RegGetValueNames(HKLM32, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App', Names) then
    for I := 0 to GetArrayLength(Names) - 1 do
      if Copy(Names[I], 1, 2) = '8.' then Result := True;
  if not Result then
    if FindFirst(ExpandConstant('{commonpf64}\dotnet\shared\Microsoft.WindowsDesktop.App\8.*'), FR) then
    begin
      Result := True;
      FindClose(FR);
    end;
end;

function NeedsDotNet: Boolean;
begin
  Result := not HasDesktopRuntime8;
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  if not IsWin64 then
  begin
    MsgBox('CoinQuest needs 64-bit Windows 10 or 11.', mbError, MB_OK);
    Result := False;
  end;
end;

// Files can't be replaced while the service is running them, so stop everything before [Files] copies.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var R: Integer;
begin
  Result := '';
  if ServiceExists then
  begin
    Exec('sc.exe', 'stop CoinQuestGuardian', '', SW_HIDE, ewWaitUntilTerminated, R);
    Sleep(3000);
  end;
  Exec('taskkill.exe', '/F /IM CoinQuest.Scholar.exe /T', '', SW_HIDE, ewWaitUntilTerminated, R);
  Exec('taskkill.exe', '/F /IM CoinQuest.ParentConsole.exe /T', '', SW_HIDE, ewWaitUntilTerminated, R);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and NeedsDotNet then
    MsgBox('The .NET 8 runtime did not install. CoinQuest will not run until it is installed from https://dotnet.microsoft.com/download/dotnet/8.0 (choose "Desktop Runtime", x64).', mbError, MB_OK);
end;
