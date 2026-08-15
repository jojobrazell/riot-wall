// THE WALL the paint lands on.
//
// This used to be flat rectangles with a random tint per brick, which reads as a
// diagram of a wall rather than a wall. Nothing tuned that: a real surface is
// not a colour, it is a HEIGHT FIELD lit by a light. So this builds one and
// lights it, the same four structural things that decide whether any 3D render
// reads cheap: real relief, grounding, surfaces that break up light, and lens
// character.
//
// THE TWO LAYER SPLIT, and it is the good idea in this file:
//   drawSurface()  bakes albedo x (ambient + diffuse + specular) with NO cavity
//                  shadow at all.
//   drawRelief()   returns just the cavity, as a multiply layer that sits ABOVE
//                  the paint.
// Stack them bg, paint, relief, and the crevices darken the WALL and the PAINT
// by the same amount, which is what actually happens: a mortar line is in shadow
// whether or not somebody sprayed across it. It also gives the classic look of
// spray skipping the deep joints, for free, with no per-dab masking.
//
// Everything is procedural. No image request, no downloaded bump map, no
// licence question, and it works with no internet at the venue.

const cache = new Map();                 // key -> { H, ID, ao, rw, rh }

/* BAKE RESOLUTION CAP. Lighting a height field is a per pixel job with a blur in
   the middle, so cost scales with area: at a full 1920x1080 the plaster surface
   measured about 13 SECONDS of frozen main thread. This project has already paid
   for that lesson once, when the 3D room hung on boot doing synchronous texture
   generation, so the wall is baked at no more than ~1.1M pixels and scaled up.
   A wall is soft detail seen across a dark room; the softening is invisible and
   arguably more photographic. The mortar geometry still lands in the right place
   because every dimension is scaled by the same factor. */
const MAX_BAKE = 1_150_000;
function bakeSize(w, h) {
  const s = Math.min(1, Math.sqrt(MAX_BAKE / (w * h)));
  return { rw: Math.max(2, Math.round(w * s)), rh: Math.max(2, Math.round(h * s)), s };
}

/* ---------- noise ----------
   Hash based value noise. Deterministic, so the wall is identical on every
   machine and across a reload, which matters because the wall is rebuilt from
   the event log and must land the paint in the same place every time. */
function hash2(x, y, s) {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + s * 1274126177;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const fade = t => t * t * (3 - 2 * t);
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = fade(x - xi), yf = fade(y - yi);
  const a = hash2(xi, yi, s),     b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return (a + (b - a) * xf) + ((c + (d - c) * xf) - (a + (b - a) * xf)) * yf;
}
function fbm(x, y, s, oct = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += vnoise(x * f, y * f, s + i * 17) * amp; amp *= 0.5; f *= 2; }
  return v;
}

/* ---------- the height field ----------
   0 = deepest joint, 1 = proud face. Also returns a per pixel brick id so the
   albedo pass can give each brick its own colour without recomputing the layout. */
