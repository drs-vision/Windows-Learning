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
