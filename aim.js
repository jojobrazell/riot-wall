// THE FALLBACK AIMER. Where is the phone pointing, from the bright screen alone.
//
// track.js is the primary now: it locks a printed panel and gets true 6DoF pose.
// This file is what keeps the can alive when no panel is in frame, so a guest who
// wanders behind a pillar still gets a line instead of a dead button.
//
// THE TRICK: the wall is a bright screen in a dark room, so it is by far the
// brightest thing the phone camera can see. We do not need fiducial markers or
// a tracking library. Find the biggest bright blob, and that rectangle IS the
// wall. Its position tells us where the phone is aimed, its size tells us how
// close we are.
//
// WHY IT IS ONLY THE FALLBACK: it finds the WHOLE screen rectangle, so the moment
// a guest steps close enough that the screen overflows the frame, the blob runs to
// the frame edges and both the aim and the distance go wrong. That is exactly the
// range where "closer is thicker" is meant to pay off. It is also aim in SCREEN
// space, so rolling the phone rolls the line.
//
// SOURCE: a <video> or a <canvas>. The 8th Wall path has no video element at all,
// the engine draws the camera feed straight into its GL canvas, so this reads that
// canvas instead. It works because the engine's default GL context is created with
// preserveDrawingBuffer:true (verified in engine/xr.js), so the last rendered frame
// is still there to be sampled whenever we ask, at no per-frame cost.
//
// Everything is deliberately cheap: a 160x120 readback, one luminance pass, one
// connected-component pass. It has to share a phone with a live camera preview
// and a network loop, and a heavy detector would starve both.

// Work area, roughly 160x120 worth of pixels. The SHAPE is derived from the
// source every frame rather than fixed.
//
// THIS WAS A REAL BUG, caught 2026-08-12 and worth keeping written down: a fixed
// 160x120 buffer squashes a portrait phone frame by about 3x vertically, so a
// 16:9 screen rectangle comes back only 8 rows tall and gets thrown away by the
// speck rejection below. The fallback therefore looked fine on a landscape
// laptop and would have been dead on every actual phone at the venue.
const AREA = 160 * 120;

