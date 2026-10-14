# CoinQuest — status & decisions (2026-10-11)

Repo: https://github.com/drs-vision/Windows-Learning — pushed 2026-10-11; first CI build green; installer at https://github.com/drs-vision/Windows-Learning/releases/latest (`CoinQuest-Setup-0.1.N.exe`, ~97 MB, bundles .NET 8 runtime + WebView2). Full design in `docs/ARCHITECTURE.md`; parent-facing manual in `docs/PARENT_GUIDE.md`.

## What it is
Windows software that locks a child's account to an allowlist (apps + websites), pays **coins** for learning, and sells **prizes** (YouTube minutes, arcade minutes, real-world rewards). Parent's own account is never restricted. Self-updates from GitHub Releases on every push to `main`.

## Decisions locked in
- Child is 11 → TypingQuest starts at touch-typing fluency with a placement test; reading passages + comprehension questions instead of phonics.
- Both Edge and Chrome locked via per-user browser policy (HKU\<SID>); parent hive untouched.
- Local-first, single machine; every record carries householdId/childId so multi-family/cloud can be added later without migration.
- Scripture typing uses KJV (public domain, bundled starter of 20 passages; full text fetched at build).
- Arcade: Ruffle (open-source Flash emulator) + only games with verified redistributable licenses (5b, Ending, Red Rogue [off by default], 2048, Hextris, HexGL, micropolisJS, T-Rex Runner, Underrun, Astray, Blockrain, Space Invaders, Clumsy Bird). Parents can drop their own .swf files into `C:\ProgramData\CoinQuest\arcade`.
- Coins are minted only by the Windows service (runs as SYSTEM). The same pure scoring code the UI runs is re-executed inside the service (Jint sandbox) — UI numbers are never trusted. Ledger is SQLite with a SHA-256 hash chain.
- Updates: custom updater against GitHub Releases (zip + sha256), applies when the child logs off.

## Components
| Piece | Stack |
|---|---|
| Guardian (service) | .NET 8 Worker; process allowlist, browser policy, ledger, unlock timers, named-pipe IPC, updater |
| Scholar (child app) / Parent Console | WPF + WebView2 shells over one Preact/TypeScript UI |
| Modules | TypingQuest, Scripture Typing, Khan Academy (parent-approved claims v1; browser extension v2) |
| Installer | Inno Setup; CI builds on windows-latest and publishes a Release per push to main |

## Status
- Web UI: builds, 15 scorer tests pass, full flow exercised in headless Chromium (setup wizard → parent adjust → child placement test → coins → buy arcade → Ruffle game runs with countdown).
- .NET: compiles and unit tests pass on GitHub Actions (windows-latest). Release v0.1.1 published automatically.
- Not yet started: Khan Academy browser extension (auto-verify), full-Bible plan, cloud sync/multi-household, additional earning modules.

## Next steps
1. Install `CoinQuest-Setup-0.1.N.exe` on the child's machine from an admin account; run the 3-step setup wizard. Report anything that doesn't behave — this is the first run on real Windows.
2. Preview the arcade games; enable Red Rogue if acceptable.
3. Phase 5: Khan Academy browser extension for automatic verification.

## 2026-10-12 — v0.1.6
- Web lock rebuilt: real browsers are closed on the child account; websites open only in CoinQuest's locked browser. (Browser policies alone were not honored on the home PC.)
- YouTube: channel allowlist, in-app player, only during YouTube time.
- Arcade: 2000s portal, pay-per-play (price by strategy, parent overrides). Classic Flash games via a local Flashpoint Archive install + CLIFp; ~70 curated search picks, parent approval required.
- Sound Keys: 39-lesson phonics + typing course for a beginner (child is autistic, no typing experience): errorless, untimed, calm mode, finger colours, espeak-ng phoneme clips. Parent-voice recording is a candidate next step.
- Open: first Flashpoint launch on real hardware untested; confirm the "stick man / glow monkey / choose your weapon" game title.