function buildHeight(w, h, type, k) {
  const H = new Float32Array(w * h);
  const ID = new Float32Array(w * h);        // 0..1 per cell, for albedo variation

  if (type === 'brick' || type === 'subway') {
    const sub = type === 'subway';
    // Real brick is about 215mm long, so on a 2m wide venue screen it is roughly
    // a tenth of the width. At 108px on 1920 it read as embossed chocolate: the
    // single biggest thing making it look like a pattern instead of a wall.
    const bw = (sub ? 200 : 196) * k, bh = (sub ? 96 : 62) * k;
    const joint = (sub ? 9 : 14) * k;        // mortar width
    const round = (sub ? 6 : 9) * k;         // how rounded the brick shoulder is
    for (let y = 0; y < h; y++) {
      const row = Math.floor(y / (bh + joint));
      const offX = (row % 2) ? bw / 2 : 0;
      const ly = y - row * (bh + joint);
      for (let x = 0; x < w; x++) {
        const col = Math.floor((x + offX) / (bw + joint));
        const lx = (x + offX) - col * (bw + joint);
        // distance INTO the brick from whichever edge is nearest
        const dx = Math.min(lx, bw - lx), dy = Math.min(ly, bh - ly);
        // A CLEAN bevel on all four sides of every brick is a chamfered tile, not
        // masonry. Jitter the edge so the shoulder is ragged and uneven, and let
        // the face flatten off quickly instead of doming.
        const edgeJit = (vnoise(x * 0.09, y * 0.09, 61) - 0.5) * round * 1.5;
        const d = Math.min(dx, dy) + edgeJit;
        let hgt;
        if (d < 0) hgt = 0;                                  // in the joint
        else hgt = Math.min(1, d / round);                   // shoulder ramp
        hgt = Math.pow(fade(Math.max(0, hgt)), 0.55);         // flat face, fast rise

        const id = hash2(col, row, 7);
        // each brick sits slightly proud or shy, and is very slightly tilted
        const tilt = (hash2(col, row, 13) - 0.5) * 0.10 * (lx / bw - 0.5) * 2;
        let surf = hgt * (0.86 + id * 0.14 + tilt);

        if (hgt > 0) {
          // face roughness: coarse pitting on brick, a fine pillow on tile
          surf += sub ? (0.5 - Math.abs(lx / bw - 0.5)) * 0.10 + fbm(x * 0.05, y * 0.05, 3, 2) * 0.02
                      : (fbm(x * 0.10, y * 0.10, 3, 3) - 0.5) * 0.16;
          // a chipped corner on some bricks, because every real wall has them
          if (!sub && hash2(col, row, 29) > 0.86) {
            const cx = hash2(col, row, 31) > 0.5 ? 0 : bw, cy = hash2(col, row, 37) > 0.5 ? 0 : bh;
            const cd = Math.hypot(lx - cx, ly - cy) / (14 * k);
            if (cd < 1) surf *= 0.45 + cd * 0.55;
          }
        } else {
          // the joint is not flat either: raked mortar with grit in it
          surf = (fbm(x * 0.16, y * 0.16, 5, 2) - 0.5) * 0.10;
        }
        const i = y * w + x;
        H[i] = surf; ID[i] = id;
      }
    }
  } else if (type === 'concrete') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      // broad undulation from the pour, plus pitting, plus form board seams
      let v = fbm(x * 0.004, y * 0.004, 11, 4) * 0.55 + fbm(x * 0.05, y * 0.05, 19, 3) * 0.30;
      const seam = Math.abs(((y * k) % (260 * k)) - 130 * k) / (130 * k);
      v -= (1 - Math.min(1, seam * 8)) * 0.22;                 // recessed seam
      const pit = hash2(x, y, 23);
      if (pit > 0.9982) v -= 0.45;                             // blow holes
      H[y * w + x] = v + 0.35;
      ID[y * w + x] = 0.5;
    }
  } else if (type === 'plaster') {
    /* The trowel warp is very low frequency, so sampling it on a coarse grid and
       interpolating is visually identical and about 50x cheaper than evaluating
       two fBms per pixel. That alone took plaster from the slowest surface to
       one of the fastest. */
    const G = 8, gw = Math.ceil(w / G) + 2, gh = Math.ceil(h / G) + 2;
    const wxg = new Float32Array(gw * gh), wyg = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const px = gx * G, py = gy * G;
      wxg[gy * gw + gx] = fbm(px * 0.002, py * 0.002, 41, 2) * 6;
      wyg[gy * gw + gx] = fbm(px * 0.002, py * 0.002, 43, 2) * 6;
    }
    const samp = (arr, x, y) => {
      const gx = x / G, gy = y / G, ix = gx | 0, iy = gy | 0, fx = gx - ix, fy = gy - iy;
      const a = arr[iy * gw + ix], b = arr[iy * gw + ix + 1];
      const c = arr[(iy + 1) * gw + ix], d2 = arr[(iy + 1) * gw + ix + 1];
      return (a + (b - a) * fx) + ((c + (d2 - c) * fx) - (a + (b - a) * fx)) * fy;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const wx = x * 0.006 + samp(wxg, x, y);
      const wy = y * 0.006 + samp(wyg, x, y);
      let v = fbm(wx, wy, 47, 3) * 0.7 + fbm(x * 0.09, y * 0.09, 53, 2) * 0.12;
      // a hairline crack or two, carved as a thin dark valley
      const cr = Math.abs(fbm(x * 0.0035, y * 0.0035, 59, 3) - 0.5);
      if (cr < 0.012) v -= (1 - cr / 0.012) * 0.5;
      H[y * w + x] = v + 0.25;
      ID[y * w + x] = 0.5;
    }
  } else {
    H.fill(0.5); ID.fill(0.5);                                  // grid: no relief
  }

  /* Cavity map: how enclosed each pixel is, from the difference between the
     height and a cheap wide blur of it. This is what makes the joints read as
     depth rather than as a drawn line. */
  const blur = boxBlur(H, w, h, Math.max(2, Math.round(6 * k)));
  const ao = new Float32Array(w * h);
  for (let i = 0; i < ao.length; i++) {
    ao[i] = Math.max(0, Math.min(1, 0.5 + (H[i] - blur[i]) * 2.2));
  }
  return { H, ID, ao };
}

