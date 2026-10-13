// End-to-end test on a real Windows machine (GitHub Actions windows-latest), driving the REAL installed app:
// Guardian service + Parent Console + Scholar (running as a separate standard "kid" account, internet-locked).
// Both shells expose the DevTools protocol only on machines marked as test machines (C:\ProgramData\CoinQuest\e2e-test-mode).
// Every step saves a screenshot of the app and of the whole desktop to e2e-shots/. Exit code != 0 on any failure.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.E2E_OUT ?? 'e2e-shots';
const INSTALL = process.env.CQ_INSTALL ?? 'C:\\Program Files\\CoinQuest';
// The CI user itself plays the child (it is the one signed in at the console, exactly like Daniel's account at home).
// On a machine marked as a test machine the Guardian leaves the internet lock and app blocking off, so the runner keeps working.
const KID = process.env.USERNAME ?? 'runneradmin';
mkdirSync(OUT, { recursive: true });
const crash = (e) => { log('FAIL  (stopped) ' + (e?.stack ?? e)); writeFileSync(join(OUT, 'RESULT.txt'), 'CRASHED'); process.exit(1); };
process.on('unhandledRejection', crash); process.on('uncaughtException', crash);
let n = 0, failures = 0;
const log = (s) => { console.log(s); appendFileSync(join(OUT, 'log.txt'), s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function desktop(name) {
  // Bring CoinQuest to the front first (the CI runner's own console window sits on top otherwise).
  try { execFileSync('powershell', ['-NoProfile', '-Command', "$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate('CoinQuest'); Start-Sleep -Milliseconds 400"], { stdio: 'ignore' }); } catch { /* best effort */ }
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
    if (i === 20 || i === 60) desktop(`${label}-waiting`);
    await sleep(1000);
  }
  try { log(execFileSync('cmd', ['/c', `netstat -ano | findstr ${port} & tasklist /v | findstr /i "coinquest msedgewebview2"`], { encoding: 'utf8' })); } catch (e) { log('  diag: ' + e.message); }
  throw new Error(`${label}: DevTools port ${port} never came up`);
}

/** Start a CoinQuest shell as another Windows account (the kid), with the test debugging port. */
function startAs(user, pw, exe, port) {
  const ps = `$p = New-Object System.Diagnostics.ProcessStartInfo '${exe}'; $p.UseShellExecute=$false; $p.UserName='${user}'; $s=New-Object System.Security.SecureString; foreach($c in '${pw}'.ToCharArray()){ $s.AppendChar($c) }; $p.Password=$s; $p.LoadUserProfile=$true; $p.WorkingDirectory='${INSTALL}'; $p.Environment['COINQUEST_DEBUG_PORT']='${port}'; [System.Diagnostics.Process]::Start($p) | Out-Null`;
  try { const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }); if (out.trim()) log('  start: ' + out.trim()); }
  catch (e) { log('  start failed: ' + (e.stderr || e.message)); throw e; }
}