export function createAimer() {
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d', { willReadFrequently: true });
  let W = 0, H = 0, labels = null, stack = null, luma = null;
  /* Where the band ruler actually sits on the wall, in wall fractions
     {uL,uR,vT,vB}. With posters spread across a full-wall paint area, the span
     between the outer posters is no longer the paint area, so the server ships
     the true mapping in the calib and it is applied here. Null = the old
     behaviour (bands map straight to 0..1), which stays right for printed
     panels hung beside the screen. */
  let RULER = null;

  function resize(sw, sh) {
    const k = Math.sqrt(AREA / (sw * sh));
    const w = Math.max(40, Math.min(320, Math.round(sw * k)));
    const h = Math.max(40, Math.min(320, Math.round(sh * k)));
    if (w === W && h === H) return;
    W = w; H = h; cv.width = W; cv.height = H;
    labels = new Int32Array(W * H);
    stack = new Int32Array(W * H);
    luma = new Uint8Array(W * H);
  }

  // smoothing, because a jittery aim point makes a shaky line
  let sx = 0.5, sy = 0.5, sd = 0.5, primed = false;

  return {
    canvas: cv,
    size: () => ({ W, H }),

    /* source (video or canvas) -> { ok, u, v, fill, box } where u,v are 0..1 on
       the wall and fill is the fraction of the frame the wall covers (the
       distance proxy). */
    read(src, smoothing = 0.35) {
      if (!src) return { ok: false };
      // a video has to have decoded a frame; a canvas has to have a size
      let sw, sh;
      if (src.readyState !== undefined) {
        if (src.readyState < 2) return { ok: false };
        sw = src.videoWidth; sh = src.videoHeight;
      } else { sw = src.width; sh = src.height; }
      if (!(sw > 0 && sh > 0)) return { ok: false };
      resize(sw, sh);
      try { g.drawImage(src, 0, 0, W, H); } catch { return { ok: false }; }
      const px = g.getImageData(0, 0, W, H).data;

      // adaptive threshold: the wall is the bright thing, whatever the exposure
      let max = 0;
      for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
        const l = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) | 0;
        luma[i] = l; if (l > max) max = l;
      }
      if (max < 40) return { ok: false };              // room is dark, no screen in view
      const thr = Math.max(28, max * 0.55);

      /* THE BAND PATH, tried first. When the wall runs screen panels, each
         gutter carries stacked bright paper posters on near-black brick, and
         those two poster bands are a RULER: the paint area is (near enough) the
         span between their inner edges. Find the leftmost and rightmost tall
         bright bands and aim maps STRAIGHT into paint coordinates, with no
         guessing which blob is the screen. This is what fixed paint landing
         left when JoJo aimed right (2026-08-13): the old path had locked a
         bright paint cluster, not the screen. The mapping is off by the poster
         padding (about 1.5% of the span per side), far below hand jitter. */
      const col = findColumns(luma, W, H, thr);
      if (col) {
        let cu = col.u, cv2 = col.v;
        if (RULER) {
          cu = RULER.uL + cu * (RULER.uR - RULER.uL);
          cv2 = RULER.vT + cv2 * (RULER.vB - RULER.vT);
        }
        if (!primed) { sx = cu; sy = cv2; sd = col.fill; primed = true; }
        else {
          sx += (cu - sx) * smoothing;
          sy += (cv2 - sy) * smoothing;
          sd += (col.fill - sd) * (smoothing * 0.6);
        }
        return { ok: true, u: sx, v: sy, fill: sd, box: col.box, columns: true };
      }

      // largest connected component of bright pixels
      labels.fill(0);
      let best = { n: 0, x0: 0, y0: 0, x1: 0, y1: 0, score: 0, fillR: 0 };
      let cur = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (luma[i] < thr || labels[i]) continue;
          cur++;
          let sp = 0, n = 0, x0 = x, y0 = y, x1 = x, y1 = y;
          stack[sp++] = i; labels[i] = cur;
          while (sp) {
            const j = stack[--sp];
            const jx = j % W, jy = (j / W) | 0;
            n++;
            if (jx < x0) x0 = jx; if (jx > x1) x1 = jx;
            if (jy < y0) y0 = jy; if (jy > y1) y1 = jy;
            if (jx > 0     && luma[j - 1] >= thr && !labels[j - 1]) { labels[j - 1] = cur; stack[sp++] = j - 1; }
            if (jx < W - 1 && luma[j + 1] >= thr && !labels[j + 1]) { labels[j + 1] = cur; stack[sp++] = j + 1; }
            if (jy > 0     && luma[j - W] >= thr && !labels[j - W]) { labels[j - W] = cur; stack[sp++] = j - W; }
            if (jy < H - 1 && luma[j + W] >= thr && !labels[j + W]) { labels[j + W] = cur; stack[sp++] = j + W; }
          }
          // SCORE, not just size. "Largest bright blob" locked onto a CEILING
          // LAMP on JoJo's real phone (2026-08-13): the realistic wall render is
          // nearly black, so the screen no longer dominates and any bare bulb
          // wins on brightness. A screen is a big FILLED RECTANGLE, wider than
          // tall; a lamp is a small roundish glare blob. So each blob is scored
          // by area x how much of its own bounding box it fills (squared) x an
          // aspect gate, and a round or portrait blob is heavily penalised.
          const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
          const fillR = n / (cw * chh);
          const asp = cw / Math.max(1, chh);
          const aspectGate = (asp >= 1.15 && asp <= 3.2) ? 1 : 0.18;
          const score = n * fillR * fillR * aspectGate;
          if (score > best.score) best = { n, x0, y0, x1, y1, score, fillR };
        }
      }

      const bw = best.x1 - best.x0 + 1, bh = best.y1 - best.y0 + 1;
      // Reject specks and anything too thin to be a screen. Expressed as
      // FRACTIONS of the buffer, not pixel counts, because the buffer's shape
      // now follows the camera's and a fixed count means something different in
      // a tall frame than in a wide one. Same values as the original 160x120
      // tuning: 1.15% of the area, 8.75% of the width, 8.3% of the height.
      // The fill floor is what actually rejects a lamp: glare is a rounded blob
      // that fills well under 70% of its box, a lit screen fills nearly all.
      if (best.n < 0.0115 * W * H || bw < 0.0875 * W || bh < 0.083 * H
          || best.fillR < 0.62) return { ok: false };

      // The camera's own centre is where the can is pointed. Work out where that
      // lands inside the wall rectangle. Values outside 0..1 mean aiming off the
      // wall, which is honest and gets clamped by the caller.
      const u = (W / 2 - best.x0) / bw;
      const v = (H / 2 - best.y0) / bh;
      const fill = (bw * bh) / (W * H);

      if (!primed) { sx = u; sy = v; sd = fill; primed = true; }
      else {
        sx += (u - sx) * smoothing;
        sy += (v - sy) * smoothing;
        sd += (fill - sd) * (smoothing * 0.6);   // distance should settle slower than aim
      }

      return { ok: true, u: sx, v: sy, fill: sd,
               box: { x: best.x0 / W, y: best.y0 / H, w: bw / W, h: bh / H } };
    },

    reset() { primed = false; },
    setRuler(r) { RULER = (r && Number.isFinite(r.uL) && Number.isFinite(r.uR)) ? r : null; },
  };
}