/* separable box blur, two passes, running sum. Fast enough to do at full size. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const d = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / d;
      sum -= src[y * w + Math.min(w - 1, Math.max(0, x - r))];
      sum += src[y * w + Math.min(w - 1, Math.max(0, x + r + 1))];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / d;
      sum -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
      sum += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
    }
  }
  return out;
}

/* Everything is built in the REDUCED space and scaled up at draw time. k carries
   the scale so a brick is the same physical size on screen either way. */
function field(w, h, type) {
  const key = `${type}:${w}x${h}`;
  if (cache.has(key)) return cache.get(key);
  cache.clear();                                    // only ever one wall on screen
  const { rw, rh, s } = bakeSize(w, h);
  const k = Math.max(0.55, w / 1920) * s;           // courses sane on any screen
  const f = buildHeight(rw, rh, type, k);
  f.rw = rw; f.rh = rh;
  cache.set(key, f);
  return f;
}

/* Shade into an offscreen at the bake size, then let the GPU scale it up. */
function offscreen(rw, rh) {
  const c = document.createElement('canvas');
  c.width = rw; c.height = rh;
  return c;
}

/* ---------- palettes ----------
   Dark, because the venue is dark and the paint is the thing that should glow.
   Warm blacks, never blue blacks: the deck is punk, not cyberpunk. */
const PAL = {
  brick:    { face: [58, 44, 40], faceVar: [26, 14, 12], joint: [92, 86, 80] },
  subway:   { face: [206, 202, 194], faceVar: [16, 16, 16], joint: [96, 92, 86] },
  concrete: { face: [86, 82, 79], faceVar: [10, 10, 10], joint: [70, 66, 63] },
  plaster:  { face: [176, 170, 160], faceVar: [12, 12, 12], joint: [140, 134, 126] },
};

/* ---------- the lit wall ----------
   NO cavity shadow here on purpose. drawRelief supplies it above the paint so it
   darkens the wall and the paint together. */
