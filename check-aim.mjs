// Deterministic check of the panel aim math. No phone, no camera, no engine.
//
//   node check-aim.mjs
//
// Every case here is a pose I can work out by hand, so a failure is a real
// regression and not a tracking mood. The load-bearing one is TWO PANELS AGREE:
// two panels hung on opposite sides of the screen must report the SAME wall point
// for the same ray. That is the whole "stitch the wall up" idea, and if it ever
// breaks, guests on the left and right of the room paint in different places.

import { readFileSync } from 'node:fs';
import {
  aimFromPose, normalizeCalib, defaultCalib, rejectTarget,
  sizeFromDistance, RANGE_M, qrot, qconj, qmul, PANELS,
} from './track.js';

let pass = 0, fail = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function ok(name, cond, got, want) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got  ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`); }
}
function eq(name, got, want, eps = 1e-6) { ok(name, near(got, want, eps), got, want); }

const ID = { x: 0, y: 0, z: 0, w: 1 };
const CAM = { position: { x: 0, y: 0, z: 0 }, rotation: ID };
const cal = normalizeCalib(defaultCalib());
const P1 = cal.panels.panel1, P3 = cal.panels.panel3;
const A = cal.aspect;
const pose = (x, y, z, rot = ID, scale = 0.5) =>
  ({ position: { x, y, z }, rotation: rot, scale });

console.log('\nCALIBRATION');
eq('aspect is 16:9', A, 1440 / 810);
eq('panel1 sits left of the screen', P1.cx, 0.5 - 990 / 1440);
eq('panel3 sits right of the screen', P3.cx, 0.5 + 990 / 1440);
eq('panel1 is above centre', P1.cy, 0.5 - 330 / 810);
eq('panel height is 73% of the screen height', P1.hFrac, 594 / 810);
eq('panel is 0.594m tall', P1.heightM, 0.594);

console.log('\nAIM, single panel');
{
  // straight at the panel centre from 3 units away
  const a = aimFromPose(pose(0, 0, -3), CAM, P1, A);
  eq('centre hit lands on the panel centre, u', a.u, P1.cx);
  eq('centre hit lands on the panel centre, v', a.v, P1.cy);
  eq('distance in engine units', a.dist, 3);
  eq('distance in metres via the printed height', a.distM, 3 * (0.594 / 0.5));
  eq('square on, so hitDot is 1', a.hitDot, 1);
}
{
  // panel one unit to the left, so the ray lands one unit to the panel's RIGHT
  const a = aimFromPose(pose(-1, 0, -3), CAM, P1, A);
  eq('offset hit moves right along the wall', a.u, P1.cx + (2 * P1.hFrac) / A);
  eq('and not vertically', a.v, P1.cy);
}
{
  // twice as far is twice the distance, and the size drops with it
  const b = aimFromPose(pose(0, 0, -6), CAM, P1, A);
  eq('distance doubles at double the range', b.distM, 6 * (0.594 / 0.5));
  ok('further away sprays thinner',
     sizeFromDistance(b.distM) < sizeFromDistance(3 * (0.594 / 0.5)),
     sizeFromDistance(b.distM), '< nearer');
}

console.log('\nAIM, phone orientation');
{
  // Phone held upside down. The ray is unchanged, so the aim must be unchanged.
  // The old bright-rectangle detector could not do this: it read the wall in
  // SCREEN space, so rolling the phone rolled the aim.
  const roll180 = { x: 0, y: 0, z: 1, w: 0 };
  const flat = aimFromPose(pose(-1, 0, -3), CAM, P1, A);
  const rolled = aimFromPose(pose(-1, 0, -3), { position: CAM.position, rotation: roll180 }, P1, A);
  eq('rolling the phone does not move the aim, u', rolled.u, flat.u, 1e-9);
  eq('rolling the phone does not move the aim, v', rolled.v, flat.v, 1e-9);
}
{
  // Yaw 30 degrees. Hand-computed: t = 3/cos30, the hit slides 3*tan30 left.
  const yaw30 = { x: 0, y: Math.sin(Math.PI / 12), z: 0, w: Math.cos(Math.PI / 12) };
  const a = aimFromPose(pose(0, 0, -3), { position: CAM.position, rotation: yaw30 }, P1, A);
  const tan30 = Math.tan(Math.PI / 6);
  eq('yawed range is longer by 1/cos', a.dist, 3 / Math.cos(Math.PI / 6), 1e-9);
  eq('yawed hit slides by 3*tan30', a.u, P1.cx + ((-3 * tan30 / 0.5) * P1.hFrac) / A, 1e-9);
}

console.log('\nAIM, honest failures');
ok('edge on returns nothing rather than a wild guess',
   aimFromPose(pose(0, 0, -3, { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }), CAM, P1, A) === null,
   'null', 'null');
ok('a panel behind the phone returns nothing',
   aimFromPose(pose(0, 0, 3), CAM, P1, A) === null, 'null', 'null');
ok('a zero scale returns nothing',
   aimFromPose(pose(0, 0, -3, ID, 0), CAM, P1, A) === null, 'null', 'null');

console.log('\nTWO PANELS AGREE (the stitch)');
{
  // Engine units are metres here, so scale = the panel's real height.
  // panel1 hangs 0.99m left and 0.33m above the screen centre, panel3 mirrors it.
  // Both are on the wall plane 3m in front of the phone.
  const S = 0.594;
  const p1 = pose(-0.990, 0.330, -3, ID, S);
  const p3 = pose(0.990, 0.330, -3, ID, S);

  const a1 = aimFromPose(p1, CAM, P1, A);
  const a3 = aimFromPose(p3, CAM, P3, A);
  eq('panel1 says the ray hits the screen centre, u', a1.u, 0.5, 1e-12);
  eq('panel1 says the ray hits the screen centre, v', a1.v, 0.5, 1e-12);
  eq('panel3 agrees, u', a3.u, 0.5, 1e-12);
  eq('panel3 agrees, v', a3.v, 0.5, 1e-12);
  eq('and they agree on the distance', a1.distM, a3.distM, 1e-12);
  eq('distance is the real 3 metres', a1.distM, 3, 1e-12);

  // Now aim at the screen's top-left corner by sliding the phone, not turning it.
  const corner = { position: { x: -0.72, y: 0.405, z: 0 }, rotation: ID };
  const c1 = aimFromPose(p1, corner, P1, A);
  const c3 = aimFromPose(p3, corner, P3, A);
  eq('top-left corner reads u = 0 off panel1', c1.u, 0, 1e-12);
  eq('top-left corner reads v = 0 off panel1', c1.v, 0, 1e-12);
  eq('panel3 agrees on the corner, u', c3.u, 0, 1e-12);
  eq('panel3 agrees on the corner, v', c3.v, 0, 1e-12);
}

console.log('\nDESK TEST: THE PANEL IS THE WHOLE WALL (?panelwall)');
{
  // The mode that makes a desk test possible: one panel mapped onto the entire
  // wall, so aiming at the panel's own corners paints in the wall's corners.
  // A2 is 594mm tall, so the metres readout stays true as well.
  const H = 594;
  const pw = normalizeCalib({ measured: true, wall: { widthMm: H * 0.75, heightMm: H },
    panels: Object.fromEntries(PANELS.map(n =>
      [n, { offXMm: 0, offYMm: 0, heightMm: H, on: true }])) });
  const P = pw.panels.panel1, A2 = pw.aspect;
  eq('the panel fills the wall vertically', P.hFrac, 1);
  eq('and the wall takes the panel aspect', A2, 0.75);

  const S = 0.594;                       // engine units are metres in this case
  const at = (x, y) => aimFromPose(pose(-x, -y, -2, ID, S),
    { position: { x: 0, y: 0, z: 0 }, rotation: ID }, P, A2);
  // dead centre of the panel
  const c = at(0, 0);
  eq('panel centre is wall centre, u', c.u, 0.5, 1e-12);
  eq('panel centre is wall centre, v', c.v, 0.5, 1e-12);
  eq('and two metres reads as two metres', c.distM, 2, 1e-12);
  // the panel's own corners are the wall's corners. Half width is 0.375 of the
  // panel height, half height is 0.5, both times the real height in metres.
  const tl = at(-0.375 * S, 0.5 * S);
  eq('panel top left is wall 0,0 in u', tl.u, 0, 1e-12);
  eq('panel top left is wall 0,0 in v', tl.v, 0, 1e-12);
  const br = at(0.375 * S, -0.5 * S);
  eq('panel bottom right is wall 1,1 in u', br.u, 1, 1e-12);
  eq('panel bottom right is wall 1,1 in v', br.v, 1, 1e-12);
}

console.log('\nGYRO DEAD RECKONING (panel out of frame)');
{
  /* The claim under test: turning the phone and turning the REMEMBERED panel by
     the same amount must land on the same wall point as if the panel were still
     visible. If that holds, aiming at the middle of the wall keeps working after
     the edge panels leave the camera frame, which is the whole point. */
  const S = 0.594;
  const panel = { x: -0.990, y: 0.330, z: -3 };           // metres, wall plane at 3m
  const seen = { name: 'panel1', position: panel, rotation: ID, scale: S };
  const CAM0 = { position: { x: 0, y: 0, z: 0 }, rotation: ID };

  // truth: the phone yaws by theta and the panel is STILL visible
  const yaw = (t) => ({ x: 0, y: Math.sin(t / 2), z: 0, w: Math.cos(t / 2) });
  for (const deg of [8, 17, 30]) {
    const t = deg * Math.PI / 180;
    const live = aimFromPose(seen, { position: CAM0.position, rotation: yaw(t) }, P1, A);

    // dead reckoned: panel unseen, phone attitude went from identity to yaw(t),
    // so the remembered pose is rotated by dq = conj(now) * atLock
    const dq = qmul(qconj(yaw(t)), ID);
    const guess = { name: 'panel1', scale: S,
      position: qrot(dq, panel), rotation: qmul(dq, ID) };
    const dr = aimFromPose(guess, CAM0, P1, A);

    eq(`${deg} deg turn: reckoned u matches the live lock`, dr.u, live.u, 1e-9);
    eq(`${deg} deg turn: reckoned v matches the live lock`, dr.v, live.v, 1e-9);
    eq(`${deg} deg turn: and the distance matches`, dr.distM, live.distM, 1e-9);
  }
  // a pitch as well as a yaw, because a real hand does both at once
  const pitch = { x: Math.sin(0.12 / 2), y: 0, z: 0, w: Math.cos(0.12 / 2) };
  const both = qmul(yaw(0.22), pitch);
  const live2 = aimFromPose(seen, { position: CAM0.position, rotation: both }, P1, A);
  const dq2 = qmul(qconj(both), ID);
  const dr2 = aimFromPose({ name: 'panel1', scale: S,
    position: qrot(dq2, panel), rotation: qmul(dq2, ID) }, CAM0, P1, A);
  eq('yaw plus pitch together, u', dr2.u, live2.u, 1e-9);
  eq('yaw plus pitch together, v', dr2.v, live2.v, 1e-9);
  ok('and the turn actually moved the aim (the test is not trivially true)',
     Math.abs(dr2.u - aimFromPose(seen, CAM0, P1, A).u) > 0.05,
     +(dr2.u - aimFromPose(seen, CAM0, P1, A).u).toFixed(3), '> 0.05');
}

console.log('\nSIZE CURVE');
eq('at the near limit the can is wide open', sizeFromDistance(RANGE_M.near), RANGE_M.maxSize);
eq('at the far limit it is at its thinnest', sizeFromDistance(RANGE_M.far), RANGE_M.minSize);
eq('closer than near stays clamped', sizeFromDistance(0.2), RANGE_M.maxSize);
eq('further than far stays clamped', sizeFromDistance(40), RANGE_M.minSize);
eq('halfway is halfway', sizeFromDistance((RANGE_M.near + RANGE_M.far) / 2),
   (RANGE_M.minSize + RANGE_M.maxSize) / 2, 1e-9);

console.log('\nTHE REAL COMPILED PANELS');
for (const n of PANELS) {
  const t = JSON.parse(readFileSync(new URL(`./assets/image-target/${n}.json`, import.meta.url), 'utf8'));
  ok(`${n} is a shape this aimer can use`, rejectTarget(t) === null, rejectTarget(t), null);
  const p = t.properties;
  ok(`${n} is portrait 3:4 as the crop expects`, Math.abs(p.width / p.height - 0.75) < 1e-9,
     p.width / p.height, 0.75);
}
{
  const rotated = { properties: { left: 0, top: 0, width: 100, height: 100, isRotated: true, originalWidth: 100, originalHeight: 100 } };
  ok('a rotated target is refused loudly, not guessed at', !!rejectTarget(rotated), rejectTarget(rotated), 'a reason');
  const cropped = { properties: { left: 10, top: 0, width: 90, height: 100, isRotated: false, originalWidth: 100, originalHeight: 100 } };
  ok('a cropped target is refused too', !!rejectTarget(cropped), rejectTarget(cropped), 'a reason');
}

console.log('\nQUATERNION HELPER');
{
  const yaw90 = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
  const v = qrot(yaw90, { x: 0, y: 0, z: 1 });
  eq('90 deg about Y sends +Z to +X', v.x, 1, 1e-12);
  eq('and leaves nothing on Z', v.z, 0, 1e-12);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
