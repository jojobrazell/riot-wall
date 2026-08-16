// R!OT WALL, where is the phone pointed. The 8th Wall panel tracker.
//
// WHY PANELS AND NOT THE SCREEN. An image target has to be a static picture, and
// the wall changes the instant anybody sprays, so the screen can never be its own
// target. Instead we hang printed Girl Riot panels around the screen. Each one is
// a compiled target at a KNOWN place on the wall, so locking any single panel is
// enough to work out where the whole wall is.
//
// WHY THIS BEATS THE BRIGHT-RECTANGLE DETECTOR (aim.js, now the fallback). That one
// finds the whole screen rectangle, so it goes blind at close range, when only part
// of the screen is in frame. That is exactly when "closer is thicker" matters most.
// A panel gives full 6DoF pose from any fragment of the wall it can see, at any
// phone roll, and the distance is real geometry rather than a fill fraction.
//
// THE ONE ASSUMPTION, and it must hold at load-in: the panels are hung FLAT ON THE
// SAME WALL PLANE AS THE SCREEN, upright, not tilted or angled in. Everything below
// treats a panel as a window onto the wall's own plane. A panel canted off the wall
// will aim wrong, and it will look like a tracking bug when it is a hanging bug.
//
// SHAPE RESTRICTION, deliberate. Only isRotated:false targets whose crop is the
// whole image are accepted, which is exactly what make-target-local.py produces.
// A rotated or cropped target reports its pose in a different normalisation and I
// have no way to test one here, so it is refused loudly instead of guessed at.

/* ---------- the printed panels ----------
   Eight since 2026-08-15 (JoJo: more anchors across the wall). Each is a unique
   compiled target; the engine only needs to SEE one of them to aim. */
export const PANELS = ['panel1', 'panel2', 'panel3', 'panel4', 'panel5',
                       'panel6', 'panel7', 'panel8', 'panel9', 'panel10'];

