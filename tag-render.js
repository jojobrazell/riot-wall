// One renderer, shared by the phone composer and the wall.
// If these ever drift, what a guest draws stops matching what goes up, which is
// the one thing that would break trust in the whole installation.

export const PALETTE = ['#FF1E8E','#B6FF1A','#E8ECF2','#7B2CFF','#FF6A00',
                        '#E01B24','#F0EADC','#E8B800','#8A8F98','#0A0A0C'];

// S is the scale reference (the tag's box size in px) so line weight and stamp
// size stay proportional whether this is a phone canvas or a 12 foot wall.
export function drawStroke(g, s, W, H, S, upTo){
  const pts = upTo == null ? s.p : s.p.slice(0, Math.max(2, upTo));
  if (pts.length < 2) return;
  g.strokeStyle = PALETTE[s.c];
  g.lineWidth = Math.max(1.5, s.w * S);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = PALETTE[s.c];
  g.shadowBlur = s.w * S * 0.55;
  g.beginPath();
  g.moveTo(pts[0][0]*W, pts[0][1]*H);
  for (let i = 1; i < pts.length; i++){
    const a = pts[i-1], b = pts[i];
    g.quadraticCurveTo(a[0]*W, a[1]*H, (a[0]+b[0])/2*W, (a[1]+b[1])/2*H);
  }
  g.stroke();
  g.shadowBlur = 0;
}

export function drawStamp(g, st, W, H, S){
  const x = st.x*W, y = st.y*H, r = st.s*S*0.5;
  g.save(); g.translate(x,y); g.rotate(st.r||0);
  g.fillStyle = PALETTE[st.c];
  g.shadowColor = PALETTE[st.c]; g.shadowBlur = r*0.5;
  if (st.k === 'star'){
    g.beginPath();
    for (let i=0;i<10;i++){ const a=-Math.PI/2+i*Math.PI/5, rr=i%2?r*0.44:r;
      const px=Math.cos(a)*rr, py=Math.sin(a)*rr; i?g.lineTo(px,py):g.moveTo(px,py); }
    g.closePath(); g.fill();
  } else if (st.k === 'bolt'){
    g.beginPath();
    g.moveTo(-r*0.22,-r); g.lineTo(r*0.46,-r*0.16); g.lineTo(r*0.08,-r*0.10);
    g.lineTo(r*0.30,r); g.lineTo(-r*0.46,r*0.10); g.lineTo(-r*0.06,r*0.02);
    g.closePath(); g.fill();
  } else {
    g.beginPath();
    for (let i=0;i<18;i++){ const a=i*Math.PI/9, rr=i%2?r*0.55:r;
      const px=Math.cos(a)*rr, py=Math.sin(a)*rr*0.8; i?g.lineTo(px,py):g.moveTo(px,py); }
    g.closePath(); g.fill();
    g.shadowBlur=0; g.lineWidth=Math.max(2,r*0.10); g.strokeStyle='#0A0A0C'; g.stroke();
  }
  g.restore();
}

// progress 0..1 reveals the tag in the order it was actually drawn, so the wall
// can replay somebody spraying it rather than popping a finished image in.
export function drawTag(g, S, W, H, strokes, stamps, progress){
  const p = progress == null ? 1 : Math.max(0, Math.min(1, progress));
  const totalPts = strokes.reduce((n,s)=>n+s.p.length, 0) + (stamps.length * 8);
  let budget = totalPts * p;

  for (const s of strokes){
    if (budget <= 0) break;
    if (budget >= s.p.length) { drawStroke(g, s, W, H, S); budget -= s.p.length; }
    else { drawStroke(g, s, W, H, S, Math.floor(budget)); budget = 0; }
  }
  for (const st of stamps){
    if (budget <= 0) break;
    drawStamp(g, st, W, H, S); budget -= 8;
  }
}

// Bounding box of everything drawn, in 0..1 space. Used to crop a tag tight so
// the wall is not full of mostly empty squares.
export function tagBounds(strokes, stamps){
  let x0=1, y0=1, x1=0, y1=0, any=false;
  for (const s of strokes) for (const pt of s.p){
    x0=Math.min(x0,pt[0]-s.w); y0=Math.min(y0,pt[1]-s.w);
    x1=Math.max(x1,pt[0]+s.w); y1=Math.max(y1,pt[1]+s.w); any=true;
  }
  for (const st of stamps){
    const h=st.s*0.5;
    x0=Math.min(x0,st.x-h); y0=Math.min(y0,st.y-h);
    x1=Math.max(x1,st.x+h); y1=Math.max(y1,st.y+h); any=true;
  }
  if (!any) return {x:0,y:0,w:1,h:1};
  x0=Math.max(0,x0); y0=Math.max(0,y0); x1=Math.min(1,x1); y1=Math.min(1,y1);
  return { x:x0, y:y0, w:Math.max(0.02,x1-x0), h:Math.max(0.02,y1-y0) };
}