## 2026-10-12 — v0.1.12
- Internet lock is now kernel-level per account (Windows Filtering Platform): the child account can reach only CoinQuest's local gatekeeper, which allows only allowlisted sites (YouTube hosts only during YouTube time). Child recognized by SID, not name.
- Khan Academy pays automatically for correct answers / finished videos seen in CoinQuest's browser.
- Note: v0.1.10 and v0.1.11 builds failed (WPF project lacked `using System.IO`), so those fixes first ship in v0.1.12.
- Arcade auto-stocking: once Flashpoint Infinity is installed, the Guardian installs CLIFp, adds ~200 curated kid-safe classics (skips "preview" ones and anything a parent removed), fetches box art, and pre-downloads games as the service. Flashpoint's CLIFp and Server\*.exe (never its browsers/players) are allowed through the child's internet lock. Parent Today tab shows a nudge until classics are set up.
- Open: verify on real hardware that Flashpoint auto-detect + pre-download work as SYSTEM, and that the WFP permit lets on-demand game files load.

## 2026-10-12 — v0.1.13 → v0.1.19
- Updater fixed (v0.1.13): it crashed on launch (ran from a folder missing System.ServiceProcess.ServiceController.dll), so the home PC was stuck on 0.1.9 "applying". Now uses sc.exe only; one manual install of a ≥0.1.13 setup is needed to get past it.
- household.json saves survive locked/hidden/permission-damaged files (fallback copy, newest wins) — v0.1.14.
- Arcade time: "+" buys 5-minute blocks of a game (coins per 5 min, more thinking = cheaper: 2–6). Sampler pass = any game for 10 min, auto-priced a little above the priciest game. Paid time keeps counting; leaving a game is free while time remains. Old per-play price overrides reset (schema v5).
- YouTube uses the same "+" 5-minute blocks; always ≥2 coins per 5 min above the priciest arcade game (arcade > YouTube).
- Scoring sandbox now receives data as JSON parsed inside Jint (CLR lists could fail Array.isArray); CI test scores all 39 Letter Rescue lessons through the shipped bundle.
- **Letter Rescue** rebuilt as a full game: title screen, story scenes (Tap, Tock, Glitch), world map with 1–3 stars, mini-games (charge the key, home base F/J, echo cave, balloon pop, word bridge, mystery box, secret message, Glitch battle, sky writer), finish screen, Buddy Book, Talking Typewriter (free play, reads back what he types). Headless bot played all 39 lessons through the UI to completion.
- Scripture typing: errorless typing, paid by passage length only — no WPM or accuracy penalty (per David).

## 2026-10-12 — v0.1.20 → v0.1.33
- Arcade games closing right after Play: the screen closed any game it couldn't yet see time for; now uses the purchase's own end time (v0.1.20).
- Updates: check every 30 minutes; install right away unless the child is in paid game/YouTube time (then within 2 hours). Test machines (C:\ProgramData\CoinQuest\e2e-test-mode) never self-update.
- "timeout" errors / settings not saving / coins only working with the child app closed: the Guardian handled each window's requests one at a time; now each request runs independently, 64 spare threads, Flashpoint disk scan cached, longer timeouts (v0.1.27+).
- Khan coin amounts are typed numbers, not dropdowns.
- Real bug found by the Windows test: console account names were read as garbage (ANSI WTS call read as Unicode). SID matching had already masked it.
- 5b hidden: it only ever showed a blank olive screen in Ruffle.
- **End-to-end test on real Windows (CI job `e2e`)**: installs the setup, runs the Parent Console wizard, gives coins, adds a YouTube channel, then the Guardian-launched child app plays all 9 arcade games (each still running 14 s after Play), a sampler pass, YouTube time, Letter Rescue lesson 1 (Guardian pays coins) and a Scripture passage. Screenshots + logs are pushed to the `e2e-results` branch (`latest/`). First all-green run: v0.1.33. Limitation: on the test machine the signed-in account plays the child with internet lock and app blocking off; Flashpoint isn't covered. YouTube shows a "confirm you're not a bot" page from the CI datacenter IP only.