export function drawSurface(ctx, w, h, type, customImg) {
  ctx.clearRect(0, 0, w, h);

  if (type === 'grid') return drawGrid(ctx, w, h);
  if (type === 'custom' && customImg) {
    const s = Math.max(w / customImg.width, h / customImg.height);
    ctx.drawImage(customImg, (w - customImg.width * s) / 2, (h - customImg.height * s) / 2,
      customImg.width * s, customImg.height * s);
    return;
  }

  const f = field(w, h, type);
  const { H, ID, rw, rh } = f;
  const pal = PAL[type] || PAL.brick;
  const off = offscreen(rw, rh), ox = off.getContext('2d');
  const img = ox.createImageData(rw, rh);
  const d = img.data;
  const wOrig = w, hOrig = h;
  w = rw; h = rh;

  // light from the upper left, the way a venue side wash falls
  const lx = -0.46, ly = -0.62, lz = 0.64;
  const nScale = 2.6;                        // how pronounced the relief reads

  for (let y = 0; y < h; y++) {
    const yUp = y > 0 ? y - 1 : y, yDn = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xL = x > 0 ? x - 1 : x, xR = x < w - 1 ? x + 1 : x;
      // normal from the height gradient
      let nx = (H[y * w + xL] - H[y * w + xR]) * nScale;
      let ny = (H[yUp * w + x] - H[yDn * w + x]) * nScale;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv;
      const nz = inv;

      const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
      // Blinn specular. IDENTICAL sheen on every brick is what made this read as
      // a repeating tile: real bricks differ in how fired and how weathered they
      // are, so the highlight is modulated per brick and kept to a whisper.
      const hx = lx, hy = ly, hz = lz + 1;
      const hn = 1 / Math.sqrt(hx * hx + hy * hy + hz * hz);
      const gloss = 0.03 + ID[i] * 0.16;
      const spec = Math.pow(Math.max(0, nx * hx * hn + ny * hy * hn + nz * hz * hn), 26) * gloss;

      const inJoint = H[i] < 0.12;
      const base = inJoint ? pal.joint : pal.face;
      // widened, and pushed off centre so a few bricks are properly dark or pale
      const vary = inJoint ? 0.06 : (Math.pow(ID[i], 0.7) - 0.5) * 2.6;

      // STAINING. Large drifting blotches that ignore the courses entirely, which
      // is what actually breaks a brick grid: damp, soot, old paint, rain streaks.
      const stain = 0.72 + fbm(x * 0.0022, y * 0.0032, 71, 4) * 0.62;
      const streak = 0.90 + fbm(x * 0.02, y * 0.0016, 73, 2) * 0.20;

      // grime rising from the floor, and the venue's magenta bounce low down
      const fy = y / h;
      const grime = 1 - Math.pow(fy, 3) * 0.42;
      const bounce = Math.pow(fy, 4) * 0.30;

      const shade = (0.30 + diff * 0.85) * stain * streak;   // ambient + key + dirt
      let r = (base[0] + vary * (pal.faceVar[0])) * shade * grime + spec * 255 + bounce * 40;
      let g = (base[1] + vary * (pal.faceVar[1])) * shade * grime + spec * 255 + bounce * 8;
      let b = (base[2] + vary * (pal.faceVar[2])) * shade * grime + spec * 255 + bounce * 26;

      const p = i * 4;
      d[p]     = r < 0 ? 0 : r > 255 ? 255 : r;
      d[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      d[p + 3] = 255;
    }
  }
  ox.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, wOrig, hOrig);

  // lens character: the room falls off at the edges. Baked, not a DOM overlay,
  // so a screenshot of the wall looks like the wall. Drawn at FULL size so the
  // falloff stays smooth rather than inheriting the bake's pixels.
  const g = ctx.createRadialGradient(wOrig / 2, hOrig * 0.46, hOrig * 0.30,
                                     wOrig / 2, hOrig * 0.5, hOrig * 1.05);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.72)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, wOrig, hOrig);
}

/* ---------- the cavity, drawn ABOVE the paint ----------
   Multiply. Black with an alpha that rises in the crevices. This is the layer
   that makes spray look like it is ON a wall rather than on a photo of one. */
export function drawRelief(ctx, w, h, type) {
  ctx.clearRect(0, 0, w, h);
  if (type === 'grid' || type === 'custom') return;
  const { ao, rw, rh } = field(w, h, type);
  const off = offscreen(rw, rh), ox = off.getContext('2d');
  const img = ox.createImageData(rw, rh);
  const d = img.data;
  for (let i = 0; i < ao.length; i++) {
    const a = (1 - ao[i]);
    const p = i * 4;
    d[p] = 0; d[p + 1] = 0; d[p + 2] = 0;
    d[p + 3] = Math.max(0, Math.min(255, a * a * 300));
  }
  ox.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, w, h);
}

function drawGrid(ctx, w, h) {
  ctx.fillStyle = '#09090b'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255, 30, 142, 0.20)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < w; i += 40) { ctx.moveTo(i, 0); ctx.lineTo(i, h); }
  for (let i = 0; i < h; i += 40) { ctx.moveTo(0, i); ctx.lineTo(w, i); }
  ctx.stroke();
  const g = ctx.createLinearGradient(0, h, 0, 0);
  g.addColorStop(0, 'rgba(255, 30, 142, 0.20)'); g.addColorStop(1, 'transparent');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

export const SURFACES = ['brick', 'concrete', 'subway', 'plaster', 'grid'];
