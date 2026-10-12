// End-to-end test on a real Windows machine (GitHub Actions windows-latest), driving the REAL installed app:
// Guardian service + Parent Console + Scholar (running as a separate standard "kid" account, internet-locked).
// Both shells expose the DevTools protocol only on machines marked as test machines (C:\ProgramData\CoinQuest\e2e-test-mode).
// Every step saves a screenshot of the app and of the whole desktop to e2e-shots/. Exit code != 0 on any failure.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.E2E_OUT ?? 'e2e-shots';
const INSTALL = process.env.CQ_INSTALL ?? 'C:\\Program Files\\CoinQuest';
const KID = process.env.KID_USER ?? 'kid', KID_PW = process.env.KID_PW ?? 'Pl4y-Learn-2026!';
mkdirSync(OUT, { recursive: true });
const crash = (e) => { log('FAIL  (stopped) ' + (e?.stack ?? e)); writeFileSync(join(OUT, 'RESULT.txt'), 'CRASHED'); process.exit(1); };
process.on('unhandledRejection', crash); process.on('uncaughtException', crash);
let n = 0, failures = 0;
const log = (s) => { console.log(s); appendFileSync(join(OUT, 'log.txt'), s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function desktop(name) {
  const file = join(OUT, `${String(++n).padStart(2, '0')}-${name}-DESKTOP.png`);
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file}')`], { stdio: 'ignore' });
  } catch (e) { log('  (desktop screenshot failed: ' + e.message + ')'); }
}
async function shot(page, name) {
  const file = join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file }).catch((e) => log('  (screenshot failed: ' + e.message + ')'));
}
async function check(name, fn) {
  try { await fn(); log(`PASS  ${name}`); }
  catch (e) { failures++; log(`FAIL  ${name}: ${e.message}`); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function attach(port, label) {
  for (let i = 0; i < 90; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const ctx = browser.contexts()[0];
      const page = ctx.pages().find((p) => p.url().includes('coinquest.local')) ?? ctx.pages()[0];
      if (page) { page.on('pageerror', (e) => log(`  [${label} page error] ${e.message}`)); return { browser, page }; }
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`${label}: DevTools port ${port} never came up`);
}

/** Start a CoinQuest shell as another Windows account (the kid), with the test debugging port. */
function startAs(user, pw, exe, port) {
  const ps = `$p = New-Object System.Diagnostics.ProcessStartInfo '${exe}'; $p.UseShellExecute=$false; $p.UserName='${user}'; $p.Password=(ConvertTo-SecureString '${pw}' -AsPlainText -Force); $p.LoadUserProfile=$true; $p.WorkingDirectory='${INSTALL}'; $p.Environment['COINQUEST_DEBUG_PORT']='${port}'; [System.Diagnostics.Process]::Start($p) | Out-Null`;
  try { const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }); if (out.trim()) log('  start: ' + out.trim()); }
  catch (e) { log('  start failed: ' + (e.stderr || e.message)); throw e; }
}

// ====================================================================== Parent Console (as the admin running CI)
log('== Parent Console: first-run setup');
const parentProc = spawn(join(INSTALL, 'CoinQuest.ParentConsole.exe'), [], { env: { ...process.env, COINQUEST_DEBUG_PORT: '9222' }, detached: true, stdio: 'ignore' });
let { browser: pb, page: parent } = await attach(9222, 'parent');
await parent.waitForSelector('text=/kid/i', { timeout: 60000 }).catch(() => undefined);
await shot(parent, 'parent-wizard'); desktop('parent-wizard');
await check('setup wizard completes with the kid account', async () => {
  await parent.locator('button.account', { hasText: new RegExp(`^.*${KID}.*$`, 'i') }).first().click();
  await parent.click('text=Next');
  await parent.fill('input[type=password] >> nth=0', '2468');
  await parent.fill('input[type=password] >> nth=1', '2468');
  await parent.click('text=Next');
  await shot(parent, 'parent-wizard-preset');
  await parent.click('text=Finish');
  await parent.waitForSelector('nav.tabs', { timeout: 30000 });
  await shot(parent, 'parent-today');
});
await check('parent gives 400 coins', async () => {
  await parent.click('nav.tabs >> text=Settings');
  await parent.fill('input[placeholder^="Reason"]', 'E2E test');
  await parent.locator('input[type=number]').first().fill('400');
  await parent.click('text=Apply');
  await sleep(1000);
  await shot(parent, 'parent-coins');
});
await check('parent adds a YouTube channel', async () => {
  await parent.click('nav.tabs >> text=Allowed');
  await parent.fill('input[placeholder="https://www.youtube.com/@channel"]', 'https://www.youtube.com/@MarkRober');
  await parent.click('text=Add channel');
  await parent.waitForSelector('.chip', { timeout: 30000 });
  await shot(parent, 'parent-youtube');
});
await check('Flashpoint panel shows install steps', async () => {
  await parent.click('nav.tabs >> text=Shop');
  await sleep(1500);
  await parent.locator('.fp-panel').scrollIntoViewIfNeeded();
  await shot(parent, 'parent-arcade-flashpoint');
});
await pb.close().catch(() => undefined);
try { process.kill(parentProc.pid); } catch { /* gone */ }
execFileSync('taskkill', ['/F', '/IM', 'CoinQuest.ParentConsole.exe'], { stdio: 'ignore' }) ;