/* ---------- small quaternion helpers (no Three.js on the phone) ---------- */
export function qrot(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
export const qconj = q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
const IDENT = { x: 0, y: 0, z: 0, w: 1 };

/* ---------- DEVICE ORIENTATION ----------
   The panels live at the EDGES of the screen, so the moment a guest aims at the
   middle, or steps close for a fatter line, every panel leaves the camera frame
   and the lock dies exactly when they are trying to paint. The mechanic itself
   drives people into that dead zone.

   The fix is dead reckoning: while a panel IS visible we know the phone's
   orientation, so when it goes we keep turning the remembered panel with the
   phone's own gyro and carry on aiming. Re-acquiring a panel snaps the truth
   back and wipes the accumulated drift. This assumes rotation only, which is
   what a hand does over a second or two; walking introduces error that the next
   glimpse corrects.

   Deltas only, never absolute angles, so the frame convention does not matter
   and there is no compass to go wrong. */
let orientQ = null, orientOk = false;
function eulerToQuat(alpha, beta, gamma) {
  const z = (alpha || 0) * Math.PI / 180, x = (beta || 0) * Math.PI / 180,
        y = (gamma || 0) * Math.PI / 180;
  const cX = Math.cos(x / 2), cY = Math.cos(y / 2), cZ = Math.cos(z / 2);
  const sX = Math.sin(x / 2), sY = Math.sin(y / 2), sZ = Math.sin(z / 2);
  return {                              // W3C deviceorientation is ZXY
    x: sX * cY * cZ - cX * sY * sZ,
    y: cX * sY * cZ + sX * cY * sZ,
    z: cX * cY * sZ + sX * sY * cZ,
    w: cX * cY * cZ - sX * sY * sZ,
  };
}
function onOrient(e) {
  if (e.alpha === null && e.beta === null && e.gamma === null) return;
  orientQ = eulerToQuat(e.alpha, e.beta, e.gamma);
  orientOk = true;
}
/* Must be called from a real tap: iOS 13+ refuses the sensor otherwise, exactly
   like the camera. The TURN ON THE CAMERA button is where this belongs. */
export async function enableOrientation() {
  try {
    const D = window.DeviceOrientationEvent;
    if (!D) return false;
    if (typeof D.requestPermission === 'function') {
      const res = await D.requestPermission();
      if (res !== 'granted') return false;
    }
    window.addEventListener('deviceorientation', onOrient, true);
    return true;
  } catch { return false; }
}
export const orientationState = () => ({ ok: orientOk });

/* ---------- calibration ----------
   Measured with a tape at load-in, in millimetres, because that is what a person
   on a ladder can actually produce. Everything downstream is derived.

     wall.widthMm/heightMm   the SCREEN (the painted surface)
     panel.offXMm/offYMm     panel CENTRE relative to the SCREEN CENTRE,
                             +X right, +Y up. Usually well outside the screen.
     panel.heightMm          the printed panel's height, the whole artwork.

   Positions MUST be measured, not guessed. The defaults below exist only so the
   can is not dead before anyone has a tape out, and they carry measured:false so
   the admin screen and the phone can both say so. */
export function defaultCalib() {
  return {
    measured: false,
    wall: { widthMm: 1440, heightMm: 810 },      // a 65in 16:9 screen
    panels: {                                     // A2 portrait, two a side
      panel1: { offXMm: -990, offYMm:  330, heightMm: 594, on: true },
      panel2: { offXMm: -990, offYMm: -330, heightMm: 594, on: true },
      panel3: { offXMm:  990, offYMm:  330, heightMm: 594, on: true },
      panel4: { offXMm:  990, offYMm: -330, heightMm: 594, on: true },
      // 5-8 exist only as on-screen posters; in printed mode they are OFF until
      // someone actually hangs and measures them. The server's screen calib
      // overrides these with real positions.
      panel5: { offXMm: -500, offYMm:  330, heightMm: 594, on: false },
      panel6: { offXMm: -500, offYMm: -330, heightMm: 594, on: false },
      panel7: { offXMm:  500, offYMm:  330, heightMm: 594, on: false },
      panel8: { offXMm:  500, offYMm: -330, heightMm: 594, on: false },
      panel9: { offXMm:    0, offYMm:  330, heightMm: 594, on: false },
      panel10:{ offXMm:    0, offYMm: -330, heightMm: 594, on: false },
    },
  };
}

/* raw millimetres -> the numbers the aim math wants */
export function normalizeCalib(raw) {
  const d = defaultCalib();
  const c = raw && raw.wall ? raw : d;
  const wW = +c.wall.widthMm || d.wall.widthMm;
  const wH = +c.wall.heightMm || d.wall.heightMm;
  const out = { measured: !!c.measured, wallW: wW, wallH: wH, aspect: wW / wH, panels: {} };
  for (const name of PANELS) {
    const p = (c.panels && c.panels[name]) || d.panels[name];
    const hMm = +p.heightMm || d.panels[name].heightMm;
    out.panels[name] = {
      on: p.on !== false,
      // wall coordinates: u across the width, v DOWN the height, 0..1 on the screen.
      // Panels sit beside the screen, so these land outside 0..1 and that is correct.
      cx: 0.5 + (+p.offXMm || 0) / wW,
      cy: 0.5 - (+p.offYMm || 0) / wH,
      hFrac: hMm / wH,          // panel height as a fraction of screen height
      heightM: hMm / 1000,      // for the true distance readout
      offXMm: +p.offXMm || 0, offYMm: +p.offYMm || 0, heightMm: hMm,
    };
  }
  return out;
}

/* A target we can actually use? Returns null if fine, else the reason. */
export function rejectTarget(t) {
  const p = (t && t.properties) || {};
  if (p.isRotated) return 'isRotated targets are not supported by this aimer';
  if (p.left || p.top) return 'target is cropped, aim math assumes the full image';
  if (p.width !== p.originalWidth || p.height !== p.originalHeight)
    return 'target crop is not the full image';
  return null;
}

/* ---------- the actual aim ----------
   detail  one imagefound/imageupdated payload: { position, rotation, scale }
   cam     the camera pose in the same space, { position, rotation }
   cal     one panel out of normalizeCalib().panels
   aspect  the screen's width/height

   Returns { u, v, distM, dist, hitDot } or null when the ray cannot land.

   scale IS THE PANEL HEIGHT in engine units. The engine normalises a planar
   target so scaledHeight = 1 for an upright portrait image (scaledWidth = w/h),
   so a plane of scaledHeight * scale is the panel's real height. That is what
   makes the whole thing unit-free: we never need to know what an engine unit is
   worth, only that the panel is `scale` of them tall and heightM metres tall. */
export function aimFromPose(detail, cam, cal, aspect) {
  const p = detail && detail.position, q = detail && detail.rotation;
  const s = detail && +detail.scale;
  if (!p || !q || !(s > 0)) return null;

  const o = (cam && cam.position) || { x: 0, y: 0, z: 0 };
  const cq = (cam && cam.rotation) || IDENT;

  const d = qrot(cq, { x: 0, y: 0, z: -1 });     // the phone points down its own -Z
  const n = qrot(q, { x: 0, y: 0, z: 1 });       // the panel's face normal
  const dn = d.x * n.x + d.y * n.y + d.z * n.z;
  // Looking along the panel edge-on. There is no honest answer, so say so.
  if (Math.abs(dn) < 1e-4) return null;

  const w = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
  const t = (w.x * n.x + w.y * n.y + w.z * n.z) / dn;
  if (!(t > 0)) return null;                     // the wall is behind the phone

  const rel = { x: o.x + d.x * t - p.x, y: o.y + d.y * t - p.y, z: o.z + d.z * t - p.z };
  const L = qrot(qconj(q), rel);                 // into the panel's own frame
  const lx = L.x / s, ly = L.y / s;              // in panel heights

  return {
    // panel-local displacement -> wall coordinates. v is inverted because the
    // panel's +Y is up and the wall's v runs down.
    u: cal.cx + (lx * cal.hFrac) / aspect,
    v: cal.cy - ly * cal.hFrac,
    dist: t,                                     // engine units
    distM: t * (cal.heightM / s),                // metres, via the printed height
    hitDot: Math.abs(dn),                        // 1 = square on, 0 = edge on
    lx, ly,
  };
}

/* Distance -> spray size. Closer is fatter, which is the whole mechanic.
   NEAR and FAR are METRES now, not a fill fraction, so they can be set by
   standing at the nearest and furthest a guest would stand and reading the HUD.
   Still must be tuned at the venue against the real screen. */
/* Punched up (JoJo, 2026-08-15: the distance-to-thickness link was too subtle to
   feel). Steeper range, wider extremes: arm's length is a FAT cap, the back of
   the floor is a pencil. */
export const RANGE_M = { near: 1.0, far: 5.0, minSize: 0.45, maxSize: 3.8 };

export function sizeFromDistance(m) {
  const t = (RANGE_M.far - m) / (RANGE_M.far - RANGE_M.near);
  const c = Math.max(0, Math.min(1, t));
  return RANGE_M.minSize + (RANGE_M.maxSize - RANGE_M.minSize) * c;
}

/* ---------- is the engine actually usable? ----------
   `window.XR8` existing is NOT enough. Image tracking lives in the separately
   loaded `slam` chunk (xr-tracking.js), so XR8 can be present while
   XR8.XrController is still null, and configure() then throws inside an awaited
   handler where nothing surfaces it. That reads on a phone as a dead black
   screen with no message at all.

   This is polled AND event driven: `xrloaded` may have fired before we attached
   if the script came from cache. */
export function engineState() {
  const XR8 = window.XR8;
  return {
    engine: !!XR8,
    controller: !!(XR8 && XR8.XrController),
    renderer: !!(XR8 && XR8.GlTextureRenderer),
    ready: !!(XR8 && XR8.XrController && XR8.GlTextureRenderer),
  };
}

export function whenEngineReady(timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (engineState().ready) return resolve(engineState());
    let done = false;
    const finish = () => { if (done) return; done = true;
      clearInterval(iv); window.removeEventListener('xrloaded', onLoad);
      resolve(engineState()); };
    const onLoad = () => { if (engineState().ready) finish(); };
    window.addEventListener('xrloaded', onLoad);
    const iv = setInterval(() => { if (engineState().ready) finish(); }, 120);
    setTimeout(finish, timeoutMs);
  });
}

