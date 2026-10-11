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
| **Approvals** | Some earnings need a parent's tap — e.g. "Finished Khan Academy: Fractions — 35 coins?" Approve or deny. |
| **Allowed** | The list of apps and websites your child can use. Add from "apps on this computer" or type a website address. |
| **Shop** | The prizes. Each has a name, a coin price, and what it unlocks. Starter prizes are included. |
| **Quests** | Which earning activities are on, how many coins each pays, and daily limits. |

## How coins work

- Each quest says how it's checked: **automatic** (the app verified it), or **needs your OK** (shows up in Approvals).
- Daily limits stop grinding. Defaults are sensible; change them in Quests.
- Coins never expire. The ledger can't be edited from your child's account — not even by a determined 11-year-old.

## Prizes that unlock things

When your child buys "20 minutes of YouTube", YouTube is allowed in the browser for 20 minutes. A countdown shows in the corner. At zero, YouTube is locked again and any open tab is closed. Same for the arcade.

## The arcade

Classic Flash-era games (run through Ruffle, no internet needed) and open-source browser games. Every bundled game is legally redistributable and listed with its license in the app. To add your own Flash game, drop the `.swf` file into `C:\ProgramData\CoinQuest\arcade\`.

## Updates

CoinQuest updates itself. **Parent Console → Settings** shows the version and a "Check now" button.

## Honest limits

A young child cannot get around this. A technically determined teenager with physical access to the machine could boot from a USB drive or reinstall Windows. If that's a concern: turn on BitLocker and set a BIOS password. Both take five minutes and close every remaining hole.

## Something's wrong?

- **Child's apps won't open:** check Allowed. The app may be blocked by design.
- **Forgot the PIN:** open Parent Console from your own administrator account → Settings → Reset PIN.
- **Everything else:** open an issue at the project's GitHub page with what you expected and what happened.
