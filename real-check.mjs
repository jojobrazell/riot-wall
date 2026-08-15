// Drive the REAL camera path, not the sim. Dev only.
//
//   node real-check.mjs [port]
//
// Everything verified so far went through ?sim=1, which never touches 8th Wall.
// This launches its own Chrome with a FAKE CAMERA (--use-fake-device-for-media-stream
// plus --use-fake-ui-for-media-stream so the permission prompt auto-accepts), then
// walks the actual guest flow: gate, prime card, TURN ON THE CAMERA, session.
//
// It cannot produce an imagefound, because the fake device is a rolling test
// pattern and not a Girl Riot panel. What it CAN settle is everything below that:
// does xr.js load, is XR8.XrController non-null (the `slam` chunk), does the
// session start, does the camera reach a ready status, do frames climb, are the
// four targets registered. That is the whole diagnostic ladder above "the panel
// is not tracking", which is the only rung a phone can answer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session, sleep } from '../../../WSOLP/export/lib/cdp.mjs';

const PORT = Number(process.argv[2] || 8300);
const DEBUG_PORT = 9812;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'riot-chrome-'));

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=390,844',
  '--no-first-run', '--no-default-browser-check', '--no-sandbox',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--enable-unsafe-swiftshader', '--hide-scrollbars',
  // the two flags this whole file exists for
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  'about:blank',
], { stdio: 'ignore' });

const die = () => { try { spawn('taskkill', ['/F', '/T', '/PID', String(chrome.pid)], { stdio: 'ignore' }); } catch {} };
process.on('exit', die);

try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); if (r.ok) ver = await r.json(); }
    catch { await sleep(250); }
  }
  if (!ver) throw new Error('chrome devtools never answered');

  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('cdp socket failed')), { once: true }); });
  const s = new Session(ws);

  const logs = [];
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  s.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error' || p.type === 'warning')
      logs.push(p.type + ': ' + (p.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  });
  s.on('Runtime.exceptionThrown', p =>
    logs.push('EXCEPTION: ' + (p.exceptionDetails?.exception?.description
      || p.exceptionDetails?.text || 'unknown')));

  await s.send('Page.enable');
  await s.send('Page.navigate', { url: `http://localhost:${PORT}/?dbg=1` });
  await sleep(3500);                       // the engine is ~5MB, give it time

  const before = await s.evalJson(`
    return { engine: !!window.XR8,
             controller: !!(window.XR8 && window.XR8.XrController),
             renderer: !!(window.XR8 && window.XR8.GlTextureRenderer),
             xrConfig: !!(window.XR8 && window.XR8.XrConfig) };`);
  console.log('after load          ', JSON.stringify(before));

  // the guest flow, for real
  await s.evalJson(`
    document.querySelector('#handle').value='REAL CHECK';
    document.querySelector('#email').value='real@riot.test';
    document.querySelector('#go').click(); return 1;`);
  await sleep(1600);

  const prime = await s.evalJson(`
    var b=document.querySelector('#allow');
    return { primeShown: document.querySelector('#prime').classList.contains('on'),
             allowLabel: b.textContent.trim(), allowDisabled: b.disabled };`);
  console.log('prime card          ', JSON.stringify(prime));

  await s.evalJson(`document.querySelector('#allow').click(); return 1;`);
  await sleep(6000);                       // camera open + a few seconds of frames

  const live = await s.evalJson(`
    var st = window.__CAN.tracker.stats();
    return { engine:st.engine, controller:st.controller, sessionStarted:st.started,
             camera:st.camera, frames:st.frames, fps:+st.fps.toFixed(1),
             targets:st.registered, badTargets:st.bad, foundEver:st.foundEver,
             lastEvent:st.lastEvent, engineError:st.error,
             canvas:{w:document.querySelector('#cam').width,
                     h:document.querySelector('#cam').height},
             fatalShown: document.querySelector('#fatal').classList.contains('on'),
             fatalMsg: document.querySelector('#fatalMsg').textContent,
             dbg: document.querySelector('#dbg').textContent };`);
  console.log('\n--- LIVE SESSION ---');
  for (const [k, v] of Object.entries(live)) {
    if (k === 'dbg') continue;
    console.log(`  ${k.padEnd(15)} ${JSON.stringify(v)}`);
  }
  console.log('\n--- WHAT THE PHONE WOULD SHOW ---\n' + live.dbg);

  console.log('\n--- CONSOLE ---');
  console.log(logs.length ? logs.slice(0, 12).join('\n') : '  clean');

  const verdict = live.sessionStarted && live.frames > 0;
  console.log('\nVERDICT: ' + (verdict
    ? 'engine + camera + pipeline all live. Anything failing on the phone from here is the PANEL or the device, not the code.'
    : 'the session did not come up here either, so it is the code and not the phone.'));
} finally { die(); }
