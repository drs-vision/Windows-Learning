; CoinQuest installer (Inno Setup 6). Built by CI; `iscc /DVersion=x.y.z /DStage=..\publish CoinQuest.iss` locally.
; Installs to Program Files, registers the Guardian service, locks down the data folder, launches setup.

#ifndef Version
  #define Version "0.1.0"
#endif
#ifndef Stage
  #define Stage "..\publish"
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
; WebView2 runtime is on every supported Windows 10/11 machine; install the bootstrapper if it's somehow missing.
Filename: "{app}\redist\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing WebView2 runtime..."; Flags: waituntilterminated skipifdoesntexist; Check: NeedsWebView2
Filename: "sc.exe"; Parameters: "stop CoinQuestGuardian"; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "sc.exe"; Parameters: "delete CoinQuestGuardian"; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "sc.exe"; Parameters: "create CoinQuestGuardian binPath= ""{app}\CoinQuest.Guardian.exe"" start= auto DisplayName= ""CoinQuest Guardian"" obj= LocalSystem"; Flags: runhidden waituntilterminated
Filename: "sc.exe"; Parameters: "description CoinQuestGuardian ""Enforces CoinQuest allowlists and keeps the coin ledger for managed child accounts."""; Flags: runhidden waituntilterminated
Filename: "sc.exe"; Parameters: "failure CoinQuestGuardian reset= 60 actions= restart/5000/restart/5000/restart/5000"; Flags: runhidden waituntilterminated
Filename: "sc.exe"; Parameters: "start CoinQuestGuardian"; Flags: runhidden waituntilterminated
Filename: "{app}\CoinQuest.ParentConsole.exe"; Description: "Open the Parent Console to finish setup"; Flags: postinstall nowait

[UninstallRun]
Filename: "sc.exe"; Parameters: "stop CoinQuestGuardian"; Flags: runhidden waituntilterminated; RunOnceId: "stopsvc"
Filename: "sc.exe"; Parameters: "delete CoinQuestGuardian"; Flags: runhidden waituntilterminated; RunOnceId: "delsvc"

[Code]
function ServiceExists: Boolean;
var R: Integer;
begin
  Result := Exec('sc.exe', 'query CoinQuestGuardian', '', SW_HIDE, ewWaitUntilTerminated, R) and (R = 0);
end;

function NeedsWebView2: Boolean;
var V: String;
begin
  Result := not (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
  if Result then
    Result := not (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;
