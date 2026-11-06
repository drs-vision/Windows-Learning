import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Activity } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { invalid } from '../../core/module';
import { bridge } from '../../core/bridge';

/**
 * Read, Write & Type! (The Learning Company, 1995) — the family's own copy, imported once by a parent.
 * It runs as its own window; the Guardian pays coins when the game saves the player's progress.
 */
export const rwt: LessonModule = {
  id: 'rwt',
  title: 'Read, Write & Type!',
  tagline: 'The classic phonics & typing adventure',
  description: 'Your own copy of Read, Write & Type! (1995), imported once from its disc image and kept inside CoinQuest. Coins arrive automatically whenever the game saves progress (at most once every few minutes; "coins per activity" each), up to the daily limit.',
  icon: '⌨️',
  verification: 'observed',
  defaults: { coinsPerActivity: 5, dailyCap: 60 },
  nextActivity(): Activity { return { moduleId: 'rwt', kind: 'play', data: {}, issuedAt: 0 }; },
  mount(el, activity, ctx) { render(<RwtView activity={activity} ctx={ctx} />, el); return () => render(null, el); },
  score: () => invalid('Read, Write & Type! pays automatically when the game saves progress'),
};

function RwtView({ ctx }: { activity: Activity; ctx: ActivityContext }) {
  const [msg, setMsg] = useState('');
  const [playing, setPlaying] = useState(false);
  useEffect(() => bridge.on((ev) => { if (ev.name === 'rwtClosed') { setPlaying(false); setMsg('Welcome back! Coins for saved progress are in your wallet.'); } }), []);
  async function play() {
    setMsg('Starting… (the first time takes a moment)');
    try { await bridge.playRwt(); setPlaying(true); setMsg(''); }
    catch (e) { setMsg((e as Error).message); }
  }
  return (
    <div class="activity-intro">
      <h2>⌨️ Read, Write & Type!</h2>
      <p>Rescue the letters! Every activity you finish earns <b>{ctx.settings.coinsPerActivity} 🪙</b>.</p>
      <div class="card nudge" style="text-align:left">
        <b>✍️ Always sign in first</b> — the game only remembers your progress (and only pays coins) when you're signed in.
        <ol class="small">
          <li>On the <b>Sign-In</b> screen, click your name in the list and press <b>PLAY</b>.</li>
          <li>First time only: type your name and press <b>SIGN-IN NEW PLAYER</b>. Don't make a new player again next time — just pick your name.</li>
          <li>Skipped it? Click the little tag in the top-right corner of the game → <b>SIGN-IN</b>.</li>
        </ol>
      </div>
      {playing ? <p class="muted">The game is open in its own window. To finish, click the corner tag → <b>EXIT</b> → <b>YES</b>.</p>
        : <button class="primary big" onClick={play}>▶ Play</button>}
      {msg && <p class="muted">{msg}</p>}
      <button class="ghost" onClick={ctx.exit}>Back</button>
    </div>
  );
}
