import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Activity } from '../../core/types';
import type { ActivityContext, LessonModule } from '../../core/module';
import { invalid } from '../../core/module';
import { bridge } from '../../core/bridge';

/**
 * Classic learning CDs (ClueFinders and other Learning Company titles) — the family's own discs, imported once by a
 * parent. Each runs in its own window; the Guardian pays coins when a player's saved level or score goes up.
 */
export const discGames: LessonModule = {
  id: 'discgames',
  title: 'Classic CD games',
  tagline: 'ClueFinders and other classic learning adventures',
  description: 'Your family\'s own classic learning CDs (like The ClueFinders), imported once from their disc images and kept inside CoinQuest. Coins arrive automatically when a player\'s saved level or score goes up ("coins per activity" each, at most once a minute), up to the daily limit.',
  icon: '💿',
  verification: 'observed',
  defaults: { coinsPerActivity: 5, dailyCap: 60 },
  nextActivity(): Activity { return { moduleId: 'discgames', kind: 'play', data: {}, issuedAt: 0 }; },
  mount(el, activity, ctx) { render(<DiscView activity={activity} ctx={ctx} />, el); return () => render(null, el); },
  score: () => invalid('Classic CD games pay automatically when the game saves progress'),
};

function DiscView({ ctx }: { activity: Activity; ctx: ActivityContext }) {
  const [games, setGames] = useState<{ id: string; title: string }[]>([]);
  const [msg, setMsg] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => { bridge.state().then((s) => setGames(s.discGames ?? [])).catch(() => {}); }, []);
  useEffect(() => bridge.on((ev) => { if (ev.name === 'programClosed') { setPlaying(null); setMsg('Welcome back! Coins for new progress are in your wallet.'); } }), []);
  async function play(g: { id: string; title: string }) {
    setMsg(`Starting ${g.title}…`);
    try { await bridge.playDisc(g.id); setPlaying(g.title); setMsg(''); }
    catch (e) { setMsg((e as Error).message); }
  }
  return (
    <div class="activity-intro">
      <h2>💿 Classic CD games</h2>
      <p>Solve puzzles and finish activities — every time your saved score or level goes up you earn <b>{ctx.settings.coinsPerActivity} 🪙</b>.</p>
      <div class="card nudge" style="text-align:left">
        <b>✍️ Sign in with your own name</b> on the game's first screen (the same name every time) — that's where your progress and coins are kept.
      </div>
      {playing ? <p class="muted">{playing} is open in its own window. Use the game's own Exit/Quit to come back here.</p>
        : <div class="row" style="flex-wrap:wrap;gap:.6em;justify-content:center">{games.map((g) => <button class="primary big" onClick={() => play(g)}>▶ {g.title}</button>)}</div>}
      {games.length === 0 && <p class="muted">No games imported yet — ask a parent.</p>}
      {msg && <p class="muted">{msg}</p>}
      <button class="ghost" onClick={ctx.exit}>Back</button>
    </div>
  );
}
