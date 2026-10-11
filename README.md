# CoinQuest

**Turn a kid's Windows PC into a learning machine with an economy.**

- The child's Windows account only runs the apps and websites a parent allows. The parent's account is untouched.
- Learning earns **coins**. Coins buy **prizes** — YouTube minutes, arcade time, real-world rewards.
- Parents manage everything from a five-screen console designed for people who do not want to read a manual.
- The app keeps itself up to date from this repository's `main` branch.

> Status: **pre-alpha**. Phase 0–2 scaffolding. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and [docs/ROADMAP.md](docs/ROADMAP.md) for what works today.

## How it fits together

| Piece | What it is | Runs as |
|---|---|---|
| **Guardian** | Windows Service that enforces the allowlist, owns the coin ledger, runs unlock timers, and checks for updates | `LocalSystem`, always on |
| **Scholar** | The child's app — home base, quests, wallet, shop, arcade | Child's account, full screen |
| **Parent Console** | Today · Approvals · Allowed · Shop · Quests | Parent's account, or child's account behind a PIN |
| **Modules** | Earning sources: TypingQuest, Bible Typing, Khan Academy, and more | Inside Scholar; scored by Guardian |

## Earning sources (v1)

| Module | How it's verified | Notes |
|---|---|---|
| **TypingQuest** | In-app | Touch typing to fluency, with reading passages and vocabulary. Placement test finds the starting level. |
| **Bible Typing** | In-app | Type passages from the World English Bible (public domain). Coins scale with length × accuracy. |
| **Khan Academy** | Parent-approved (v1), observed via browser extension (v2) | Child submits "I finished X", parent taps approve. |

## Prizes (v1)

| Prize | What happens |
|---|---|
| YouTube minutes | `youtube.com` is unlocked in the browser for N minutes, then re-locked |
| Arcade minutes | Classic Flash games (via [Ruffle](https://ruffle.rs)) and open-source HTML5 games, bundled, no internet needed |
| Real-world rewards | Logged for the parent ("Pick Friday's movie") |

Every game in the arcade is redistributable under its own license — see [content/games/MANIFEST.json](content/games/MANIFEST.json). Drop your own `.swf` files into the arcade folder to add more.

## Development

```
src/web            TypeScript (Vite + Preact) — all UI and lesson modules
src/Guardian       .NET 8 Worker Service
src/Scholar        .NET 8 WPF + WebView2 shell (child)
src/ParentConsole  .NET 8 WPF + WebView2 shell (parent)
src/Shared         IPC contracts, ledger, module scoring
installer/         Velopack packaging
content/           Lesson content, Bible text, games
```

```powershell
# web
cd src/web && npm install && npm run dev        # UI in a browser with a mock Guardian
npm test                                         # module scoring tests

# windows (requires .NET 8 SDK + Windows)
dotnet build CoinQuest.sln
```

Every push to `main` builds a signed release via GitHub Actions and publishes it to GitHub Releases. Installed machines pick it up within six hours (or immediately from **Parent Console → Settings → Check now**).

## License

MIT for CoinQuest itself. Bundled games keep their own licenses (listed in the manifest).