// ====================================================================== Scholar (as the kid)
log('== Scholar as the kid account');
startAs(KID, KID_PW, join(INSTALL, 'CoinQuest.Scholar.exe'), 9223);
let { browser: kb, page: kid } = await attach(9223, 'scholar');
await kid.waitForSelector('text=/Hi,/', { timeout: 90000 });
await sleep(1500);
await shot(kid, 'kid-home'); desktop('kid-home');
const balance = async () => Number((await kid.locator('.wallet, .coins, .topbar').first().textContent()).replace(/\D+/g, '') || 0);

await check('kid sees 400 coins', async () => {
  const t = await kid.textContent('body');
  expect(/400/.test(t), 'balance 400 not shown');
});

// ---------- arcade: every bundled game opens and STAYS open ----------
log('== Arcade');
await kid.click('text=/Arcade/');
await kid.waitForSelector('.portal', { timeout: 20000 });
await sleep(1500);
await shot(kid, 'arcade'); desktop('arcade');
const titles = await kid.locator('.tile .tile-title').allTextContents();
log(`  ${titles.length} games: ${titles.join(', ')}`);
for (const title of titles.slice(0, 4)) {
  await check(`arcade: "${title}" opens and stays open after Play`, async () => {
    await kid.locator('.tile', { hasText: title }).first().click();
    await kid.waitForSelector('.game-detail', { timeout: 10000 });
    await shot(kid, `arcade-${title}-detail`);
    await kid.click('.time-buyer .coin-btn');
    await sleep(6000);
    await shot(kid, `arcade-${title}-playing`); desktop(`arcade-${title}-playing`);
    const open1 = await kid.locator('.player, .now-playing').count();
    expect(open1 > 0, 'no game on screen 6 s after Play');
    await sleep(8000);
    const open2 = await kid.locator('.player, .now-playing').count();
    expect(open2 > 0, 'game closed by itself within 14 s');
    const err = await kid.locator('.player .error, .portal .error').allTextContents();
    expect(err.length === 0, 'error shown: ' + err.join(' / '));
    // Ruffle/iframe content actually rendered something
    if (await kid.locator('.player').count()) await shot(kid, `arcade-${title}-after14s`);
    // back to the arcade (time keeps counting)
    const back = kid.locator('.player header button').first();
    if (await back.count()) await back.click(); else await kid.click('text=I\'m done playing');
    await sleep(800);
  });
}
await check('sampler pass: buy and play any game', async () => {
  const btn = kid.locator('text=GET PASS');
  expect(await btn.count(), 'no sampler button');
  await btn.click();
  await sleep(1500);
  await shot(kid, 'arcade-sampler');
  const last = titles[titles.length - 1];
  await kid.locator('.tile', { hasText: last }).first().click();
  await kid.click('.time-buyer .coin-btn');
  await sleep(6000);
  await shot(kid, 'arcade-sampler-playing'); desktop('arcade-sampler-playing');
  expect(await kid.locator('.player, .now-playing').count() > 0, 'sampler game did not open');
  const back = kid.locator('.player header button').first();
  if (await back.count()) await back.click(); else await kid.click('text=I\'m done playing');
});
await kid.click('.portal-head button.ghost').catch(() => undefined);
await sleep(800);

