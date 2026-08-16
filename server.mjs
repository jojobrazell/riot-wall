// R!OT WALL server. Node stdlib only, no npm install, no build step.
//
// THE MODEL: a phone is a spray can. Fingers on the phone stream straight onto
// one shared wall, so several people paint the same surface at the same time.
// The machine driving the screen IS the server, so phones reach it over venue
// wifi (or its own hotspot) and the installation needs NO INTERNET.
//
// THE WALL IS AN EVENT LOG, not a flat image. Every dab is kept, which buys
// three things for free: a reload rebuilds the wall exactly, moderation can
// erase one person by re-rendering without them, and the end of the night has a
// timelapse of the whole wall being painted.
//
//   node server.mjs [port]

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
/* PORT from the environment first: every host (cPanel Node app, Render, Railway,
   Fly) assigns one and ignores whatever you hardcoded. The CLI argument stays
   for local runs. */
const PORT = Number(process.env.PORT || process.argv[2] || 8300);
/* Dev-only surfaces stay OFF unless asked for. /__save writes files to disk from
   an unauthenticated POST, which is fine on a laptop and an abuse vector on a
   public host. */
const DEV = process.env.RIOT_DEV === '1';
const DATA = join(ROOT, 'data');
const STATE_FILE = join(DATA, 'wall.json');
const CALIB_FILE = join(DATA, 'calib.json');
const ADMIN_KEY = process.env.RIOT_ADMIN_KEY || 'riot2026';

/* ---------- lead backup to Firestore ----------
   data/ is EPHEMERAL on a PaaS free tier: a redeploy or a spin-down wipes the
   disk, and the emails are the deliverable of the night. So every join is also
   fired at Firestore, write-only, fire-and-forget: a Firestore failure logs and
   never blocks the can. Anonymous auth, same flow the project board uses.
   FIREBASE_API_KEY is env-only ON PURPOSE: this repo is public and a Google
   key committed here would be flagged by secret scanning and could get the
   board's key restricted. No key set = no backup, said out loud at boot. */
