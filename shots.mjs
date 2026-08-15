// Look at the phone UI. Headless Chrome, real screenshots, dev only.
//
//   node shots.mjs [port]
//
// WHY THIS EXISTS: the in-app Browser pane cannot composite when it is not
// displayed, so `computer{action:"screenshot"}` times out and a DOM redesign
// cannot be judged at all. It also throttles rAF and timers, which makes any
// animated state look dead. This drives its own Chrome with backgrounding
// disabled, so frames advance and the shot is what a guest would actually see.
//
// It rides the ?sim=1 path, so no camera and no printed panels are needed: the
// sim pushes engine-shaped poses through the real tracker, so the HUD shows a
// real lock, a real panel name and a real distance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, killChrome, openPage, navigate, sleep }
  from '../../../WSOLP/export/lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'captures', 'ui');
const PORT = Number(process.argv[2] || 8300);

// phone first, because that is the only screen that matters at the venue. The
// laptop pass exists purely to prove the layout does not stretch edge to edge,
// which is half of why the first version read as broken.
const VIEWS = [
  { label: 'phone',  width: 390, height: 844, mobile: true,  dpr: 2 },
  { label: 'laptop', width: 1280, height: 800, mobile: false, dpr: 1 },
];

let shots = 0;
async function shoot(s, label, name) {
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${label}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  shots++;
  console.log(`  shot ${path.basename(file)}  ${Math.round(Buffer.from(r.data, 'base64').length / 1024)} KB`);
}

async function pass(view) {
  const ch = await launchChrome({ port: 9740 + Math.floor(Math.random() * 40), ...view });
  try {
    const { s, rec } = await openPage(ch, view);

    // 1. THE GATE, the first thing 200 people see
    await navigate(s, `http://localhost:${PORT}/?sim=1`, { width: view.width });
    await sleep(900);
    // THE WORDMARK MUST FIT. It is set in a system serif we do not control, so
    // textLength is the only thing holding it inside the box, and a per-glyph y
    // list silently disables it. Assert the rendered bbox rather than trusting.
    const mark = await s.evalJson(`
      var t = document.querySelector('.mark .glyphs');
      var b = t.getBBox(), vb = document.querySelector('.mark').viewBox.baseVal;
      return { x:+b.x.toFixed(1), w:+b.width.toFixed(1), vbw:vb.width,
               fits: b.x >= -2 && (b.x + b.width) <= vb.width + 2,
               font: getComputedStyle(t).fontFamily.split(',')[0] };`);
    console.log(`  ${view.label} wordmark: ${JSON.stringify(mark)}`);
    if (!mark.fits) console.log('  *** WORDMARK OVERRUNS THE BOX ***');
    await shoot(s, view.label, '1-gate');

    // 2. THE GATE with a validation error showing, because that state is real
    await s.evalJson(`
      document.querySelector('#handle').value = 'X';
      document.querySelector('#go').click();
      return 1;`);
    await sleep(300);
    await shoot(s, view.label, '2-gate-error');

    // 3. THE PRIME CARD, the step between GRAB A CAN and the OS camera dialog
    await s.evalJson(`
      var e = document.querySelector('#email');
      document.querySelector('#handle').value = 'GRL CRUSH';
      e.value = 'shot@riot.test';
      e.dispatchEvent(new Event('input'));
      document.querySelector('#go').click();
      return 1;`);
    await sleep(1100);
    await shoot(s, view.label, '3-prime');

    // 4. THE CAN with a panel locked. The sim feeds real poses, so the badge
    //    carries a real panel name and a real distance.
    await s.evalJson(`document.querySelector('#allow').click(); return 1;`);
    await sleep(900);
    const locked = await s.evalJson(`
      window.__CAN.step(60);
      var st = window.__CAN.state();
      return { lock: st.lock, mode: st.mode, size: st.size,
               badge: document.querySelector('#lock').textContent.trim() };`);
    console.log(`  ${view.label} tracked state: ${JSON.stringify(locked)}`);
    await sleep(250);
    await shoot(s, view.label, '4-can-locked');

    // 5. THE CAN mid spray, trigger held, so the thickness meter, the ring and
    //    the stamp are in their live state rather than at rest
    await s.evalJson(`
      document.querySelector('#spray').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      window.__CAN.trigger(true); window.__CAN.step(10); return 1;`);
    await sleep(200);
    await shoot(s, view.label, '5-can-spraying');
    await s.evalJson(`window.__CAN.trigger(false);
      document.querySelector('#spray').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
      return 1;`);

    // 6. THE FALLBACK, no panel in frame, which is a state staff will see
    await navigate(s, `http://localhost:${PORT}/?sim=1&nopanel=1`, { width: view.width });
    await sleep(700);
    await s.evalJson(`
      document.querySelector('#handle').value = 'GRL CRUSH';
      document.querySelector('#email').value = 'shot@riot.test';
      document.querySelector('#go').click();
      return 1;`);
    await sleep(1100);
    await s.evalJson(`document.querySelector('#allow').click(); return 1;`);
    await sleep(900);
    const fb = await s.evalJson(`
      window.__CAN.step(30);
      var st = window.__CAN.state();
      return { lock: st.lock, mode: st.mode,
               badge: document.querySelector('#lock').textContent.trim() };`);
    console.log(`  ${view.label} fallback state: ${JSON.stringify(fb)}`);
    await shoot(s, view.label, '6-can-fallback');

    const errs = rec.consoleErrors || [];
    const failed = (rec.failed || []).filter(f => !f.canceled);
    console.log(`  ${view.label}: console errors ${errs.length}, failed requests ${failed.length}`);
    if (errs.length) console.log('   ', errs.slice(0, 5));
    if (failed.length) console.log('   ', failed.slice(0, 5).map(f => f.url));
  } finally { killChrome(ch); }
}