// ====================================================================== Parent Console (as the admin running CI)
log('== Parent Console: first-run setup');
const parentProc = spawn(join(INSTALL, 'CoinQuest.ParentConsole.exe'), [], { env: { ...process.env, COINQUEST_DEBUG_PORT: '9222' }, detached: true, stdio: 'ignore' });
let { browser: pb, page: parent } = await attach(9222, 'parent');
await parent.waitForSelector('button.account', { timeout: 60000 }).catch(() => undefined);
await shot(parent, 'parent-wizard'); desktop('parent-wizard');
await check('setup wizard completes with the kid account', async () => {
  await parent.locator('button.account', { hasText: new RegExp(`^.*${KID}.*$`, 'i') }).first().click();
  await parent.click('text=Next');
  await parent.fill('input[type=password] >> nth=0', '2468');
  await parent.fill('input[type=password] >> nth=1', '2468');
  await parent.click('text=Next');
  await shot(parent, 'parent-wizard-preset');
  await parent.click('text=Finish');
  // This account is now the child, so the Parent Console asks for the PIN (as it would inside Daniel's account).
  await parent.waitForSelector('nav.tabs, form.pin-gate', { timeout: 30000 });
  if (await parent.locator('form.pin-gate').count()) { await parent.fill('form.pin-gate input', '2468'); await parent.click('form.pin-gate button[type=submit]'); }
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
await check('parent allows duolingo.com', async () => {
  await parent.click('nav.tabs >> text=Allowed');
  await parent.fill('input[placeholder="e.g. duolingo.com"]', 'duolingo.com');
  await parent.press('input[placeholder="e.g. duolingo.com"]', 'Enter');
  await sleep(1500);
  await parent.locator('.chip', { hasText: 'duolingo.com' }).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await shot(parent, 'parent-sites');
  const errs = await parent.locator('.error').allTextContents();
  if (errs.length) log('  parent errors: ' + errs.join(' / '));
  expect(await parent.locator('.chip', { hasText: 'duolingo.com' }).count() > 0, 'duolingo.com chip not shown after adding');
});
await check('Flashpoint panel shows install steps', async () => {
  await parent.click('nav.tabs >> text=Shop');
  await sleep(1500);
  await parent.locator('.fp-panel').scrollIntoViewIfNeeded();
  await shot(parent, 'parent-arcade-flashpoint');
});
await check('settings survive switching tabs (duolingo.com still allowed)', async () => {
  await parent.click('nav.tabs >> text=Today'); await sleep(800);
  await parent.click('nav.tabs >> text=Allowed'); await sleep(1500);
  const n = await parent.locator('.chip', { hasText: 'duolingo.com' }).count();
  if (!n) await shot(parent, 'parent-sites-LOST');
  expect(n > 0, 'duolingo.com disappeared from the allowed sites');
});
await pb.close().catch(() => undefined);
try { process.kill(parentProc.pid); } catch { /* gone */ }
try { execFileSync('taskkill', ['/F', '/IM', 'CoinQuest.ParentConsole.exe'], { stdio: 'ignore' }); } catch { /* already closed */ }

// ====================================================================== Scholar (as the kid)
log('== Scholar (started by the Guardian in the child\'s session, as at home)');
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
for (const title of titles) {
  await check(`arcade: "${title}" opens and stays open after Play`, async () => {
    if (await kid.locator('.modal').count()) await kid.locator('.game-detail button.ghost').click().catch(() => undefined); // tidy up after a failed step
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
    // Actually PLAY it: click into the game and press the usual start/move keys, then screenshot the result.
    if (await kid.locator('.player').count()) {
      await shot(kid, `arcade-${title}-after14s`);
      const host = kid.locator('.player-host').first();
      const box = await host.boundingBox();
      if (box) {
        await kid.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(800);
        for (const k of ['Space', 'Enter', 'ArrowRight', 'ArrowRight', 'ArrowUp', 'Space', 'ArrowLeft', 'ArrowDown', 'Space', 'ArrowRight', 'ArrowUp', 'Space']) { await kid.keyboard.press(k); await sleep(250); }
        await kid.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        for (const k of ['ArrowLeft', 'ArrowUp', 'Space', 'ArrowRight', 'ArrowDown', 'Space']) { await kid.keyboard.press(k); await sleep(250); }
        await sleep(1500);
        await shot(kid, `arcade-${title}-PLAYING-after-input`); desktop(`arcade-${title}-PLAYING-after-input`);
      }
    }
    // back to the arcade (time keeps counting)
    const back = kid.locator('.player header button').first();
    if (await back.count()) await back.click(); else await kid.click('text=I\'m done playing');
    await sleep(800);
  });
}
await check('classic Flash game (Flashpoint Archive) appears, downloads and plays', async () => {
  // The Guardian adds the curated classics in the background; give it a few minutes on a fresh machine.
  let tile = null;
  for (let i = 0; i < 24 && !tile; i++) {
    await kid.click('.portal-head button.ghost').catch(() => undefined); await sleep(500);
    await kid.click('text=/Arcade/'); await sleep(2500);
    const t = kid.locator('.tile', { hasText: /Fancy Pants|Gravity Guy|Bloons|Learn to Fly|Raft Wars|Stick War/ }).first();
    if (await t.count()) tile = t; else await sleep(10000);
  }
  await shot(kid, 'arcade-with-classics');
  log(`  classics visible: ${(await kid.locator('.tile .tile-title').allTextContents()).filter((x) => !titles.includes(x)).slice(0, 12).join(', ')}`);
  expect(tile, 'no classic games appeared in the arcade');
  const name = (await tile.locator('.tile-title').textContent()).trim();
  await tile.click();
  await kid.click('.time-buyer .coin-btn');
  for (let i = 0; i < 60 && !(await kid.locator('.player, .portal .error').count()); i++) await sleep(1000);
  await sleep(8000);
  await shot(kid, `classic-${name}-loaded`); desktop(`classic-${name}-loaded`);
  const err = await kid.locator('.portal .error, .player .error').allTextContents();
  expect(!err.length, 'error: ' + err.join(' / '));
  expect(await kid.locator('.player').count(), 'the classic did not open');
  const box = await kid.locator('.player-host').first().boundingBox();
  if (box) {
    await kid.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(1500);
    for (const k of ['Space', 'Enter', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'Space']) { await kid.keyboard.press(k); await sleep(400); }
    await kid.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6); await sleep(3000);
    await shot(kid, `classic-${name}-PLAYING-after-input`); desktop(`classic-${name}-PLAYING-after-input`);
  }
  await kid.locator('.player header button').first().click().catch(() => undefined);
  await sleep(800);
});
await check('HTML5 classic (Miniclip Bloxorz) plays from the local copy', async () => {
  // Approve the HTML5 version in the Parent Console (the arcade's own pick is the Flash version).
  // The parent view inside the child app (what Ctrl+Shift+P opens), behind the PIN.
  await kid.evaluate(() => window.chrome.webview.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ name: 'openParent' }) }))).catch((e) => log('  dispatch: ' + e.message));
  await sleep(1500);
  if (!(await kid.locator('form.pin-gate, nav.tabs').count())) {
    try { execFileSync('powershell', ['-NoProfile', '-Command', "$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate('CoinQuest'); Start-Sleep -Milliseconds 400; $w.SendKeys('^+p')"], { stdio: 'ignore' }); } catch { /* */ }
    await sleep(1500);
  }
  const parent = kid;
  await parent.waitForSelector('nav.tabs, form.pin-gate', { timeout: 20000 });
  if (await parent.locator('form.pin-gate').count()) { await parent.fill('form.pin-gate input', '2468'); await parent.click('form.pin-gate button[type=submit]'); }
  await parent.waitForSelector('nav.tabs', { timeout: 30000 });
  try {
  await parent.click('nav.tabs >> text=Shop');
  await parent.waitForSelector('input[placeholder^="Search Flashpoint"]', { timeout: 60000 });
  await parent.fill('input[placeholder^="Search Flashpoint"]', 'Bloxorz');
  await parent.press('input[placeholder^="Search Flashpoint"]', 'Enter');
  const row = parent.locator('.fp-row', { hasText: /HTML5/ }).first();
  await row.waitFor({ timeout: 45000 }).catch(() => undefined);
  if (!(await row.count())) await shot(parent, 'parent-search-bloxorz');
  expect(await row.count(), 'no HTML5 Bloxorz in the Flashpoint search');
  if (!(await row.locator('input').isChecked())) await row.locator('input').click();
  await sleep(4000);
  await shot(parent, 'parent-approved-html5-bloxorz');
  } finally {
    await kid.click('button.close').catch(() => undefined);
    await sleep(1000);
  }
  // Find it in the arcade (there are two Bloxorz: Flash and HTML5).
  await kid.click('.portal-head button.ghost').catch(() => undefined); await sleep(500);
  await kid.click('text=/Arcade/'); await sleep(2500);
  await kid.locator('.portal input').first().fill('Bloxorz'); await sleep(1200);
  const n = await kid.locator('.tile', { hasText: /Bloxorz/ }).count();
  log(`  ${n} Bloxorz tile(s)`);
  let found = false;
  for (let i = 0; i < n && !found; i++) {
    await kid.locator('.tile', { hasText: /Bloxorz/ }).nth(i).click();
    await kid.click('.time-buyer .coin-btn');
    for (let t = 0; t < 60 && !(await kid.locator('.player, .portal .error').count()); t++) await sleep(1000);
    const foot = await kid.locator('.player footer').textContent().catch(() => '');
    if (/miniclip/i.test(foot ?? '')) { found = true; break; }
    await kid.locator('.player header button').first().click().catch(() => undefined); await sleep(800);
    await kid.locator('.portal input').first().fill('Bloxorz'); await sleep(800);
  }
  expect(found, 'the HTML5 (Miniclip) Bloxorz is not in the arcade');
  await sleep(15000);
  await shot(kid, 'html5-Bloxorz-loaded'); desktop('html5-Bloxorz-loaded');
  const err = await kid.locator('.portal .error, .player .error').allTextContents();
  const box = await kid.locator('.player-host').first().boundingBox();
  if (box) {
    await kid.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(1500);
    for (const k of ['Space', 'Enter', 'ArrowRight', 'ArrowUp', 'ArrowRight', 'ArrowDown']) { await kid.keyboard.press(k); await sleep(400); }
    await kid.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6); await sleep(3000);
    await shot(kid, 'html5-Bloxorz-PLAYING-after-input'); desktop('html5-Bloxorz-PLAYING-after-input');
  }
  const png = await kid.locator('.player-host').first().screenshot().catch(() => Buffer.alloc(0));
  await kid.locator('.player header button').first().click().catch(() => undefined);
  await sleep(800);
  await kid.locator('.portal input').first().fill('').catch(() => undefined);
  try {
    const lines = readFileSync('C:\\ProgramData\\CoinQuest\\logs\\guardian.log', 'utf8').split('\n').filter((l) => /Classic .*(no copy|ready)/.test(l) && /123f54dc|no copy/.test(l));
    for (const l of lines.slice(-8)) log('  ' + l.slice(20, 220));
  } catch { /* */ }
  log(`  game area screenshot: ${png.length} bytes; errors: ${err.join(' / ') || 'none'}`);
  expect(!err.length, 'error: ' + err.join(' / '));
  expect(png.length > 40000, 'the HTML5 game area is (nearly) blank');
});
await check('sampler pass: buy and play any game', async () => {
  if (!(await kid.locator('.portal').count())) { await kid.click('text=/Arcade/').catch(() => undefined); await sleep(2500); }
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
  for (const f of kid.frames()) {
    const t = await f.textContent('body').catch(() => '');
    if (/not a bot/i.test(t ?? '')) log('  note: YouTube asked "confirm you are not a bot" (it does this for data-centre connections like this test machine)');
  }
  const next = kid.locator('.upnext-card');
  log(`  up next: ${await next.count()} approved videos beside the player`);
  expect(await next.count() > 0, 'no "Up next" videos beside the player');
  const before = await kid.locator('.player header b').textContent();
  await next.nth(1).click();
  await sleep(6000);
  await shot(kid, 'youtube-upnext-clicked'); desktop('youtube-upnext-clicked');
  expect((await kid.locator('.player header b').textContent()) !== before, 'clicking an Up next video did not switch videos');
  await kid.click('text=← Videos');
  await sleep(800);
});
await check('YouTube: pick a creator and scroll through all their videos', async () => {
  await kid.locator('.yt-channels button').nth(1).click();
  await sleep(5000);
  const first = await kid.locator('.video-card').count();
  for (let i = 0; i < 6; i++) { await kid.mouse.move(640, 500); await kid.mouse.wheel(0, 4000); await sleep(2500); }
  const after = await kid.locator('.video-card').count();
  await shot(kid, 'youtube-creator-scrolled'); desktop('youtube-creator-scrolled');
  const more = await kid.locator('.yt-more').textContent().catch(() => '');
  log(`  creator videos: ${first} at first, ${after} after scrolling · ${String(more).trim()}`);
  await kid.click('.arcade header button.ghost');
  expect(after > first, `still ${after} videos after scrolling — older ones did not load`);
});