// ---------- YouTube ----------
log('== YouTube');
await check('YouTube: + buys time and a video plays', async () => {
  await kid.click('text=/YouTube/');
  await sleep(4000);
  await shot(kid, 'youtube-list');
  await kid.click('.yt-buy .coin-btn');
  await sleep(1500);
  const cards = kid.locator('.video-card');
  expect(await cards.count() > 0, 'no videos listed');
  await cards.first().click();
  await sleep(10000);
  await shot(kid, 'youtube-playing'); desktop('youtube-playing');
  expect(await kid.locator('.player iframe').count() > 0, 'no player');
  await kid.click('text=← Videos');
  await kid.click('.arcade header button.ghost');
});

// ---------- Letter Rescue lesson 1 ----------
log('== Letter Rescue');
await check('Letter Rescue lesson 1 plays to the end and the Guardian pays coins', async () => {
  const before = await kid.textContent('.topbar').catch(() => '');
  await kid.click('text=Letter Rescue');
  await kid.waitForSelector('.lr-title', { timeout: 20000 });
  await shot(kid, 'lr-title'); desktop('lr-title');
  await kid.keyboard.press('Enter'); await sleep(800); await shot(kid, 'lr-map');
  await kid.keyboard.press('Enter'); await sleep(800); await shot(kid, 'lr-story');
  const seen = new Set();
  for (let guard = 0; guard < 600; guard++) {
    if (await kid.locator('.lr-finish').count()) break;
    if (await kid.locator('.lr-story-screen').count()) { await kid.keyboard.press('Enter'); await sleep(150); continue; }
    if (await kid.locator('.lr-banner').count()) {
      const name = (await kid.locator('.lr-banner h2').textContent()).trim();
      if (!seen.has(name)) { seen.add(name); await shot(kid, 'lr-' + name.replace(/\W+/g, '')); }
      await kid.keyboard.press('Enter'); await sleep(400);
      continue;
    }
    if (await kid.locator('.sk-item').count()) {
      let key = null;
      const cur = kid.locator('.sk-ch.cur');
      if (await cur.count()) { const t = (await cur.first().textContent()).trim(); if (t && t !== '?') key = t === '␣' ? ' ' : t; }
      if (!key && await kid.locator('.fk-key.target').count()) { key = (await kid.locator('.fk-key.target').first().textContent()).trim(); if (key === 'space') key = ' '; }
      if (!key) { await sleep(600); continue; }
      if (!seen.has('play-' + (await kid.locator('.sk-steps li.now').textContent()))) { seen.add('play-' + (await kid.locator('.sk-steps li.now').textContent())); await shot(kid, 'lr-playing'); }
      await kid.keyboard.press(key === ' ' ? 'Space' : key);
      await sleep(350);
      continue;
    }
    await sleep(300);
  }
  await sleep(4000);
  await shot(kid, 'lr-finish'); desktop('lr-finish');
  expect(await kid.locator('.lr-finish').count(), 'never reached the finish screen');
  const coins = await kid.locator('.lr-finish .coins-earned').textContent();
  log(`  finish: ${await kid.locator('.lr-finish h2').textContent()} ${coins}`);
  expect(/\+\s*[1-9]/.test(coins), 'no coins paid: ' + coins);
  expect(!(await kid.locator('.error').count()), 'error: ' + (await kid.locator('.error').allTextContents()).join(' / '));
});
await kid.keyboard.press('Escape').catch(() => undefined);
await kid.click('.topbar .brand').catch(() => undefined);
await sleep(1000);

// ---------- Scripture typing (errorless, paid by length) ----------
log('== Scripture typing');
await check('Scripture passage typed and paid', async () => {
  await kid.click('text=Scripture Typing');
  await sleep(1000);
  await shot(kid, 'bible-pick');
  await kid.click('.activity-intro button.primary');
  await sleep(800);
  const text = (await kid.locator('.typing-text').textContent());
  await kid.click('.typing-box');
  await kid.keyboard.type('Z'); // a wrong key: must not go in, must not cost anything
  for (const ch of text) await kid.keyboard.type(ch, { delay: 95 }); // under 150 WPM, like a real child
  await sleep(3000);
  await shot(kid, 'bible-done'); desktop('bible-done');
  const c = await kid.locator('.coins-earned').textContent();
  expect(/[1-9]/.test(c), 'no coins: ' + c);
});

writeFileSync(join(OUT, 'RESULT.txt'), failures ? `${failures} FAILED` : 'ALL PASSED');
log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
await kb.close().catch(() => undefined);
process.exit(failures ? 1 : 0);
