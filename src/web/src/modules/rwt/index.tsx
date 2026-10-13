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
      <p>Help Vowel and the letters escape Lefty! Every time the game saves your progress you earn <b>{ctx.settings.coinsPerActivity} 🪙</b>.</p>
      {playing ? <p class="muted">The game is open in its own window. Close it (or press Alt+F4) to come back here.</p>
        : <button class="primary big" onClick={play}>▶ Play</button>}
      {msg && <p class="muted">{msg}</p>}
      <button class="ghost" onClick={ctx.exit}>Back</button>
    </div>
  );
}
