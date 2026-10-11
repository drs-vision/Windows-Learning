# Roadmap

| Phase | Status | Child can… |
|---|---|---|
| 0 — Repo, CI, installer, auto-update | scaffolded, awaiting first CI run | …install an app that updates itself |
| 1 — Guardian allowlist + Parent Console setup/Allowed | scaffolded | …use only allowed apps/sites |
| 2 — Ledger, shop, unlock timers, Today/Approvals | scaffolded | …spend coins on YouTube/arcade minutes |
| 3 — Bible Typing | scaffolded with scorer + UI | …earn coins |
| 4 — TypingQuest (placement, key lanes, passages) | scaffolded with scorer + first lanes | …type fluently |
| 5 — Khan Academy approval flow; browser extension | approval flow scaffolded; extension not started | …earn from Khan |
| 6 — Arcade (Ruffle + games), reports, polish | arcade shell + manifest; games fetched by CI | …everything above, nicely |

"Scaffolded" means the code exists and the web half builds and tests here; the Windows half compiles on CI (no .NET available in the authoring environment). First CI run on `main` is the real gate.