## 2026-10-12 — v0.1.34 → v0.1.42
- Parent Console "Object reference not set" (0.1.34): concurrent request handling let two requests use the SQLite ledger at once. Fixed in 0.1.35: slow network/disk operations run in parallel; everything touching the ledger/household runs one at a time.
- Classic Flash games no longer use Flashpoint's launcher (CLIFp errors "Unknown option 'q'" / "not a valid Flashpoint install"). The Guardian fetches each game from the Flashpoint Archive online (catalog API + data packs; legacy files as fallback; a local Flashpoint install is reused as a cache), unpacks to C:\ProgramData\CoinQuest\classics, and it plays in CoinQuest's own Ruffle player. ~137 kid-safe classics auto-added, first 15 pre-downloaded; games whose files aren't in the archive are hidden. Nothing for the parent to install.
- Settings that "don't stick": saves overwrote each other (a slow YouTube-channel lookup re-sent an older copy of the settings and erased a website added meanwhile). Since 0.1.42 saves run one at a time and apply only the changed parts onto the latest settings.
- Duolingo blank: its helper domains (CDNs) are now allowed automatically with the site; Parent Console → Allowed shows "Recently blocked" addresses with an Allow button; Settings has a Troubleshooting card (recent problems, blocked addresses, lock state).
- v0.1.42 e2e: ALL PASSED on real Windows — all 9 built-in games + classic Gravity Guy (Flashpoint) playing with in-game screenshots, sampler, YouTube (Mark Rober list + playback), Duolingo opens with content, Letter Rescue lesson 1 pays, Scripture pays, settings survive tab switches.
- Open: YouTube "Couldn't get videos" on the home PC (works on the test machine) — 0.1.42 shows the reason in the message and the Troubleshooting card; need a screenshot from the home PC. Next: Read, Write & Type (1995 TLC CD, 16-bit) via a 16-bit compatibility layer, coins from its sign-in progress files; the CD image must never be committed to GitHub.

