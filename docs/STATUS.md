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
