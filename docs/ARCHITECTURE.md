# CoinQuest — Architecture & Product Spec (v0.1 draft)

*Working name. Easy to rename. Last updated 2026-10-11.*

**Decisions locked in:** child is 11 (fluent reader; typing module starts at touch-typing fluency with a placement test) · both Edge and Chrome are policy-locked · local-first, single machine, but every data model carries a `householdId` and `childId` so cloud sync and other families can be added without a rewrite · arcade uses Ruffle for Flash + open-source HTML5 games.

## 1. What this is

A Windows application that turns a child's computer into a learning machine with an economy:

- The child's Windows profile is **locked to an allowlist** (apps and websites). The parent/admin profile is untouched.
- Learning activities **earn coins**. Coins are spent on **prizes** (YouTube minutes, game minutes, anything the parent defines).
- Everything is managed from a **Parent Console** that a non-technical parent can run without reading a manual.
- The app **updates itself** from GitHub so the child's machine always runs what's on `main`.

### Design principles

1. **Parent never needs a manual.** No settings pages full of toggles. Wizards, plain language, sensible defaults.
2. **Child can't cheat it.** Ledger and enforcement live in a Windows Service the child account cannot touch.
3. **Earning is verifiable.** Every coin source declares how it's verified (in-app, observed, or parent-approved).
4. **Everything is a module.** New earning sources and new prizes plug in without touching the core.
5. **Fail safe.** If anything breaks, the machine stays locked down — never wide open.

---

## 2. System components

```
┌─────────────────────────────────────────────────────────────────┐
│  Windows machine                                                │
│                                                                 │
│  ┌───────────────────────────┐   runs as LocalSystem            │
│  │  Guardian Service         │   always on, survives logoff     │
│  │  - process allowlist      │   owns the ledger (SQLite)       │
│  │  - web allowlist (policy) │   owns time-unlock timers        │
│  │  - coin ledger            │   checks GitHub for updates      │
│  │  - update checker         │                                  │
│  └─────────────┬─────────────┘                                  │
│                │ named pipe (authenticated IPC)                  │
│    ┌───────────┴───────────┐      ┌───────────────────────┐     │
│    │ Scholar (child app)   │      │ Parent Console        │     │
│    │ - lesson modules      │      │ - PIN protected       │     │
│    │ - coin wallet + shop  │      │ - approvals queue     │     │
│    │ - countdown overlay   │      │ - allowlist editor    │     │
│    │ - runs in child       │      │ - prize catalog       │     │
│    │   session, kiosk-ish  │      │ - reports             │     │
│    └───────────────────────┘      └───────────────────────┘     │
│                                                                 │
│    ┌───────────────────────┐                                    │
│    │ Browser extension     │  (Edge/Chrome) observes Khan       │
│    │ (optional, phase 2)   │  Academy progress, YouTube time    │
│    └───────────────────────┘                                    │
└─────────────────────────────────────────────────────────────────┘
                     │
                     ▼  HTTPS, read-only
            GitHub Releases (built by Actions on every push to main)
```

### 2.1 Guardian Service (the enforcer)

- .NET 8 Worker Service, installed to run as `LocalSystem`.
- Detects which Windows account is logged into the interactive session. Rules apply **only** when a *managed child account* is active. Admin/parent accounts are ignored entirely.
- **App allowlist:** polls running processes (~1s via ETW or WMI process-start events, not busy-loop). Any process in the child's session whose executable isn't on the allowlist is terminated and a friendly "That's not on your list" toast is shown. System processes are exempt by a built-in safe list.
- **Web allowlist:** written as **both** Edge and Chrome *per-user* policies in the child's `HKCU\Software\Policies\...` hive:
  `URLBlocklist = ["*"]`, `URLAllowlist = [allowed domains + whatever is currently unlocked]`. The browser enforces it, the child can't change it, and it's per-user so the parent's browser is untouched. The service rewrites these keys whenever the allowlist or an unlock changes; the browser picks them up live.
