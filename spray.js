// The spray engine, lifted from JoJo's MediaPipe Street Art build.
//
// The nozzle physics are HIS and are copied faithfully: solid marker, fat cap,
// splatter, wet (with drips), streak (with additive glow). Do not "improve"
// these numbers, they are what make it feel like paint rather than a drawing
// app. The only change is that state is passed in rather than read from
// globals, so one canvas can take strokes from many people at once.

export const NOZZLES = {
  solid:    { radius: 15, solid: true },
  fat:      { radius: 40, density: 120, spread: 0.9 },
  splatter: { radius: 30, density: 30,  spread: 1.4 },
  wet:      { radius: 25, density: 90,  spread: 0.5, dripChance: 0.2 },
  streak:   { radius: 10, density: 40,  spread: 0.15, glow: true },
};

export const NOZZLE_ORDER = ['solid', 'fat', 'splatter', 'wet', 'streak'];

/* Paint one dab.
   ctx    a 2d context
   p      { x, y, color, nozzle, tool, size, spread, depth }
   last   { x, y } or null for the first dab of a stroke
   returns the point to use as `last` next time */
export function spray(ctx, p, last) {
  const settings = NOZZLES[p.nozzle] || NOZZLES.solid;
  const depthFactor = Math.max(0.5, Math.min(2.5, p.depth == null ? 1 : p.depth));
  const size = (p.size == null ? 1 : p.size) * depthFactor;
  const spreadMul = p.spread == null ? 1 : p.spread;
  const radius = settings.radius * size;
  const color = p.color || '#a855f7';

  if (p.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    return { x: p.x, y: p.y };
  }

  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1.0;

  if (settings.solid) {
    ctx.beginPath();
    ctx.lineWidth = radius * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    if (!last) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y); }
    else { ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); }
    ctx.stroke();

  } else if (p.nozzle === 'streak') {
    const density = settings.density * size;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = color;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * (1.5 + i * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
    for (let i = 0; i < density; i++) {
      const r = Math.random() * radius * settings.spread * spreadMul;
      const ang = Math.random() * Math.PI * 2;
      ctx.fillStyle = Math.random() > 0.7 ? '#ffffff' : color;
      ctx.beginPath();
      ctx.arc(p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r,
              Math.random() * 2 * size, 0, Math.PI * 2);
      ctx.fill();
    }

  } else if (p.nozzle === 'wet') {
    const density = settings.density * size;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, radius * 0.5, 0, Math.PI * 2); ctx.fill();

    ctx.globalAlpha = 0.3; ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x - radius * 0.1, p.y - radius * 0.1, radius * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1.0;

    ctx.fillStyle = color;
    for (let i = 0; i < density / 2; i++) {
      const r = Math.random() * radius * 0.8 * spreadMul;
      const ang = Math.random() * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r,
              Math.random() * 2 * size, 0, Math.PI * 2);
      ctx.fill();
    }

    // the drip is the whole reason this nozzle reads as spray paint
    if (Math.random() < settings.dripChance) {
      const dripX = p.x + (Math.random() - 0.5) * radius * 0.5;
      const dripW = (Math.random() * 4 + 2) * size;
      const dripH = (Math.random() * 60 + 20) * size;
      const grad = ctx.createLinearGradient(dripX, p.y, dripX, p.y + dripH);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.roundRect(dripX, p.y, dripW, dripH, dripW);
      ctx.fill();
    }

  } else {
    const density = settings.density * size;
    ctx.fillStyle = color;
    for (let i = 0; i < density; i++) {
      const angle = Math.random() * Math.PI * 2;
      let r = (Math.random() + Math.random()) * 0.5 * radius * settings.spread * spreadMul;
      if (p.nozzle === 'splatter' && Math.random() > 0.92) r *= 2.0;
      const px = p.x + Math.cos(angle) * r;
      const py = p.y + Math.sin(angle) * r;
      const opacity = 1 - (r / (radius * settings.spread * spreadMul));
      ctx.globalAlpha = Math.max(0.05, opacity * 0.5);
      const pSize = (p.nozzle === 'fat' ? 2.5 : 1.5) * (size > 1 ? 1.2 : 1);
      ctx.beginPath();
      ctx.arc(px, py, pSize * Math.random(), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 1.0;
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = 'source-over';
  return { x: p.x, y: p.y };
}

/* ---------- wall surfaces, also JoJo's ---------- */
// drawSurface used to live here. It moved to surface.js on 2026-08-13, when the
// wall became a lit height field instead of flat rectangles. This file is now
// ONLY JoJo's nozzles, and none of their numbers have been touched.
