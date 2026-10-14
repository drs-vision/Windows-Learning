// CoinQuest relay — passes scrambled messages between a family's PC and their phones.
//
// Like the public ntfy relay CoinQuest started on, but CoinQuest's own: no shared rate limits, messages wait up to
// 7 days for a PC that's off, and each PC can leave its latest (scrambled) snapshot for phones to show while it's
// offline. The relay never sees a key: every message was encrypted on the phone or PC (AES-256-GCM) before it got here.
//
//   POST /<topic>                 store + deliver a message (≤ 8 KB of text)   → {id,time,event:"message",topic,message}
//   GET  /<topic>/ws?since=<id|unixtime>   WebSocket: backlog since, then live (hibernates while idle; "ping" → "pong")
//   GET  /<topic>/latest          the newest message (for snapshots), 404 if none
//   GET  /<topic>/json?since=…    the backlog as NDJSON (polling fallback)
//   GET  /v1/health               {"healthy":true}
//
// One Durable Object per topic (topics are random names from the QR link, so a topic is effectively one phone).

const KEEP_SECONDS = 7 * 24 * 3600;
const KEEP_ROWS = 500;
const MAX_BYTES = 8192;
const TOPIC = /^[A-Za-z0-9_-]{8,80}$/;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const [topic] = url.pathname.split('/').filter(Boolean);
    if (topic === 'v1') return json({ healthy: true });
    if (!topic || !TOPIC.test(topic)) return json({ error: 'not found' }, 404);
    return env.TOPIC.get(env.TOPIC.idFromName(topic)).fetch(req);
  },
};

export class Topic {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS m (seq INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, body TEXT NOT NULL)');
    // Keep-alive pings are answered by Cloudflare itself: the object stays asleep (and free) between messages.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  msg(row, topic) { return { id: 'c' + row.seq, time: row.t, event: 'message', topic, message: row.body }; }

  since(param) {
    const now = Math.floor(Date.now() / 1000);
    if (!param) return { seq: Number.MAX_SAFE_INTEGER };
    if (param === 'all') return { t: 0 };
    if (/^c\d+$/.test(param)) return { seq: Number(param.slice(1)) };
    const d = /^(\d+)([smh])$/.exec(param);
    if (d) return { t: now - Number(d[1]) * { s: 1, m: 60, h: 3600 }[d[2]] };
    if (/^\d+$/.test(param)) return { t: Number(param) };
    return { seq: Number.MAX_SAFE_INTEGER };
  }

  backlog(param) {
    const s = this.since(param);
    return s.seq !== undefined
      ? this.sql.exec('SELECT seq, t, body FROM m WHERE seq > ? ORDER BY seq', s.seq).toArray()
      : this.sql.exec('SELECT seq, t, body FROM m WHERE t >= ? ORDER BY seq', s.t).toArray();
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [topic, action = ''] = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST' && !action) {
      const body = await req.text();
      if (!body || body.length > MAX_BYTES) return json({ error: 'message too large' }, 413);
      const now = Math.floor(Date.now() / 1000);
      const row = this.sql.exec('INSERT INTO m (t, body) VALUES (?, ?) RETURNING seq, t, body', now, body).one();
      this.sql.exec('DELETE FROM m WHERE t < ? OR seq <= (SELECT MAX(seq) FROM m) - ?', now - KEEP_SECONDS, KEEP_ROWS);
      const m = this.msg(row, topic);
      const text = JSON.stringify(m);
      for (const ws of this.ctx.getWebSockets()) { try { ws.send(text); } catch { /* gone */ } }
      return json(m);
    }

    if (req.method === 'GET' && action === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected a WebSocket' }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ id: 'open', time: Math.floor(Date.now() / 1000), event: 'open', topic }));
      for (const row of this.backlog(url.searchParams.get('since'))) server.send(JSON.stringify(this.msg(row, topic)));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (req.method === 'GET' && action === 'latest') {
      const row = this.sql.exec('SELECT seq, t, body FROM m ORDER BY seq DESC LIMIT 1').toArray()[0];
      return row ? json(this.msg(row, topic)) : json({ error: 'nothing yet' }, 404);
    }

    if (req.method === 'GET' && action === 'json') {
      const lines = this.backlog(url.searchParams.get('since') ?? 'all').map((r) => JSON.stringify(this.msg(r, topic))).join('\n');
      return new Response(lines ? lines + '\n' : '', { headers: { ...cors, 'Content-Type': 'application/x-ndjson' } });
    }

    return json({ error: 'not found' }, 404);
  }

  webSocketMessage() { /* phones and PCs only listen here; they send with POST */ }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch { /* already closed */ } }
  webSocketError() { }
}
