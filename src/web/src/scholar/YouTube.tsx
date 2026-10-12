import { useEffect, useState } from 'preact/hooks';
import type { Unlock, Video } from '../core/types';
import { bridge } from '../core/bridge';
import { fmt } from '../modules/arcade/Arcade';

/**
 * YouTube, but only the channels a parent approved. Videos come from the Guardian (channel feeds), play in a
 * privacy-enhanced embed with related videos limited to the same channel, and stop when YouTube time runs out.
 */
export function YouTube({ unlock, onExit, onShop }: { unlock?: Unlock; onExit: () => void; onShop: () => void }) {
  const [lib, setLib] = useState<{ channels: { id: string; title: string }[]; videos: Video[]; errors: string[] } | null>(null);
  const [channel, setChannel] = useState<string>('all');
  const [playing, setPlaying] = useState<Video | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { bridge.youtubeLibrary().then(setLib).catch((e) => setError(e.message)); }, []);
  useEffect(() => { if (!unlock) setPlaying(null); }, [unlock]);

  async function watch(v: Video) {
    setError('');
    try {
      const r = await bridge.youtubeCheck(v.id);
      if (!r.allowed) { setError(unlock ? "That video isn't from an approved channel." : 'Buy YouTube time in the shop first.'); return; }
      setPlaying(v);
    } catch (e) { setError((e as Error).message); }
  }

  if (playing && unlock) return (
    <div class="player">
      <header>
        <button class="ghost" onClick={() => setPlaying(null)}>← Videos</button>
        <b>{playing.title}</b>
        <span class="countdown">{fmt(unlock.secondsLeft)}</span>
      </header>
      <iframe class="player-host" title={playing.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen
        src={`https://www.youtube-nocookie.com/embed/${playing.id}?autoplay=1&rel=0&modestbranding=1&iv_load_policy=3&playsinline=1`} />
      <footer class="muted small">{playing.channelTitle}</footer>
    </div>
  );

  const shown = (lib?.videos ?? []).filter((v) => channel === 'all' || v.channelId === channel);
  return (
    <div class="arcade">
      <header>
        <h2>▶️ YouTube</h2>
        {unlock ? <span class="countdown">{fmt(unlock.secondsLeft)} left</span> : <button class="primary" onClick={onShop}>Buy YouTube time</button>}
        <button class="ghost" onClick={onExit}>Back</button>
      </header>
      {error && <p class="error">{error}</p>}
      {!lib && !error && <p class="muted">Loading videos…</p>}
      {lib && lib.channels.length === 0 && <p class="muted">No channels yet. A parent can add channels in the Parent Console → Allowed.</p>}
      {lib && lib.channels.length > 1 && (
        <div class="segmented small yt-channels">
          <button class={channel === 'all' ? 'on' : ''} onClick={() => setChannel('all')}>All</button>
          {lib.channels.map((c) => <button class={channel === c.id ? 'on' : ''} onClick={() => setChannel(c.id)}>{c.title}</button>)}
        </div>
      )}
      <div class="video-grid">
        {shown.map((v) => (
          <button class={'video-card' + (unlock ? '' : ' locked')} onClick={() => watch(v)}>
            <img src={v.thumbnail} alt="" loading="lazy" />
            <b>{v.title}</b>
            <small class="muted">{v.channelTitle}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