const FB = {
  project: process.env.FIREBASE_PROJECT_ID || 'mixr-project-board',
  apiKey: process.env.FIREBASE_API_KEY || '',
  collection: process.env.FIREBASE_COLLECTION || 'riot-wall-leads',
  token: '', tokenAt: 0,
};
if (!FB.apiKey) console.log('lead backup to Firestore is OFF: set FIREBASE_API_KEY to enable');
async function fbToken() {
  if (FB.token && Date.now() - FB.tokenAt < 50 * 60 * 1000) return FB.token;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB.apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }) });
  if (!r.ok) throw new Error('firebase auth ' + r.status);
  const j = await r.json();
  FB.token = j.idToken; FB.tokenAt = Date.now();
  return FB.token;
}
function pushLead(p) {
  if (!FB.project || !FB.apiKey) return;
  (async () => {
    const token = await fbToken();
    const r = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FB.project}/databases/(default)/documents/${encodeURIComponent(FB.collection)}`,
      { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ fields: {
          handle: { stringValue: p.handle },
          email:  { stringValue: p.email },
          event:  { stringValue: 'slowsie-2026-08-15' },
          joined: { timestampValue: new Date(p.ts).toISOString() },
        } }) });
    if (!r.ok) throw new Error('firestore write ' + r.status);
  })().catch(e => console.warn('lead backup failed:', e.message));
}

// A long night of heavy spraying is a lot of dabs. Cap it so memory cannot run
// away, and say so out loud rather than silently dropping the oldest art.
const MAX_EVENTS = 260000;

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp',
  '.woff2':'font/woff2', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8',
};

/* ---------- state ---------- */
let events = [];              // every dab, in order
let painters = new Map();     // id -> { id, handle, email, ts, dabs }
let nextId = 1;
let surface = 'brick';
const clients = new Set();
let dropped = 0;

if (existsSync(STATE_FILE)) {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    events = s.events || [];
    surface = s.surface || 'brick';
    nextId = s.nextId || 1;
    for (const p of (s.painters || [])) painters.set(p.id, p);
    console.log(`restored ${events.length} dabs from ${painters.size} painters`);
  } catch { console.log('wall.json unreadable, starting clean'); }
}

/* ---------- panel calibration ----------
   Where each printed panel physically sits relative to the screen, in millimetres,
   measured with a tape at load-in. The phones need it to turn a panel pose into a
   point on the wall, so it is served publicly; only staff can change it.
   Kept in its own file: the wall gets wiped between sessions, the tape measurements
   do not. */
const DEFAULT_CALIB = {
  measured: false,
  wall: { widthMm: 1440, heightMm: 810 },
  panels: {
    panel1: { offXMm: -990, offYMm:  330, heightMm: 594, on: true },
    panel2: { offXMm: -990, offYMm: -330, heightMm: 594, on: true },
    panel3: { offXMm:  990, offYMm:  330, heightMm: 594, on: true },
    panel4: { offXMm:  990, offYMm: -330, heightMm: 594, on: true },
  },
};
let calib = DEFAULT_CALIB;
if (existsSync(CALIB_FILE)) {
  try { calib = JSON.parse(readFileSync(CALIB_FILE, 'utf8')); console.log('loaded panel calibration'); }
  catch { console.log('calib.json unreadable, using defaults'); }
}

/* ---------- SCREEN PANELS ----------
   The tracking panels can live ON the venue screen, in side gutters the paint
   never reaches. Nothing to print, and because the wall page draws them at
   positions defined HERE, the calibration is exact by construction: no tape
   measure, no load-in step. This is the default until real printed panels go up
   (staff toggle in /admin), at which point the measured calib takes over.

   All fractions are of the SCREEN; the wall page and the calib below both read
   this object, so they can never disagree. The paint area is the WHOLE screen:
   posters are pasted-up paper drawn ABOVE the paint layer, so spraying "over"
   one slides the paint under the paper and the tracker's image stays clean.

   The one honest gap: the phone converts pose to metres via the panel's REAL
   printed height, and an on-screen panel's physical height depends on the
   screen. screenHmm defaults to a 65in TV; staff can set the real screen height
   in /admin and the metres readout becomes true. Aim is exact either way, only
   the distance number scales. */
const SCREEN_LAYOUT = {
  panelW: 0.082,          // poster width, fraction of screen width
  /* EIGHT posters since 2026-08-15 evening (JoJo: "way more posters"), spread
     so a phone aimed ANYWHERE has an anchor near frame. The two OUTER posters
     share a height on purpose: the fallback aimer reads the leftmost and
     rightmost bright bands as a ruler and needs their vertical extents to
     overlap. Middles stagger high/low like a real paste-up run. */
  /* TEN since JoJo's second density pass (2026-08-15 late: "sprays still fall
     off when moving"): a sweep across the middle now always has a poster inside
     the motion-blurred frame. Ten is the tracking engine's safe ceiling. */
  panels: [
    { name: 'panel1',  fx: 0.050, fy: 0.50 },
    { name: 'panel2',  fx: 0.150, fy: 0.26 },
    { name: 'panel3',  fx: 0.250, fy: 0.72 },
    { name: 'panel4',  fx: 0.350, fy: 0.28 },
    { name: 'panel5',  fx: 0.450, fy: 0.70 },
    { name: 'panel6',  fx: 0.550, fy: 0.25 },
    { name: 'panel7',  fx: 0.650, fy: 0.73 },
    { name: 'panel8',  fx: 0.750, fy: 0.27 },
    { name: 'panel9',  fx: 0.850, fy: 0.71 },
    { name: 'panel10', fx: 0.950, fy: 0.50 },
  ],
};
let screenPanels = true;
let screenHmm = 810;      // physical screen height; 810mm is a 65in 16:9

function screenCalib() {
  // Everything in "screen units" where the screen is 16:9 at screenHmm tall.
  const H = screenHmm, W = H * 16 / 9;
  const panelW = SCREEN_LAYOUT.panelW * W, panelH = panelW * 4 / 3;  // 3:4 portrait
  const panels = {};
  for (const p of SCREEN_LAYOUT.panels) {
    panels[p.name] = {
      offXMm: (p.fx - 0.5) * W,
      offYMm: (0.5 - p.fy) * H,
      heightMm: panelH, on: true,
    };
  }
  /* The fallback aimer's ruler: the outer posters' inner edges and their shared
     vertical extent, as wall fractions. Without this the band aimer would map
     the span BETWEEN the outer posters to 0..1 when the paint now runs the full
     wall, and every fallback stroke would land squeezed toward the centre. */
  const first = SCREEN_LAYOUT.panels[0], last = SCREEN_LAYOUT.panels[SCREEN_LAYOUT.panels.length - 1];
  const phFrac = (panelH / H);
  const ruler = {
    uL: first.fx + SCREEN_LAYOUT.panelW / 2,
    uR: last.fx - SCREEN_LAYOUT.panelW / 2,
    vT: first.fy - phFrac / 2,
    vB: first.fy + phFrac / 2,
  };
  return { measured: true, source: 'screen',
           wall: { widthMm: W, heightMm: H }, panels, ruler };
}
const activeCalib = () => (screenPanels ? screenCalib() : calib);

const num = (v, lo, hi, dflt) => {
  const n = +v;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

/* Sanitise rather than trust: this arrives from a phone browser at load-in and a
   zero screen height would divide the whole aim math by nothing. */
function cleanCalib(raw) {
  const d = DEFAULT_CALIB;
  const out = {
    measured: !!(raw && raw.measured),
    wall: {
      widthMm:  num(raw?.wall?.widthMm,  100, 20000, d.wall.widthMm),
      heightMm: num(raw?.wall?.heightMm, 100, 20000, d.wall.heightMm),
    },
    panels: {},
  };
  for (const name of Object.keys(d.panels)) {
    const p = (raw && raw.panels && raw.panels[name]) || d.panels[name];
    out.panels[name] = {
      offXMm:   num(p.offXMm,  -50000, 50000, d.panels[name].offXMm),
      offYMm:   num(p.offYMm,  -50000, 50000, d.panels[name].offYMm),
      heightMm: num(p.heightMm,     20, 10000, d.panels[name].heightMm),
      on: p.on !== false,
    };
  }
  return out;
}

async function persistCalib() {
  await mkdir(DATA, { recursive: true });
  await writeFile(CALIB_FILE, JSON.stringify(calib, null, 2));
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(DATA, { recursive: true });
      await writeFile(STATE_FILE, JSON.stringify({
        nextId, surface, events, painters: [...painters.values()],
      }));
    } catch (e) { console.error('persist failed', e.message); }
  }, 3000);
}

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch {} }
}

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(networkInterfaces()))
    for (const ni of list || [])
      if (ni.family === 'IPv4' && !ni.internal) out.push(`http://${ni.address}:${port}`);
  return out;
}

function readBody(req, limit = 400_000) {
  return new Promise((res, rej) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length;
      if (n > limit) { rej(new Error('too large')); req.destroy(); return; }
      chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

const c01 = v => Math.max(0, Math.min(1, +v || 0));
const clean = (s, max) => String(s == null ? '' : s).replace(/[ -]/g, '').trim().slice(0, max);
const HEX = /^#[0-9a-fA-F]{6}$/;
const NOZ = new Set(['solid','fat','splatter','wet','streak']);

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body, extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const json = (code, o) => send(code, 'application/json; charset=utf-8', JSON.stringify(o));

  try {
    /* --- SSE feed --- */
    if (u.pathname === '/api/stream') {
      /* X-Accel-Buffering is what stops a reverse proxy (nginx, and every
         PaaS router built on it) from BUFFERING this stream. Without it the
         wall looks connected and simply never updates, which is the single
         most common way a working SSE app dies the moment it goes behind a
         host instead of running on a laptop. */
      res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8',
        'Cache-Control':'no-store', 'Connection':'keep-alive',
        'X-Accel-Buffering':'no' });
      res.write('retry: 1500\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    /* --- claim a can. This is the lead capture, and it gates spraying. --- */
    if (req.method === 'POST' && u.pathname === '/api/join') {
      const raw = JSON.parse(await readBody(req, 8000));
      const handle = clean(raw.handle, 18).toUpperCase() || 'ANON';
      const email = clean(raw.email, 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(400, { error: 'bad email' });
      const p = { id: nextId++, handle, email, ts: Date.now(), dabs: 0 };
      painters.set(p.id, p);
      persist();
      pushLead(p);
      broadcast('painter', { id: p.id, handle: p.handle });
      console.log(`can #${p.id} claimed by ${handle}`);
      // calib rides along, so a fresh can never has to make a second request
      // before it can work out where it is pointing.
      return json(200, { id: p.id, handle: p.handle, surface, calib: activeCalib() });
    }

    /* --- a batch of dabs from one phone --- */
    if (req.method === 'POST' && u.pathname === '/api/spray') {
      const raw = JSON.parse(await readBody(req));
      const p = painters.get(raw.u | 0);
      if (!p) return json(403, { error: 'no can' });
      const color = HEX.test(raw.c) ? raw.c : '#a855f7';
      const nozzle = NOZ.has(raw.n) ? raw.n : 'solid';
      const tool = raw.t === 'eraser' ? 'eraser' : 'brush';
      const size = Math.max(0.4, Math.min(4, +raw.s || 1));   // matches RANGE_M's wider throw
      const spread = Math.max(0.5, Math.min(2, +raw.sp || 1));
      const pts = Array.isArray(raw.p) ? raw.p.slice(0, 120) : [];
      if (!pts.length) return json(200, { ok: true });

      const batch = { u: p.id, c: color, n: nozzle, t: tool, s: size, sp: spread,
                      b: !!raw.b, p: pts.map(q => [c01(q[0]), c01(q[1])]) };
      events.push(batch);
      p.dabs += batch.p.length;
      if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
        dropped++;
        if (dropped === 1) console.warn('event cap hit, oldest dabs are being dropped');
      }
      persist();
      broadcast('spray', batch);
      return json(200, { ok: true });
    }

    /* --- backfill: the wall rebuilds itself exactly from this --- */
    if (u.pathname === '/api/state') {
      return json(200, { surface, events,
        painters: [...painters.values()].map(({ email, ...p }) => p) });
    }

    /* --- moderation. Removing a person re-renders the wall without them. --- */
    if (req.method === 'POST' && u.pathname === '/api/nuke') {
      const raw = JSON.parse(await readBody(req, 8000));
      if (raw.key !== ADMIN_KEY) return json(403, { error: 'nope' });
      const id = raw.u | 0;
      const before = events.length;
      events = events.filter(e => e.u !== id);
      const p = painters.get(id);
      if (p) p.nuked = true;
      persist();
      broadcast('rebuild', {});
      console.log(`nuked painter #${id}, removed ${before - events.length} batches`);
      return json(200, { removed: before - events.length });
    }

    /* --- panel calibration. Public to read (every can needs it), staff to write. --- */
    if (u.pathname === '/api/calib' && req.method !== 'POST') return json(200, activeCalib());

    if (req.method === 'POST' && u.pathname === '/api/calib') {
      const raw = JSON.parse(await readBody(req, 20000));
      if (raw.key !== ADMIN_KEY) return json(403, { error: 'nope' });
      calib = cleanCalib(raw.calib);
      await persistCalib();
      broadcast('calib', activeCalib());
      console.log(`panel calibration updated (measured: ${calib.measured})`);
      return json(200, activeCalib());
    }

    /* --- is this staff key good? So the staff page can show LOCKED/UNLOCKED up
           front instead of every action silently 403ing. --- */
    if (u.pathname === '/api/auth')
      return json(200, { ok: u.searchParams.get('key') === ADMIN_KEY });

    /* --- the wall page reads this to draw the gutters; the phones never do --- */
    if (u.pathname === '/api/layout')
      return json(200, { screenPanels, layout: SCREEN_LAYOUT, screenHmm });

    /* --- staff: on-screen panels vs printed panels, and the real screen height --- */
    if (req.method === 'POST' && u.pathname === '/api/screenpanels') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (raw.key !== ADMIN_KEY) return json(403, { error: 'nope' });
      if (raw.on !== undefined) screenPanels = !!raw.on;
      if (raw.screenHmm) screenHmm = Math.max(100, Math.min(6000, +raw.screenHmm || 810));
      broadcast('calib', activeCalib());
      broadcast('layout', { screenPanels, layout: SCREEN_LAYOUT, screenHmm });
      console.log(`screen panels ${screenPanels ? 'ON' : 'off'}, screen ${screenHmm}mm`);
      return json(200, { screenPanels, screenHmm });
    }

    /* --- undo YOUR last stroke. The event log makes this exact: pop the last
           contiguous run of this painter's batches back to its stroke start
           (b:true), skipping other painters' interleaved batches, and every
           screen rebuilds without it. Nobody can touch anyone else's paint. --- */
    if (req.method === 'POST' && u.pathname === '/api/undo') {
      const raw = JSON.parse(await readBody(req, 4000));
      const p = painters.get(raw.u | 0);
      if (!p) return json(403, { error: 'no can' });
      let removed = 0;
      for (let j = events.length - 1; j >= 0; j--) {
        if (events[j].u !== p.id) continue;
        const wasStart = events[j].b;
        p.dabs = Math.max(0, p.dabs - events[j].p.length);
        events.splice(j, 1); removed++;
        if (wasStart) break;               // the whole stroke is gone
      }
      persist();
      if (removed) broadcast('rebuild', {});
      return json(200, { removed });
    }

    /* --- surface picker, so the wall can be re-skinned mid-night --- */
    if (req.method === 'POST' && u.pathname === '/api/surface') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (raw.key !== ADMIN_KEY) return json(403, { error: 'nope' });
      surface = clean(raw.surface, 20) || 'brick';
      persist(); broadcast('surface', { surface });
      return json(200, { surface });
    }

    /* --- wipe, for between sessions --- */
    if (req.method === 'POST' && u.pathname === '/api/wipe') {
      const raw = JSON.parse(await readBody(req, 4000));
      if (raw.key !== ADMIN_KEY) return json(403, { error: 'nope' });
      events = []; persist(); broadcast('rebuild', {});
      return json(200, { ok: true });
    }

    if (u.pathname === '/api/leads.csv') {
      if (u.searchParams.get('key') !== ADMIN_KEY) return send(403, 'text/plain', 'nope');
      const rows = [['id','handle','email','dabs','joined','removed'].join(',')];
      for (const p of painters.values())
        rows.push([p.id, `"${p.handle.replace(/"/g,'""')}"`,
          `"${(p.email||'').replace(/"/g,'""')}"`, p.dabs,
          new Date(p.ts).toISOString(), p.nuked ? 'yes' : ''].join(','));
      return send(200, 'text/csv; charset=utf-8', rows.join('\n'),
        { 'Content-Disposition': 'attachment; filename="riot-wall-leads.csv"' });
    }

    if (u.pathname === '/api/wifi') return json(200, { urls: lanUrls(PORT), port: PORT });

    /* --- frame sink: a hidden browser pane stops compositing, so screenshots
           time out. The page renders itself and POSTs a data URL here. --- */
    if (req.method === 'POST' && u.pathname === '/__save') {
      if (!DEV) return send(404, 'text/plain', 'not found');
      const body = await readBody(req, 40_000_000);
      const name = basename(u.searchParams.get('name') || 'frame').replace(/[^\w.-]/g, '') || 'frame';
      await mkdir(join(ROOT, 'captures'), { recursive: true });
      await writeFile(join(ROOT, 'captures', name.endsWith('.png') ? name : name + '.png'),
        Buffer.from(body.slice(body.indexOf(',') + 1), 'base64'));
      return send(200, 'text/plain', 'saved ' + name);
    }

    /* --- static --- */
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    if (p === '/wall') p = '/wall.html';
    if (p === '/admin') p = '/admin.html';
    const target = join(ROOT, normalize(p).replace(/^([/\\])+/, ''));
    if (!target.startsWith(ROOT)) return send(403, 'text/plain', 'forbidden');
    const s = await stat(target);
    const file = s.isDirectory() ? join(target, 'index.html') : target;
    return send(200, MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      await readFile(file));
  } catch {
    if (!res.headersSent) send(404, 'text/plain', 'not found');
  }
}).listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls(PORT);
  console.log('\n  R!OT WALL is up');
  console.log('  ---------------------------------------------');
  console.log(`  WALL   (on the screen)   http://localhost:${PORT}/wall`);
  console.log(`  ADMIN  (staff phone)     http://localhost:${PORT}/admin`);
  console.log('\n  PHONES on the same wifi, put this on the QR cards:');
  urls.length ? urls.forEach(x => console.log(`     ${x}`))
              : console.log('     (no LAN address, connect this machine to wifi)');
  console.log(`\n  staff key: ${ADMIN_KEY}`);
  if (ADMIN_KEY === 'riot2026') {
    console.log('\n  *** THE STAFF KEY IS THE DEFAULT. On anything public, set');
    console.log('      RIOT_ADMIN_KEY to something else: it is the only thing');
    console.log('      standing between a stranger and Wipe wall + the lead list.');
  }
  if (DEV) console.log('\n  RIOT_DEV=1: the /__save capture sink is OPEN. Never set this in public.');
  console.log('  ---------------------------------------------');
});
