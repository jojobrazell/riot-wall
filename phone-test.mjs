// One command to get R!OT WALL onto a phone.
//
//   node phone-test.mjs            (or double-click PHONE-TEST.cmd)
//
// Starts the wall server if it is not already up, opens a Cloudflare quick
// tunnel, and puts a QR on screen. Scan it and the can opens on the phone over
// real HTTPS.
//
// WHY A TUNNEL AND NOT JUST THE LOCAL IP: the camera only runs in a SECURE
// CONTEXT. http://192.168.x.x:8300 is not one, so the camera is blocked with no
// useful error and the page just sits there. A self signed cert does not rescue
// it either, iOS Safari refuses the camera on an untrusted cert. The tunnel
// gives a real trusted HTTPS origin, which is the whole point.
//
// NO LOGIN IS NEEDED for this. A quick tunnel is anonymous. `cloudflared tunnel
// login` is only for a FIXED hostname, so the printed QR does not change per
// run, and that is a separate decision.
//
// The trycloudflare hostname is random every run, which is why the QR is
// regenerated and reopened each time rather than printed once and saved.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] || 8300);
// ?dbg=1 by default: this script exists for TESTING, and the readout is the only
// thing that can tell you whether a dead-looking screen is the engine, the
// camera, or the panel. Pass "" as the third argument for a clean screen.
const QS = process.argv[3] === undefined ? '?dbg=1' : process.argv[3];

const children = [];
const bye = () => { for (const c of children) { try { c.kill(); } catch {} } };
process.on('SIGINT', () => { bye(); process.exit(0); });
process.on('exit', bye);

const isUp = (port) => new Promise((res) => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 1200);
});

/* ---- 1. the wall server, reused if it is already running ---- */
if (await isUp(PORT)) {
  console.log(`[1/4] wall server already up on :${PORT}, reusing it`);
} else {
  console.log(`[1/4] starting the wall server on :${PORT}`);
  const server = spawn(process.execPath, [join(ROOT, 'server.mjs'), String(PORT)], { stdio: 'inherit' });
  children.push(server);
  for (let i = 0; i < 20 && !(await isUp(PORT)); i++) await new Promise(r => setTimeout(r, 300));
  if (!(await isUp(PORT))) { console.error('server never came up'); process.exit(1); }
}

/* ---- 2. cloudflare quick tunnel ---- */
console.log('[2/4] opening a Cloudflare quick tunnel');
// One command STRING, not an args array with shell:true: cloudflared installs as
// a .cmd shim on Windows so it needs the shell, and passing both trips DEP0190.
const tunnel = spawn(`cloudflared tunnel --url http://localhost:${PORT} --no-autoupdate`, {
  shell: true, stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(tunnel);

const publicUrl = await new Promise((resolve, reject) => {
  let done = false;
  const scan = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !done) { done = true; resolve(m[0]); }
  };
  tunnel.stdout.on('data', scan);
  tunnel.stderr.on('data', scan);          // cloudflared prints the URL on stderr
  tunnel.on('exit', (c) => { if (!done) reject(new Error('cloudflared exited with code ' + c)); });
  setTimeout(() => { if (!done) reject(new Error('no tunnel URL after 45s')); }, 45000);
});

const full = publicUrl + '/' + QS;
console.log(`[3/4] live at ${full}`);

/* Prove it actually serves before showing a QR, because a tunnel that is up but
   not routing looks identical to a working one until the phone fails.
   VIA CURL, NOT node fetch: outbound HTTPS from node is blocked on this machine
   (the proxy), so a node fetch here reports FAILED on a tunnel that is serving
   perfectly and sends you chasing a problem that does not exist. */
function check(path) {
  return new Promise((res) => {
    const p = spawn('curl', ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code} %{content_type} %{size_download}b', '--max-time', '25', publicUrl + path],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => res(out.trim() || 'no answer'));
    p.on('error', () => res('curl not available, skipped'));
  });
}
for (const [label, path] of [['/', '/'], ['engine/xr.js', '/engine/xr.js'],
                             ['panel1.json', '/assets/image-target/panel1.json']]) {
  console.log(`      ${label.padEnd(14)} ${await check(path)}`);
}