/* ---------- the live session ---------- */

/* Fetch the compiled targets. Anything unusable is dropped with a reason rather
   than silently ignored, because a target that never fires looks like a tracking
   failure and costs an hour at load-in. */
export async function loadTargets(names = PANELS, base = 'assets/image-target') {
  const ok = [], bad = [];
  for (const n of names) {
    try {
      const r = await fetch(`${base}/${n}.json`, { cache: 'no-store' });
      if (!r.ok) { bad.push([n, 'http ' + r.status]); continue; }
      const t = await r.json();
      const why = rejectTarget(t);
      if (why) { bad.push([n, why]); continue; }
      ok.push(t);
    } catch (e) { bad.push([n, e.message || 'fetch failed']); }
  }
  return { targets: ok, bad };
}

/* createTracker: owns the 8th Wall session and hands back a smoothed aim.
   It does NOT own the spraying or the UI, only the answer to "where and how far". */
export function createTracker({ canvas, calib, onStatus, targets: preTargets }) {
  let cal = normalizeCalib(calib);
  const seen = new Map();              // name -> { detail, at }
  let cam = { position: { x: 0, y: 0, z: 0 }, rotation: IDENT };
  let running = false, frames = 0, lastFrameAt = 0, fps = 0;
  // Everything the phone can tell us when it looks dead. Read by the HUD.
  let diag = { started: false, camera: '-', registered: [], bad: [], error: '',
               foundEver: 0, lastEvent: '-', heldMs: 0 };

  // smoothed output. Aim settles fast, distance slower, same reasoning as the
  // old detector: a jittery aim makes a shaky line, a jittery size makes a
  // stroke that breathes.
  let su = 0.5, sv = 0.5, sd = 3, primed = false;
  let lastLock = 0, lockName = null;

  const GRACE_MS = 260;                // hold the lock through a blink of a dropout
  const STALE_MS = 120;                // a panel not updated this recently is not in view
  /* How long the gyro may carry the aim with no sighting. Orientation fusion is
     steady over a second or two; past that, drift and any walking the guest did
     make it a guess, so it hands over to the rough band aimer instead of lying. */
  const DEAD_MS = 2500;
  let lastGood = null;                 // newest real sighting + attitude at that moment

  const status = m => { try { onStatus && onStatus(m); } catch {} };

  function poseModule() {
    return {
      name: 'riot-aim',
      onStart: () => { diag.started = true; status('tracking'); },
      // The engine reports the camera separately from the session starting. A
      // denied or unavailable camera otherwise looks identical to "tracking is
      // just not finding the panel", which sends you debugging the wrong thing.
      onCameraStatusChange: ({ status: st }) => { diag.camera = String(st || '-'); },
      onException: (e) => { diag.error = 'engine: ' + ((e && e.message) || e); },
      onUpdate: ({ processCpuResult }) => {
        frames++;
        const now = Date.now();
        if (lastFrameAt) {
          const dt = now - lastFrameAt;
          if (dt > 0) fps += ((1000 / dt) - fps) * 0.08;
        }
        lastFrameAt = now;
        const r = processCpuResult && processCpuResult.reality;
        if (r && r.position && r.rotation) cam = { position: r.position, rotation: r.rotation };
      },
      listeners: [
        { event: 'reality.imageloading',  process: () => { diag.lastEvent = 'loading'; } },
        { event: 'reality.imagescanning', process: () => { diag.lastEvent = 'scanning'; } },
        { event: 'reality.imagefound',   process: ({ detail }) => { diag.foundEver++; note(detail); } },
        { event: 'reality.imageupdated', process: ({ detail }) => note(detail) },
        { event: 'reality.imagelost',    process: ({ detail }) => {
            if (detail) { seen.delete(detail.name); diag.lastEvent = 'lost:' + detail.name; } } },
      ],
    };
  }

  function note(detail) {
    if (!detail || !detail.name) return;
    diag.lastEvent = 'found:' + detail.name;
    seen.set(detail.name, { detail, at: Date.now() });
    // remember the newest real sighting AND the phone's attitude at that
    // instant, so the gyro can carry the aim once the panel leaves frame
    if (cal.panels[detail.name] && cal.panels[detail.name].on) {
      lastGood = { name: detail.name, detail, at: Date.now(),
                   orient: orientQ ? { ...orientQ } : null };
    }
  }

  /* The remembered panel, rotated by however much the phone has turned since we
     last actually saw it. Pure rotation: p' = dq * p, q' = dq * q, with
     dq = conj(now) * atLock. */
  function reckon(now) {
    if (!lastGood || !lastGood.orient || !orientQ) return null;
    const age = now - lastGood.at;
    if (age > DEAD_MS) return null;
    const dq = qmul(qconj(orientQ), lastGood.orient);
    const d = lastGood.detail;
    return {
      name: lastGood.name,
      detail: { name: lastGood.name, scale: d.scale,
                position: qrot(dq, d.position), rotation: qmul(dq, d.rotation) },
      age,
    };
  }

  /* Pick the panel to trust this frame: the nearest one still in view. A bigger
     `scale` means the panel fills more of the frame, which means a better pose. */
  function best(now) {
    let win = null;
    for (const [name, rec] of seen) {
      if (now - rec.at > STALE_MS) continue;
      const c = cal.panels[name];
      if (!c || !c.on) continue;
      const a = aimFromPose(rec.detail, cam, c, cal.aspect);
      if (!a) continue;
      const q = +rec.detail.scale || 0;
      if (!win || q > win.q) win = { name, aim: a, q };
    }
    return win;
  }

  return {
    /* Where is the can pointed right now?
       { ok, u, v, size, distM, panel, fps } */
    read(smoothing = 0.35) {
      const now = Date.now();
      let w = best(now), held = false;

      /* No panel in frame. Before giving up to the rough aimer, turn the last
         real sighting by however much the phone has rotated since. This is what
         keeps the can alive when a guest aims at the middle of the wall or steps
         in close, which is precisely where the edge panels leave the frame. */
      if (!w) {
        const r = reckon(now);
        if (r) {
          const c = cal.panels[r.name];
          const a = c && aimFromPose(r.detail, { position: { x: 0, y: 0, z: 0 }, rotation: IDENT },
                                     c, cal.aspect);
          if (a) { w = { name: r.name, aim: a, q: 0 }; held = true; diag.heldMs = r.age; }
        }
      }

      if (w) {
        if (!held) { lastLock = now; lockName = w.name; diag.heldMs = 0; }
        else lockName = w.name;
        const { u, v, distM } = w.aim;
        if (!primed) { su = u; sv = v; sd = distM; primed = true; }
        else {
          su += (u - su) * smoothing;
          sv += (v - sv) * smoothing;
          sd += (distM - sd) * (smoothing * 0.6);
        }
      } else if (!lastLock || now - lastLock > GRACE_MS) {
        primed = false; lockName = null;
        return { ok: false, fps, panels: seen.size };
      }
      return { ok: true, u: su, v: sv, distM: sd, size: sizeFromDistance(sd),
               panel: lockName, fresh: !!w && !held, held, fps,
               hitDot: w ? w.aim.hitDot : 0 };
    },

    setCalib(raw) { cal = normalizeCalib(raw); },
    calib() { return cal; },
    reset() { primed = false; seen.clear(); lastLock = 0; lastGood = null; },
    isRunning: () => running,
    stats: () => ({ frames, fps, seen: [...seen.keys()], cam,
                    gyro: orientOk, ...diag, ...engineState() }),

    /* Test hook. Push a pose in as if the engine had found a panel, so the real
       math, the real panel picking and the real smoothing can all be exercised
       with no camera and no engine. Used by ?sim=1. */
    feed(detail, camPose) { if (camPose) cam = camPose; note(detail); },

    async start() {
      if (running) return { ok: true };
      const st = engineState();
      // Checked SEPARATELY so the message says which half is missing. XR8 alone
      // is not enough: image tracking is in the `slam` chunk and configure()
      // throws on a null XrController.
      if (!st.engine) return { ok: false, error: 'engine script never loaded' };
      if (!st.controller) return { ok: false, error: 'image tracking chunk missing (XrController is null)' };
      if (!st.renderer) return { ok: false, error: 'GlTextureRenderer missing, no camera feed' };

      // Targets are preloaded at page load, so this await settles in a microtask
      // and the camera permission still sees the user's tap. Fetching them here
      // would spend the gesture and iOS would refuse the camera.
      const { targets, bad } = await (preTargets || loadTargets());
      if (bad && bad.length) console.warn('[riot] unusable targets:', bad);
      diag.bad = (bad || []).map(b => b[0] + ':' + b[1]);
      if (!targets.length) return { ok: false, error: 'no usable panel targets', bad };
      diag.registered = targets.map(t => t.name);

      // EVERYTHING from here can throw, and an uncaught throw inside an awaited
      // click handler surfaces nowhere at all. That is a black screen with no
      // message, which is the single worst failure mode for a venue.
      try {
        // Order matters and the two configure calls must stay separate.
        // Combining them drops disableWorldTracking and the session is rejected
        // on desktop. Verified in the platform ArViewer and in image-ar.html.
        XR8.XrController.configure({ disableWorldTracking: true });
        XR8.XrController.configure({ imageTargetData: targets });
        XR8.addCameraPipelineModules([
          XR8.GlTextureRenderer.pipelineModule(),   // draws the camera feed to our canvas
          XR8.XrController.pipelineModule(),
          poseModule(),
        ]);
        XR8.run({ canvas, allowedDevices: XR8.XrConfig.device().ANY });
      } catch (e) {
        diag.error = String((e && e.message) || e);
        return { ok: false, error: diag.error };
      }
      running = true;
      return { ok: true, targets: diag.registered, bad };
    },

    stop() {
      try { XR8.stop && XR8.stop(); } catch {}
      // XR8.stop leaves the module-name registry populated, so a second
      // addCameraPipelineModules with the same names is silently skipped and
      // nothing ever rebinds. Clear it or a restart is a dead camera.
      try { XR8.clearCameraPipelineModules && XR8.clearCameraPipelineModules(); } catch {}
      running = false; this.reset();
    },
  };
}