- **Time unlocks:** when the child spends coins on "20 minutes of YouTube", the service (a) adds `youtube.com` to the allowlist, (b) starts a timer, (c) on expiry removes it and tells Scholar to show the "time's up" overlay. Timers persist to disk so a reboot doesn't reset them.
- **Ledger:** SQLite in `C:\ProgramData\CoinQuest\`, ACL'd so only SYSTEM and Administrators can write. Every transaction is append-only with a hash chain, so a tampered DB is detectable.
- **Update checker:** see §6.

### 2.2 Scholar (the child's app)

- WPF shell hosting **WebView2**. The lessons themselves are HTML/TypeScript, so they can be as animated and game-like as we want without fighting a native UI toolkit.
- Launched at login for managed accounts; full-screen "home base" with: coin balance, today's quests, the shop, and a big "Start learning" button.
- Talks to the Guardian over an authenticated named pipe. Scholar *reports* results; **only the service mints coins** after validating the result against the module's rules (so a child who opens dev tools can't award themselves coins).
- Lesson modules are loaded from `/modules/<name>/` and share one contract (§4).

### 2.3 Parent Console

- Same WPF + WebView2 shell, different entry point. Opens from the parent's own account (no restrictions there) **or** from inside the child's session with a PIN (so a parent can approve something over the child's shoulder).
- Screens — kept to five, deliberately:
  1. **Today** — what the child did, coins earned/spent, anything waiting for approval.
  2. **Approvals** — one-tap approve/deny for parent-verified earnings (e.g. "Finished Khan Academy: Multiplication, 35 coins?").
  3. **Allowed** — the app and website allowlist. Add by picking from "apps on this computer" or typing a website. Presets: "School basics", "Creative tools", etc.
  4. **Shop** — the prize catalog. Name, cost, what it unlocks (website / app / nothing — "real world" prizes like "pick dinner" are supported too), daily cap.
  5. **Quests** — which earning modules are on, how many coins each pays, daily limits.
- Setup wizard on first run: pick the child's Windows account (or create one), set a PIN, choose a preset, done.

### 2.4 Browser extension (phase 2)

Chrome/Edge extension, force-installed via the same per-user policy mechanism, that:
- Reads Khan Academy's on-page "mastery / completed" signals and posts them to the Guardian (verification level: *observed*, parent can require approval or trust it).
- Reports active YouTube watch time so the unlock timer counts only actual watching, not an idle tab.

---

## 3. The economy

### Coins

- Integer currency. Ledger rows: `{timestamp, delta, source_module, source_detail, verification, approved_by}`.
- Earn sources declare a **verification level**:
  - `in_app` — module ran inside Scholar; the service validates the submitted result (typing accuracy, time-on-task, correct answers). Auto-credited.
  - `observed` — detected by the extension. Auto-credited or queued, per parent setting.
  - `parent_approved` — child submits a claim ("I did my Khan lesson"), parent taps approve. Nothing credits until then.
- Daily caps per module prevent grinding (e.g. "Bible typing pays max 60 coins/day").
- Optional **streak bonus** and **weekly allowance** — both off by default, parent can enable.

### Prizes (shop)

| Prize | Type | What the Guardian does |
|---|---|---|
| 20 min YouTube | web unlock + timer | Adds `youtube.com` to allowlist for 20 min |
| 30 min games | web or app unlock + timer | Unlocks the game library (bundled HTML5 games or a parent-approved site) |
| Extra 15 min screen time | schedule extension | Extends today's logout time |
| Pick Friday movie | real-world | Just logs it; parent sees it in Today |

The parent defines these; the four above are starter presets. "Flash games" → we ship a small library of licensed/open-source HTML5 games inside Scholar so nothing external is needed, and the parent can also allowlist a games site.

---

## 4. Learning modules

One contract, many modules:

```ts
interface LessonModule {
  id: string;                 // "phonics-type"
  title: string;              // shown to child
  verification: "in_app" | "observed" | "parent_approved";
  // Returns the next activity for this child, given their progress.
  nextActivity(progress: Progress): Activity;
  // Validates a completed activity server-side (in the Guardian) and returns coins earned.
  score(activity: Activity, result: Result): { coins: number; progressDelta: Progress };
}
```

### v1 modules

**TypingQuest** (original content; inspired by the one-sound/one-finger-at-a-time pedagogy of Read, Write & Type, built for an 11-year-old)
- **Placement test** on first run: a 60-second typed passage sets starting WPM/accuracy and which keys are weak.
- **Key lanes:** home row → top row → bottom row → shift/punctuation → numbers. Each key: drill in isolation → in words → in sentences → timed.
- **Reading passages:** every few lessons the drill text is a real short passage (science, history, scripture, fiction snippets in the public domain) followed by 2–3 comprehension questions — so typing practice is also reading practice.
- **Vocabulary:** words above grade level in a passage get a tap-to-define glossary; recurring words become a "words I know" collection.
- **Mastery gating:** advance at ≥95% accuracy and the lane's target WPM (ramps 15 → 40 WPM across the course). Weak keys get re-queued automatically.
- Coins: per completed drill, bonus for beating personal-best WPM with ≥95% accuracy.

**Bible Typing**
- Public-domain text: World English Bible (modern English, no licensing issue). KJV can be added as a second translation.
- Parent (or a plan) picks passages; child types them with live accuracy/speed feedback.
- Coins scale with length × accuracy; daily cap. Also builds a "verses I've typed" collection the child can see grow.

**Khan Academy**
- v1: child picks "I finished a Khan lesson", enters the topic, parent approves from the queue.
- v2: extension observes completion → auto-credit.
- Khan Academy is added to the web allowlist automatically when this module is enabled.

**Arcade** (a prize, not an earning module, but a module all the same)
- Scholar bundles [Ruffle](https://ruffle.rs) (open-source Flash emulator, WebAssembly, fully offline) and a library of `.swf` games whose licenses permit redistribution (GPL/MIT — e.g. *5b*, *Ending*, *Red Rogue*, Adam Saltsman's Flixel games), plus open-source HTML5 games (*HexGL*, *2048*, *Hextris*, *micropolisJS*…). `content/games/MANIFEST.json` lists title, license and upstream URL for each.
- Parents can drop any `.swf` they own into `C:\\ProgramData\\CoinQuest\\arcade\\` and it appears in the arcade.
- Arcade is only reachable while an arcade unlock timer is running; the overlay counts down and the window closes at zero.

**Later (ideas you've mentioned or that fit):** math facts drills, reading comprehension with short passages + questions, memory verse recitation (speech-to-text), handwriting via tablet.

---

## 5. Security model

- Child account is a **Standard User**. Parent/admin accounts are never touched by any rule.
- Guardian runs as SYSTEM; its install dir, data dir and registry keys are ACL'd against Standard Users.
- Child cannot: stop the service, edit the ledger, change browser policies, run unlisted apps, use Task Manager/PowerShell/cmd (removed from allowlist by default), or boot into another account they don't have the password for.
- Parent PIN is hashed (Argon2). Three failures → 5-minute lockout.
- IPC between Scholar and Guardian is a named pipe with per-session tokens; Scholar is treated as untrusted input.
- **Known limits (honest):** a determined, technical teenager with physical access can always boot from USB or reinstall Windows. For a young child this design is airtight; for a teen, BitLocker + BIOS password closes the remaining holes. Documented in the parent guide.

---

## 6. Updates from GitHub `main`

```
push to main ──► GitHub Actions ──► build + sign ──► GitHub Release (vX.Y.Z)
                                                          ▲