## 2026-10-13 — v0.1.43 → v0.1.54
- Khan Academy and Duolingo pay automatically, no approvals: CoinQuest's browser watches each site's own save calls. Khan: 1 coin per correct answer, 3 per finished video, 5 per finished exercise/quiz/unit test; hand claims removed. Duolingo (new quest, switches on when duolingo.com is allowed): 5 per finished lesson or story. Khan's "finished exercise" signal is matched by name (Khan's API is undocumented) and every reply format is logged to shell.log for tuning; correct answers are the dependable part.
- One price sheet (schema v6): ≈1 coin per minute of learning; arcade 4 (thinking) to 8 (reflex) coins per 5 min; YouTube 12 per 5 min (default prize 48 coins / 20 min). Parent overrides kept.
- YouTube: creator chips; picking a creator scrolls through every video (YouTube's own web-app API, page by page: all 131 Mark Rober videos in the test); "Up next" rail beside the player with approved videos only; any listed video is playable, nothing else. YouTube's RSS feed returns 404 (likely David's "Couldn't get videos"); it now falls back to the app API, then the channel page, then the last saved list.
- HTML5 classics (e.g. Bloxorz) play from the local copy; any classic that can't play is removed from the arcade automatically. Flash games fill the play area.
- Updates: each download uses a fresh file name; "access denied" while an install runs shows "installing…" instead of an error.
- Parent Console → Settings → Advanced (collapsed) holds Troubleshooting, recent problems and recently blocked addresses (with Allow).
- v0.1.54 e2e: ALL PASSED, incl. Bloxorz, Up next switching videos, creator scroll 30→131.

## 2026-10-13 — v0.1.55 → v0.1.70
- Sign-in with 2-step verification (Google, Microsoft, Apple): sign-in pop-ups ("Continue with Google") now open as a real linked window instead of replacing the site; a page calling window.close() can't close the site window; Google's post-password pages (2-step verification, "is this you?", the accounts.youtube.com cookie hand-off, recaptcha) are allowed; Windows passkey/security-key helpers aren't blocked. Tested: Khan → Continue with Google opens Google sign-in and Khan stays open. Real 2-step verification needs David's account (not testable on the test machine).
- Flash classics keep their own stage size and are scaled as a picture (forcing Ruffle to rescale the stage is the likely cause of Sugar, Sugar's red filter acting as a platform; unverified on that exact game).
- Classics are served by CoinQuest itself; any file a game's local copy is missing is fetched on demand (Flashpoint legacy server, then the original site; "not found" pages are never saved). HTML5 classics have their addresses rewritten to the local copy. HTML5 classics with no archive data pack (e.g. Miniclip's HTML5 Bloxorz, a Unity build the archive lacks) are removed from the arcade automatically; the Flash Bloxorz stays and plays.
- "⚠️ Broken?" button in the game player hides a game (parent can restore in Shop → Arcade).
- YouTube "Newest from all" keeps loading older videos from every creator as you scroll.
- v0.1.70 e2e: ALL PASSED.

## 2026-10-13 — v0.1.71 → v0.1.81
- Auto-updates were failing on the home PC ("proxy tunnel … 127.0.0.1:47123 … 403"): Windows handed the child's gatekeeper proxy setting to the Guardian service, so it was refused by its own gate (also likely behind earlier YouTube/download failures there). The Guardian now never uses a proxy and removes a stray gatekeeper proxy from the service accounts at start. A PC stuck on ≤0.1.70 needs one manual install of the latest setup.
- "⚠️ Broken?" now refunds the coins paid for that game's current time and removes it from the list immediately (sampler passes aren't refunded). Tested on Windows: paid 8 → refunded 8.
- Read, Write & Type! (1995 TLC, 16-bit Win 3.1): Parent Console → Quests → Import disc image (.iso / .zip / CD folder). The Guardian reads the ISO directly (own ISO 9660 reader), unpacks the installer's TLC.1 (own InstallShield 3 + PKWARE-implode decoder; verified byte-identical to unshieldv3), applies three binary patches to RWTWINCD.EXE (256-colour check, palette check, game clock waits for window activation; original kept as .ORG), writes RWTWINCD.INI, makes SIGNIN writable by the child, and downloads otvdm v0.9.0 (winevdm) from its GitHub releases. Layout: C:\ProgramData\CoinQuest\rwt\{cd,SIGNIN,RWTWINCD.INI}. Launch: Scholar shell maps a private drive letter (DefineDosDevice) to rwt\, runs otvdmw "X:\cd\RWTWINCD.EXE" X:\SIGNIN with cwd X:\cd and a minimal environment (the 16-bit C runtime copies the environment into 64 KB and aborts with a big one). The game finds its .PRS data via the current directory; INI is read from <data>\..\RWTWINCD.INI. Coins (provisional): each changed player .dat save pays the "rwt" rate (5, cap 60/day, ≥4 min apart); every save is archived under rwt\history for decoding real level progress later (student file: 0x16C-byte header, version ≥0x102, then 0x1C-byte records).
- RWT status: not yet seen running. In Wine (Linux test bench) it passes its startup checks but sits on a black screen (engine never starts its first scene); otvdm itself won't run under Wine. First real run is on the home PC (Parent Console → Try it now).
- v0.1.81 e2e: ALL PASSED.

## 2026-10-13 — v0.1.82 → v0.1.90
- RWT: full scene redraw on repaint (WM_PAINT patch at 0x4bc4) + shell repaints every game window (class FingersWndClass / title "Read, Write…") every 300 ms. Progress lives in SIGNIN\<name6><n>\RWTWINCD.DAT (SIGNIN\RWTWINCD.DAT is only the sign-in list); guest play saves nothing — the kid screen explains signing in. Level = (stage + (step==3)) / 4 + 1 from the 0x16C header. Pays per changed player file (incl. first save), ≥2 min apart.
- Khan Academy videos pay once per video id (persisted in %LOCALAPPDATA%\CoinQuest\khan-videos.txt).
- Kid screens: WebView2 disk cache cleared when the version changes; index.html?v=<version>. Windows 10 coin glyph via a tiny COLR font when the system lacks 🪙.
- Enforcer: windowless helpers in System32/SysWOW64 allowed (e.g. SECOCL64.exe), never cmd/powershell/taskmgr/regedit/etc.
- Troubleshooting: internet check from the service (YouTube, Flashpoint, game search, GitHub).
- Classic CD games (new quest "discgames"): Parent Console → Quests → Classic CD games → Import a disc (.zip/.iso/.img/.bin, raw 2352-byte images supported). Finds the TLC program folder (INI with CDDrive=, e.g. 95INSTAL\CFMATH32.EXE + CFM.INI), copies disc → discgames\<id>\cd and program → discgames\<id>\app, sets CDDrive=<cd path>\ (a folder path works — no drive letter). Saves: app\*.DAT text records playerName/playerLevel/playerScore … PLAYER_END; pays 5 (cap 60/day, ≥1 min apart) when a player's level or score goes up; save history kept in discgames\<id>\history. Verified in Wine with ClueFinders Math Adventures (import, sign-in, new player, game start). Still to verify on Windows: 640×480×8 DirectDraw mode switch, and that playerScore rises as puzzles are solved. 4th/5th/6th Grade discs pending (Dropbox online-only files).
- Classic CD games, any disc (v0.1.9x): discs CoinQuest doesn't recognise are kept as discgames\<id>\disc.iso (raw 2352-byte images converted to plain ISO) with Mode "pending". Parent Console → Set up: the Guardian opens the ISO as a virtual CD drive (PowerShell Mount-DiskImage, as SYSTEM so every account sees it), snapshots Start-menu shortcuts / HKLM Uninstall keys / Program Files folders, and the parent shell runs the disc's installer (AUTORUN.INF open=, else a 32-bit SETUP). "Done installing" diffs the snapshot: the new shortcut gives exe/working folder/arguments (own .lnk parser), the new folder becomes InstallDir (made writable by Users so saves don't land in VirtualStore). Play mounts the ISO, then starts the exe — PE directly, NE (16-bit) through otvdm, DOS refused. Enforcer allows InstallDirs. Coins: ClueFinders player records when present; otherwise any changed save-type file (.dat/.sav/.usr/.plr/…) under InstallDir pays, ≥3 min apart; polled every minute.

## 2026-10-13 — v0.1.104 → v0.1.113
- Guardian identity bug (fixed 0.1.107): identifying a pipe client used RunAsClient on a pool thread and the impersonation could outlive it, so later work ran as the child — unlocks.json denied, games unkillable, and the service's own requests hit the child's WFP internet block ("access forbidden by its access permissions"). Now impersonation runs on a throwaway thread and every request starts with RevertToSelf. Troubleshooting → System check shows service identity, write probe, unlocks.json ACL, internet-lock SIDs (NetLock refuses non-person SIDs).
- Broadcast DSSAgent (spyware per Defender, on Mattel/TLC discs) is zeroed while writing disc.iso and never copied; Common Files\Mattel\Brodcast removed after installs. Touch keyboard (TabTip) and input helpers allowed.
- Installer mode: AutoPlay/AutoRun off machine-wide when CoinQuest mounts a disc (restored by --clear-policies). Setup finishes by itself when no installer/disc process has run for 15 s and something new is found; "Done installing" / "Choose its folder…" / "Wrong program? Choose it…" (exe picker) remain. Program choice order: recipe (ClueFinders 6th → CF6.EXE; 3rd/Years 3&4 and Reading/Missing Amulet → PLAY.EXE) → TLC program beside its CDDrive INI → uninstall DisplayIcon → new/rewritten shortcut (skipping TLCRUN/AUTORUN/launchers) → biggest program. Reinstalls over an earlier try are detected (rewritten shortcuts, folder named like the title).
- Every launch of an installed game re-points its remembered CD drive (INI CD*/source keys in the install dir, VirtualStore, Windows INIs naming CDDrive; publisher registry keys under WOW6432Node) at the drive the ISO is mounted on now. Try it reports the drive.
- 16-bit installers (won't run on 64-bit Windows) fall back to CoinQuest's own copy setup. RWT discs found in any Classic CD import are imported as RWT (SIGNIN players kept). Parent list: RWT row (On/Off = rwt module, coins per level, daily limit, Needs my OK), per-game "🪙 per progress" (game.json Coins; blank = module rate), "Runs:" path.

## 2026-10-14 — phone control
- Parent app → Settings → "Control from my phone": shows a QR code (parent PIN already required). The phone page (src/phone, GitHub Pages: drs-vision.github.io/Windows-Learning, deployed by .github/workflows/phone.yml) shows each child's coins, today's earned/spent, running game time, activity and pending requests; give/take coins, approve/deny, end game time. No account: the QR holds (after '#') relay URL, two random topics and a 256-bit key. Approved by David 2026-10-14 after the security trade-off was explained.
- Transport: public ntfy relay (ntfy.sh; COINQUEST_RELAY env overrides — self-hostable). Guardian PhoneLinkService keeps one streaming GET /{topics}/json?since=<last id> (requests sent while the PC was off arrive once, ≤12 h); replies POSTed to the phone's topic. Messages: JSON → deflate → AES-256-GCM, base64url, split into ≤3600-char "cq1:" parts (src/Shared/Phone/PhoneWire.cs ⇄ src/phone/wire.js; cross-checked by tests). Phone ops are limited to state/adjust/claim/endUnlock (RequestRouter.HandlePhone). phone-links.json is SYSTEM+Administrators only; removing a phone deletes its key.

## 2026-10-14 — negatives + parent UI polish (v0.1.120–0.1.123)
- Coin amounts a parent sets can be negative (quest rates and Khan/Duolingo sub-rates, per-game/RWT rates, claim approvals, Give/Take, phone ± key). Negative amounts are charged in full; daily limits cap only earning; EarnedToday sums positive deltas only. Prices stay ≥ 0 (a negative price would let kids farm coins).
- Parent app polish pass (checked by screenshots at 1280 and 720 px): Settings in two columns; approvals show quest names, "Today 9:41 PM" times and aligned coin boxes; sampler pass on one line; styled file picker; consistent number widths; checkboxes aligned with fields; real minus signs; no stray "·"; visible keyboard focus. e2e selector updated (Give button).

## 2026-10-14 — phone control panel (v0.1.125+)
- Phone app has a tab bar: Home (coins, requests, give/take, end game time), History (full ledger, paged 40 at a time, grouped by day, shows who on which phone), Rewards (each quest's on/off, coins, daily limit, needs-my-OK, Khan/Duolingo sub-rates; saves per field), Shop (edit price/limit/minutes/shown, delete; add Treat / YouTube time / Extra screen time prizes), Allowed (websites add/remove, YouTube channels add by link/remove).
- Guardian phone ops added: config, history, setQuest, setPrize, deletePrize, setSites, addChannel (resolved outside the lock), removeChannel. Still PC-only: parent PIN, internet lock, allowed apps, updates, CD games, arcade prices, website/app/arcade prizes. Ledger.Page(child, beforeSeq, limit).
- Parent app: PIN screen redesigned (card, hint, friendly wrong-PIN message, digits only); focus outlines; Advanced section spacing.