/* ---- 3. QR ---- */
mkdirSync(join(ROOT, 'captures'), { recursive: true });
const qrSvgPath = join(ROOT, 'captures', 'phone-qr.svg');
// The terminal QR throws on the Windows console (cp1252 cannot encode the block
// glyphs), so it is guarded. The browser page is the real output.
const py = `
import segno, sys
try: sys.stdout.reconfigure(encoding='utf-8')
except Exception: pass
q = segno.make(${JSON.stringify(full)}, error='m')
q.save(${JSON.stringify(qrSvgPath.replace(/\\/g, '/'))}, scale=10, border=2, dark='#14100E', light='#F6F3EA')
try: q.terminal(compact=True)
except Exception: pass
`;
await new Promise((resolve) => {
  const p = spawn('python', ['-c', py], { stdio: ['ignore', 'inherit', 'inherit'] });
  p.on('exit', resolve);
});

const lan = [];
for (const list of Object.values(networkInterfaces()))
  for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address);

/* ---- 4. a page with the QR big on screen ---- */
const qrSvg = readFileSync(qrSvgPath, 'utf8').replace(/<\?xml[^>]*\?>/, '');
writeFileSync(join(ROOT, 'captures', 'phone.html'), `<!doctype html>
<meta charset="utf-8"><title>Scan to test R!OT WALL</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
       gap:18px;background:#0A0A0C;color:#CFCBC0;text-align:center;padding:28px;
       font:16px "Archivo Narrow","Arial Narrow",system-ui,sans-serif}
  .qr{background:#F6F3EA;padding:16px;line-height:0}
  .qr svg{width:min(58vw,320px);height:auto}
  h1{margin:0;font:900 30px/1 Georgia,serif;letter-spacing:-.5px}
  h1 em{font-style:normal;color:#FF1E8E}
  code{background:#14100E;border:1px solid #ffffff22;padding:8px 12px;font-size:13px;
       word-break:break-all;max-width:min(90vw,520px);display:inline-block;color:#B6FF1A}
  ol{text-align:left;max-width:470px;line-height:1.75;font-size:14px;color:#CFCBC0cc}
  .row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .row a{background:#FF1E8E;color:#14100E;text-decoration:none;padding:11px 18px;border-radius:9999px;
         font-weight:800;letter-spacing:.14em;text-transform:uppercase;font-size:12px}
  .row a.alt{background:#CFCBC0}
  .warn{color:#CFCBC077;font-size:12px;max-width:470px;line-height:1.6}
</style>
<h1>SCAN TO TEST R<em>!</em>OT WALL</h1>
<div class="qr">${qrSvg}</div>
<code>${full}</code>
<div class="row">
  <a href="http://localhost:${PORT}/wall" target="_blank">Open the wall</a>
  <a class="alt" href="http://localhost:${PORT}/admin" target="_blank">Staff + calibration</a>
  <a class="alt" href="http://localhost:${PORT}/panels.html" target="_blank">The panels</a>
</div>
<ol>
  <li>Put a tracking panel where the phone can see it. Fastest with no printer:
      open <b>captures/panel-1.png</b> full screen on a second screen or a tablet.
      Better: print it, matte, as big as you can.</li>
  <li>Open the wall on this machine (button above) so you can see the paint land.</li>
  <li>Scan the QR, give a tag name and any email, tap GRAB A CAN, then TURN ON THE CAMERA
      and allow it.</li>
  <li>Point at the panel. The badge goes green and shows the panel and your distance.
      Check that distance against a tape: if it is wrong, the panel height in
      Staff + calibration is wrong.</li>
  <li>Hold the trigger. Walk in and out, the line should get fatter as you approach.</li>
</ol>
<p class="warn">First load pulls about 5MB of tracking engine, so give it a few seconds on mobile data.
This URL is public while the tunnel runs and changes every time you start it.
Close the terminal window to take it down.${lan.length ? ` LAN address for reference: ${lan[0]}:${PORT} (no camera there, http is not a secure context).` : ''}</p>
`);

const open = spawn('cmd', ['/c', 'start', '', join(ROOT, 'captures', 'phone.html')], { shell: false });
open.on('error', () => {});

console.log('[4/4] QR open in your browser. Scan it.');
console.log(`      wall   http://localhost:${PORT}/wall`);
console.log(`      staff  http://localhost:${PORT}/admin   (key riot2026)`);
console.log('      Ctrl+C here takes the tunnel down.');
