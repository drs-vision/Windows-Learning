import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChildState, Unlock, Video } from '../core/types';
import { TimeStepper } from '../core/TimeStepper';
import { bridge } from '../core/bridge';
import { fmt } from '../modules/arcade/Arcade';

/**
 * YouTube, but only the channels a parent approved. Videos come from the Guardian (channel feeds), play in a
 * privacy-enhanced embed with related videos limited to the same channel, and stop when YouTube time runs out.
 */
export function YouTube({ unlock, onExit, prize, balance, onBought }: {
  unlock?: Unlock; onExit: () => void; prize?: ChildState['prizes'][number]; balance: number; onBought: () => void;
}) {
  const [blocks, setBlocks] = useState(1);
  const [busy, setBusy] = useState(false);
  const price = prize?.blockPrice ?? 0;
  async function buy() {
    if (!prize) return;
    setBusy(true); setError('');
    try { await bridge.buy(prize.id, blocks); setBlocks(1); onBought(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const soldOut = !!prize && prize.dailyCap > 0 && prize.boughtToday >= prize.dailyCap;
  const [lib, setLib] = useState<{ channels: { id: string; title: string }[]; videos: Video[]; errors: string[] } | null>(null);
  const [channel, setChannel] = useState<string>('all');
  const [playing, setPlaying] = useState<Video | null>(null);
  const [error, setError] = useState('');
  // Every video of one creator, page by page.
  const [pages, setPages] = useState<Record<string, { videos: Video[]; next: string | null; loading: boolean; error?: string }>>({});

  const [loading, setLoading] = useState(true);
  const loadLib = () => { setLoading(true); setError(''); bridge.youtubeLibrary().then(setLib).catch((e) => setError(e.message)).finally(() => setLoading(false)); };
  useEffect(() => { loadLib(); }, []);
  useEffect(() => { if (!unlock) setPlaying(null); }, [unlock]);

  function loadMore(id: string) {
    const cur = pages[id];
    if (cur?.loading || (cur && !cur.next)) return;
    setPages((p) => ({ ...p, [id]: { videos: cur?.videos ?? [], next: cur?.next ?? null, loading: true } }));
    bridge.youtubeChannel(id, cur?.next)
      .then((r) => setPages((p) => {
        const have = new Set((p[id]?.videos ?? []).map((v) => v.id));
        return { ...p, [id]: { videos: [...(p[id]?.videos ?? []), ...r.videos.filter((v) => !have.has(v.id))], next: r.next, loading: false } };
      }))
      .catch((e) => setPages((p) => ({ ...p, [id]: { videos: p[id]?.videos ?? [], next: null, loading: false, error: (e as Error).message } })));
  }
  useEffect(() => { if (channel !== 'all' && !pages[channel]) loadMore(channel); }, [channel]);

  // Load the next page when the bottom of the list scrolls into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sentinel.current || channel === 'all') return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(channel); }, { rootMargin: '400px' });
    io.observe(sentinel.current);
    return () => io.disconnect();
  });

  async function watch(v: Video) {
    setError('');
    try {
      const r = await bridge.youtubeCheck(v.id);
      if (!r.allowed) { setError(unlock ? "That video isn't from an approved channel." : 'Press + to add YouTube time first.'); return; }
      setPlaying(v);
    } catch (e) { setError((e as Error).message); }
  }

  if (playing && unlock) {
    // "Up next": more from the same creator first, then the other approved creators. Only approved videos ever show.
    const same = [...(pages[playing.channelId]?.videos ?? []), ...(lib?.videos ?? []).filter((v) => v.channelId === playing.channelId)];
    const others = (lib?.videos ?? []).filter((v) => v.channelId !== playing.channelId);
    const seen = new Set([playing.id]);
    const upNext = [...same, ...others].filter((v) => !seen.has(v.id) && (seen.add(v.id), true)).slice(0, 30);
    return (
      <div class="player yt-watch">
        <header>
          <button class="ghost" onClick={() => setPlaying(null)}>← Videos</button>
          <b>{playing.title}</b>
          <span class="countdown">{fmt(unlock.secondsLeft)}</span>
        </header>
        <div class="yt-watch-body">
          <div class="yt-main">
            <iframe key={playing.id} class="player-host" title={playing.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen
              src={`https://www.youtube-nocookie.com/embed/${playing.id}?autoplay=1&rel=0&modestbranding=1&iv_load_policy=3&playsinline=1`} />
            <footer class="muted small">{playing.channelTitle}</footer>
            {error && <p class="error">{error}</p>}
          </div>
          <aside class="yt-upnext">
            <h4>Up next</h4>
            {upNext.map((v) => (
              <button class="upnext-card" onClick={() => watch(v)}>
                <img src={v.thumbnail} alt="" loading="lazy" />
                <span><b>{v.title}</b><small class="muted">{v.channelTitle}</small></span>
              </button>
            ))}
            {pages[playing.channelId]?.next && <button class="ghost small" onClick={() => loadMore(playing.channelId)}>More from {playing.channelTitle}</button>}
          </aside>
        </div>
      </div>
    );
  }

  const page = channel === 'all' ? null : pages[channel];
  const shown = channel === 'all' ? (lib?.videos ?? [])
    : (page?.videos.length ? page.videos : (lib?.videos ?? []).filter((v) => v.channelId === channel));
  return (
    <div class="arcade">
      <header>
        <h2>▶️ YouTube</h2>
        {unlock && <span class="countdown">{fmt(unlock.secondsLeft)} left</span>}
        <button class="ghost" onClick={onExit}>Back</button>
      </header>
      {prize && price > 0 && (
        <div class="yt-buy">
          <span class="muted small">🪙 {price} for every 5 minutes{soldOut ? ' · that’s enough YouTube for today' : ''}</span>
          {!soldOut && <>
            <TimeStepper price={price} blocks={blocks} setBlocks={setBlocks} balance={balance} more={!!unlock} />
            <button class="coin-btn small" disabled={busy || balance < price * blocks} onClick={buy}>
              {balance < price * blocks ? `Need ${price * blocks - balance} more coins` : unlock ? <>ADD TIME <b>🪙 {price * blocks}</b></> : <>▶ WATCH <b>🪙 {price * blocks}</b></>}
            </button>
          </>}
        </div>
      )}
      {loading && <p class="muted">Loading videos…</p>}
      {!loading && lib && (lib.errors?.length ?? 0) > 0 && (
        <p class="error">Couldn't get videos from {lib.errors.join(', ')} right now. <button class="ghost small" onClick={loadLib}>Try again</button></p>
      )}
      {!loading && lib && lib.channels.length > 0 && lib.videos.length === 0 && (lib.errors?.length ?? 0) === 0 && <p class="muted">No videos found yet. <button class="ghost small" onClick={loadLib}>Try again</button></p>}
      {error && <p class="error">{error} <button class="ghost small" onClick={loadLib}>Try again</button></p>}
      {lib && lib.channels.length === 0 && <p class="muted">No channels yet. A parent can add channels in the Parent Console → Allowed.</p>}
      {lib && lib.channels.length > 0 && (
        <div class="segmented small yt-channels">
          <button class={channel === 'all' ? 'on' : ''} onClick={() => setChannel('all')}>⭐ Newest from all</button>
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
      {page && <div ref={sentinel} class="yt-more">
        {page.loading ? <p class="muted">Loading more videos…</p> : page.next ? <button class="ghost" onClick={() => loadMore(channel)}>More videos</button> : page.error ? <p class="error">{page.error}</p> : <p class="muted small">That's every video from this creator.</p>}
      </div>}
    </div>
  );
}