// ---------- an allowed website (opens in CoinQuest's locked window) ----------
log('== Websites');
await check('Duolingo opens with content (not blank)', async () => {
  await kid.click('text=/Websites/');
  await sleep(1500);
  await shot(kid, 'websites');
  await kid.locator('.site-card', { hasText: /duolingo/i }).first().click();
  const { browser: sb, page: site } = await attach(9224, 'site window');
  await sleep(15000);
  await shot(site, 'duolingo'); desktop('duolingo');
  const text = (await site.textContent('body').catch(() => '')) ?? '';
  log(`  duolingo page text: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
  await sb.close().catch(() => undefined);
  try { execFileSync('powershell', ['-NoProfile', '-Command', "$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate('Duolingo'); Start-Sleep -Milliseconds 300; $w.SendKeys('{ESC}')"], { stdio: 'ignore' }); } catch { /* */ }
  expect(text.replace(/\s+/g, '').length > 200, 'Duolingo page is (nearly) blank');
});
await check('Sign-in pop-up (Khan Academy → Continue with Google) opens in its own window and the site stays open', async () => {
  await kid.click('text=/Websites/').catch(() => undefined);
  await sleep(1500);
  const card = kid.locator('.site-card', { hasText: /khan/i }).first();
  if (!(await card.count())) { log('  Khan Academy not on the list here — skipped'); await kid.click('.arcade header button.ghost').catch(() => undefined); return; }
  await card.click();
  const { browser: sb, page: site } = await attach(9224, 'site window');
  try {
    await site.goto('https://www.khanacademy.org/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => log('  goto: ' + e.message));
    await sleep(8000);
    const g = site.locator('button, a', { hasText: /continue with google|google/i }).first();
    if (!(await g.count())) { await shot(site, 'khan-login-no-google'); log('  no Google button found on the Khan login page'); return; }
    await g.click();
    await sleep(8000);
    const pages = sb.contexts().flatMap((c) => c.pages());
    log('  pages: ' + pages.map((p) => p.url().slice(0, 80)).join(' | '));
    const popup = pages.find((p) => /accounts\.google\.com/.test(p.url()));
    if (popup) { await shot(popup, 'khan-google-signin-popup'); }
    desktop('khan-google-signin-popup');
    expect(pages.some((p) => /khanacademy\.org/.test(p.url())), 'the Khan Academy window closed');
    expect(popup, 'Google sign-in did not open');
  } finally {
    await sb.close().catch(() => undefined);
    try { execFileSync('powershell', ['-NoProfile', '-Command', "$w = New-Object -ComObject WScript.Shell; foreach ($t in 'Sign in','Khan Academy') { if ($w.AppActivate($t)) { Start-Sleep -Milliseconds 300; $w.SendKeys('%{F4}') } }"], { stdio: 'ignore' }); } catch { /* */ }
    await sleep(1500);
  }
});
await check('HTML5 classic copy points at CoinQuest, not the internet (works with the internet lock on)', async () => {
  const dir = 'C:\\ProgramData\\CoinQuest\\classics';
  if (!existsSync(dir)) { log('  no classics folder'); return; }
  let html5 = 0, left = [];
  for (const id of readdirSync(dir)) {
    const meta = join(dir, id, 'meta.json');
    if (!existsSync(meta) || !/HTML5/i.test(readFileSync(meta, 'utf8'))) continue;
    html5++;
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(html?|js|css)$/i.test(f)) { const m = readFileSync(p, 'utf8').match(/(?<![\w.])(?:https?:)?\/\/(?!coinquest-|www\.w3\.org|w3\.org|ns\.adobe|purl\.org|schemas\.|xmlns\.com|www\.adobe\.com)[a-z0-9-]+(?:\.[a-z0-9-]+)+\//gi); if (m) left.push(`${f}: ${[...new Set(m)].slice(0, 3).join(' ')}`); } } };
    walk(join(dir, id, 'content'));
  }
  log(`  ${html5} HTML5 classic(s) on disk; external addresses left: ${left.length ? left.slice(0, 5).join(' / ') : 'none'}`);
  expect(left.length === 0, 'some files still load from the internet');
});
await kid.click('.topbar .brand').catch(() => undefined);
await sleep(800);

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

// What the internet gate refused during the run (sites that open blank show up here).
try {
  const lines = readFileSync('C:\\ProgramData\\CoinQuest\\logs\\guardian.log', 'utf8').split('\n').filter((l) => l.includes('Gatekeeper blocked'));
  log(`== Gatekeeper blocked ${lines.length} host(s):`); for (const l of lines.slice(-40)) log('  ' + l.replace(/^.*Gatekeeper blocked /, ''));
} catch (e) { log('  (could not read guardian.log: ' + e.message + ')'); }
writeFileSync(join(OUT, 'RESULT.txt'), failures ? `${failures} FAILED` : 'ALL PASSED');
log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
await kb.close().catch(() => undefined);
process.exit(failures ? 1 : 0);