/* THE WALL. A different page and a different question: does the surface read as
   a wall. Every canvas layer is composited in draw order before the shot,
   because querySelector('canvas') grabs the static background and the art lives
   two layers up. */
async function wallPass(surface) {
  const view = { label: 'wall', width: 1280, height: 720, mobile: false, dpr: 1 };
  // A FIXED debug port is a trap here: if a run ever hangs, its Chrome survives
  // holding that port, and the next launch attaches to the dead browser and
  // hangs too, forever, looking like a bug in the page. Randomise it.
  const ch = await launchChrome({ port: 9800 + Math.floor(Math.random() * 90), ...view });
  try {
    const { s, rec } = await openPage(ch, view);
    await navigate(s, `http://localhost:${PORT}/wall`, { width: view.width });
    await sleep(1500);
    if (surface) {
      await s.evalJson(`
        return fetch('/api/surface',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({surface:${JSON.stringify(surface)},key:'riot2026'})}).then(()=>1);`);
      await sleep(1800);
    }
    const info = await s.evalJson(`
      var t0 = performance.now();
      var cs = [].slice.call(document.querySelectorAll('canvas'));
      var out = cs.map(function(c){ return { id:c.id, w:c.width, h:c.height,
        blend:getComputedStyle(c).mixBlendMode }; });
      return { layers: out, ms: Math.round(performance.now()-t0) };`);
    console.log(`  ${surface || 'current'} layers: ${JSON.stringify(info.layers)}`);
    // composite in DOM order, honouring the multiply on the relief layer
    await s.evalJson(`
      var cs = [].slice.call(document.querySelectorAll('canvas'));
      var c = document.createElement('canvas'); c.width=cs[0].width; c.height=cs[0].height;
      var g = c.getContext('2d');
      cs.forEach(function(x){
        g.globalCompositeOperation = getComputedStyle(x).mixBlendMode==='multiply' ? 'multiply' : 'source-over';
        g.drawImage(x,0,0);
      });
      return fetch('/__save?name=wall-${surface || 'current'}',{method:'POST',
        body:c.toDataURL('image/png')}).then(function(){return 1;});`);
    shots++;
    console.log(`  shot wall-${surface || 'current'}.png (captures/)`);
    console.log(`  console errors ${(rec.consoleErrors || []).length}`);
    if ((rec.consoleErrors || []).length) console.log('   ', rec.consoleErrors.slice(0, 4));
  } finally { killChrome(ch); }
}

if (process.argv.includes('--wall')) {
  for (const sfc of ['brick', 'concrete', 'plaster']) {
    console.log(`\nwall: ${sfc}`);
    await wallPass(sfc);
  }
} else {
  for (const v of VIEWS) {
    console.log(`\n${v.label}  ${v.width}x${v.height} dpr${v.dpr}`);
    await pass(v);
  }
}
console.log(`\n${shots} shots written`);