Guardian checks every 6h ─────────────────────────────────┘
   └─► downloads delta package ─► applies on next idle moment
       (Scholar restarts itself; service restarts itself)
```

- The Guardian polls the GitHub Releases API, downloads `CoinQuest-win-x64.zip`, verifies the SHA-256 the workflow published beside it, stages it, and launches `CoinQuest.Updater.exe` (from outside the install dir) which stops the service, swaps files with a `.previous` backup for rollback, and restarts the service. The Guardian then relaunches Scholar in the child's session on its next heartbeat.
- Updates apply immediately when no managed child is at the keyboard, otherwise when the child logs off. Parent Console → Settings → "Check now" forces a check.
- Version is `0.1.<CI run number>`; every push to `main` becomes a release automatically (switch to tagged releases later for stability).
- Update check is HTTPS to `api.github.com` only — that domain is in the Guardian's own allowlist, not the child's browser allowlist.
- Parent Console shows "Version X — up to date" and a "Check now" button. That's the entire update UI.

---

## 7. Repository layout

```
coinquest/
├── src/
│   ├── Guardian/            # Windows Service (.NET 8)
│   ├── Scholar/             # Child app shell (WPF + WebView2)
│   ├── ParentConsole/       # Parent app shell (WPF + WebView2)
│   ├── Shared/              # IPC contracts, ledger, PIN store, Jint score engine
│   ├── Shell/               # WPF + WebView2 host used by both apps
│   ├── Updater/             # Swaps files and restarts the service
│   └── web/                 # TypeScript + Vite: lesson UIs, shop, console UI
│       └── modules/
│           ├── typing-quest/
│           ├── arcade/
│           ├── bible-typing/
│           └── khan-academy/
├── extension/               # Browser extension (phase 2)
├── installer/               # Inno Setup script (service registration, data-folder ACLs)
├── content/                 # Lesson content, public-domain Bible text, audio
├── docs/
│   ├── ARCHITECTURE.md      # this file
│   ├── PARENT_GUIDE.md      # plain-English guide (later: in-app help)
│   └── MODULE_AUTHORING.md  # how to add a new earning source
└── .github/workflows/
    └── release.yml          # build + release on push to main
```

---

## 8. Build phases

| Phase | Deliverable | Child can… |
|---|---|---|
| **0** | Repo, CI, installer skeleton, auto-update working end-to-end | …install an app that updates itself |
| **1** | Guardian: app + web allowlist, managed-account detection, Parent Console wizard + Allowed screen | …use only allowed apps/sites |
| **2** | Ledger, shop, time unlocks, Today/Shop/Approvals screens | …spend coins (seeded manually) on YouTube minutes |
| **3** | Bible Typing module (fastest to build, proves the earn loop) | …earn coins |
| **4** | TypingQuest module (placement test, key lanes, reading passages) | …type fluently and read more |
| **5** | Khan Academy parent-approval flow; browser extension | …earn from Khan |
| **6** | Bundled HTML5 game library, reports, polish | …everything above, nicely |

Each phase ends with something installable on the child's machine.

---

## 9. Open questions (defaults in place, change any time)

1. **Bible translation** — defaulting to WEB. KJV available as a toggle later.
2. **Daily screen-time cap** on top of coins — defaulting to coins-only; a cap is a one-line config flag in Guardian.
3. **Name** — "CoinQuest" is a working name.