/* Find the wall's two paper-white gutter columns and return aim in PAINT
   coordinates: u spans the gap between the columns' inner edges, v spans their
   shared vertical extent. Returns null when the scene does not contain two
   tall bright bands with a wide dark gap between them, so the blob path below
   still serves rooms with no columns (printed panels, the grid surface). */
function findColumns(luma, W, H, thr) {
  // bright count per column
  const cf = new Float32Array(W);
  let peak = 0;
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = 0; y < H; y++) if (luma[y * W + x] >= thr) c++;
    cf[x] = c; if (c > peak) peak = c;
  }
  // The bands are the stacked paste-up POSTERS in each gutter (the wall is brick
  // all across by JoJo's ruling, no white columns), so a band's bright rows are
  // the posters' combined height, roughly 43% of the screen's height in frame.
  // 12% of the FRAME height is the floor for a screen filling only part of it;
  // a paint cluster rarely stacks that much brightness into one column, and it
  // can never be the LEFTMOST or RIGHTMOST band because paint lives between the
  // gutters.
  if (peak < H * 0.12) return null;
  const t = peak * 0.55, minW = Math.max(2, W * 0.012);
  const bands = [];
  for (let x = 0, run = -1; x <= W; x++) {
    const on = x < W && cf[x] >= t;
    if (on && run < 0) run = x;
    else if (!on && run >= 0) { if (x - run >= minW) bands.push({ x0: run, x1: x - 1 }); run = -1; }
  }
  if (bands.length < 2) return null;
  const L = bands[0], R = bands[bands.length - 1];
  if (R.x0 - L.x1 < W * 0.25) return null;         // the gap IS the paint area

  // each band's vertical extent: rows where at least half the band is bright
  const extent = (b) => {
    let y0 = -1, y1 = -1;
    const need = (b.x1 - b.x0 + 1) * 0.5;
    for (let y = 0; y < H; y++) {
      let c = 0;
      for (let x = b.x0; x <= b.x1; x++) if (luma[y * W + x] >= thr) c++;
      if (c >= need) { if (y0 < 0) y0 = y; y1 = y; }
    }
    return { y0, y1 };
  };
  const eL = extent(L), eR = extent(R);
  if (eL.y0 < 0 || eR.y0 < 0) return null;
  const top = Math.max(eL.y0, eR.y0), bot = Math.min(eL.y1, eR.y1);
  if (bot - top < H * 0.15) return null;           // not the same screen

  const iL = L.x1, iR = R.x0;                      // inner edges = paint bounds
  return {
    u: (W / 2 - iL) / (iR - iL),
    v: (H / 2 - top) / (bot - top),
    fill: ((iR - iL) * (bot - top)) / (W * H),
    box: { x: L.x0 / W, y: top / H, w: (R.x1 - L.x0) / W, h: (bot - top) / H },
  };
}

/* Fill fraction -> spray size multiplier.
   NEAR is roughly filling the frame, FAR is the wall as a small rectangle.
   These two numbers are the whole feel of "step closer for a fatter line" and
   they MUST be tuned against the real screen at the real venue, standing at the
   nearest and furthest a guest would actually stand. */
export const RANGE = { far: 0.06, near: 0.55, minSize: 0.55, maxSize: 3.0 };

export function sizeFromFill(fill) {
  const t = (fill - RANGE.far) / (RANGE.near - RANGE.far);
  const c = Math.max(0, Math.min(1, t));
  return RANGE.minSize + (RANGE.maxSize - RANGE.minSize) * c;
}
