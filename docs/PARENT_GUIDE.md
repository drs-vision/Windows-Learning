# CoinQuest — Parent Guide

This is the whole manual. If you need more than this page, we've designed something wrong — tell us.

## What CoinQuest does

Your child's Windows account becomes a learning account:

- It only opens the apps and websites you've allowed.
- Learning earns coins. Coins buy prizes you define (YouTube time, arcade time, "pick Friday's movie").
- You see what happened today, approve anything that needs approving, and that's it.

Your own Windows account is never restricted.

## Setup (10 minutes)

1. Download `CoinQuest-Setup-<version>.exe` from the project's GitHub Releases page and run it from an **administrator** account. It installs everything it needs (the .NET runtime, the browser component, the background service) — there is nothing else to install first.
2. The setup wizard asks three things:
   - **Which Windows account is your child's?** Pick it from the list, or let the wizard create one. (It must be a *Standard* account, not an administrator — the wizard will fix that for you.)
   - **Choose a PIN.** Four to six digits. This opens the Parent Console from inside your child's account.
   - **Pick a starting preset.** "School basics" allows Khan Academy, a dictionary, a calculator, and the CoinQuest app. You can change everything later.
3. Done. Log into your child's account once to see what they'll see.

## The five screens

Open **Parent Console** from the Start menu (your account) or press `Ctrl+Shift+P` inside your child's account and enter your PIN.

| Screen | What you do there |
|---|---|
| **Today** | See what your child did, coins earned and spent, and anything waiting on you. |
| **Approvals** | Only for earnings you chose to approve by hand. Khan Academy and Duolingo pay automatically. |
| **Allowed** | The list of apps and websites your child can use. Add from "apps on this computer" or type a website address. |
| **Shop** | The prizes. Each has a name, a coin price, and what it unlocks. Starter prizes are included. |
| **Quests** | Which earning activities are on, how many coins each pays, and daily limits. |

## How coins work

- Each quest says how it's checked: **automatic** (the app verified it), or **needs your OK** (shows up in Approvals).
- Daily limits stop grinding. Defaults are sensible; change them in Quests.
- Coins never expire. The ledger can't be edited from your child's account — not even by a determined 11-year-old.

## Websites and YouTube

Real web browsers (Edge, Chrome, Firefox…) don't run on your child's account at all — they close the moment they open. Websites open inside CoinQuest's own locked browser, which can only reach the sites on the **Allowed** screen.

YouTube is never reachable as a website. Instead, add channels you trust on the **Allowed** screen; your child can watch those channels' recent videos inside CoinQuest, only while YouTube time is running.

## Prizes that unlock things

When your child buys "20 minutes of YouTube", YouTube is allowed in the browser for 20 minutes. A countdown shows in the corner. At zero, YouTube is locked again and any open tab is closed. Same for the arcade.

## The arcade

Pay-per-play, like quarters in a machine: each game has a coin price, and a play lasts until your child leaves the game (with a safety cap you set). Games that take more thinking cost less; you can change any price under **Shop → Arcade**.

**Classic 2000s games** (Fancy Pants, Gravity Guy, Bloons TD, Learn to Fly, Raft Wars, Bloxorz…) come from [Flashpoint Archive](https://flashpointarchive.org), the free preservation project. CoinQuest downloads them by itself and plays them inside CoinQuest (Flash and HTML5 games); nothing to install. Any game whose files can't be played is taken out of the arcade. Flashpoint's adult-tagged games never show up.

## The price sheet (defaults — change any of them)

Rule of thumb: **about 1 coin per minute of real learning.**

| Earn | Coins |
|---|---|
| Letter Rescue lesson | 12 |
| Scripture passage | ~15 (by length) |
| Khan Academy | 1 per correct answer · 3 per finished video · 5 per finished exercise, quiz or unit test |
| Duolingo | 5 per finished lesson or story |

| Spend (per 5 minutes) | Coins |
|---|---|
| Arcade, thinking games (strategy/puzzle) | 4 |
| Arcade, reflex/action games | up to 8 |
| YouTube | 12 (always more than any game) |

So 5 minutes of YouTube costs about 10–12 minutes of learning; 5 minutes of a puzzle game about 4.

You can also add a `.swf` file you own, or a link to a game on its maker's website.

## Updates

CoinQuest updates itself. **Parent Console → Settings** shows the version and a "Check now" button.

## Honest limits

A young child cannot get around this. A technically determined teenager with physical access to the machine could boot from a USB drive or reinstall Windows. If that's a concern: turn on BitLocker and set a BIOS password. Both take five minutes and close every remaining hole.

## Something's wrong?

- **Child's apps won't open:** check Allowed. The app may be blocked by design.
- **Forgot the PIN:** open Parent Console from your own administrator account → Settings → Reset PIN.
- **Everything else:** open an issue at the project's GitHub page with what you expected and what happened.
