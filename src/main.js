import * as THREE from 'three';
import { createWorld, stepWorld, R_FLAT, R_TOP, WALL_H, LAVA_Y } from './sim.js';
import { CARS } from './cars.js';
import { ARENAS } from './arenas.js';
import { S, persist, levelInfo, applyReward, MAX_LEVEL } from './store.js';

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const ICON = { shield: '🛡️', missile: '🚀', blast: '💥', bow: '🏹', glove: '🥊' };
const BOT_NAMES = ['Макс', 'Рокет', 'Турбо', 'Дрифт', 'Нитро', 'Бустер', 'Гонщик', 'Тайфун', 'Вихрь', 'Скорпион'];

// ---------------------------------------------------------------- звук
let ac = null;
function beep(freq, dur, type = 'sine', vol = 0.2, slide = 0) {
  if (S.vol <= 0) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol * S.vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t);
    o.stop(t + dur);
  } catch {
    /* звук недоступен */
  }
}
const SND = {
  bump: () => beep(120, 0.12, 'square', 0.12, -60),
  pickup: () => { beep(520, 0.1, 'triangle', 0.2); setTimeout(() => beep(780, 0.12, 'triangle', 0.2), 70); },
  launch: () => beep(300, 0.25, 'sawtooth', 0.12, 500),
  boom: () => beep(90, 0.4, 'sawtooth', 0.25, -60),
  shield: () => beep(660, 0.3, 'sine', 0.2, 300),
  fall: () => beep(500, 0.7, 'sine', 0.18, -420),
  tick: () => beep(600, 0.12, 'square', 0.15),
  go: () => beep(900, 0.35, 'square', 0.18),
  win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'triangle', 0.22), i * 120)),
  lose: () => [400, 330, 260].forEach((f, i) => setTimeout(() => beep(f, 0.3, 'triangle', 0.2), i * 150)),
};

// ---------------------------------------------------------------- three: основа
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1220);
const camera = new THREE.PerspectiveCamera(44, 2, 1, 600);

function fitCamera() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const e = (68 * Math.PI) / 180; // наклон камеры: 90° было бы строго сверху
  const R = R_TOP + 3;
  const vh = (camera.fov * Math.PI) / 360;
  const hh = Math.atan(Math.tan(vh) * camera.aspect);
  const d = Math.max((R * Math.sin(e)) / Math.tan(vh), R / Math.tan(hh)) * 1.02;
  camera.position.set(0, Math.sin(e) * d, Math.cos(e) * d);
  camera.lookAt(0, 0, 0);
}
window.addEventListener('resize', fitCamera);
fitCamera();

// постоянные объекты: свет и лава
scene.add(new THREE.HemisphereLight(0xffffff, 0x666688, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(-20, 40, 20);
scene.add(sun);

function canvasTex(size, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  return t;
}
const lavaTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#d9360b';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 10 + Math.random() * 28;
    for (const [ox, oy] of [[0, 0], [s, 0], [-s, 0], [0, s], [0, -s]]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, Math.random() < 0.5 ? 'rgba(255,200,60,.9)' : 'rgba(255,120,20,.8)');
      gr.addColorStop(1, 'rgba(255,100,0,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x + ox, y + oy, r, 0, TAU);
      g.fill();
    }
  }
}, 14);
const lava = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), new THREE.MeshBasicMaterial({ map: lavaTex }));
lava.rotation.x = -Math.PI / 2;
lava.position.y = LAVA_Y;
scene.add(lava);

// ---------------------------------------------------------------- сборка арены
let root = null; // всё, что относится к текущему матчу
let ramp = null;
let snow = null;
const padMeshes = [];

function disposeRoot() {
  if (!root) return;
  scene.remove(root);
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  root = null;
  ramp = null;
  snow = null;
  padMeshes.length = 0;
}

const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });

function floorTexture(theme) {
  return canvasTex(512, (g, s) => {
    const rnd = (a, b) => a + Math.random() * (b - a);
    if (theme.id === 'halloween') {
      g.fillStyle = '#4a3566';
      g.fillRect(0, 0, s, s);
      g.strokeStyle = 'rgba(255,150,40,.35)';
      g.lineWidth = 3;
      for (let i = 0; i <= 8; i++) {
        g.beginPath(); g.moveTo((i * s) / 8, 0); g.lineTo((i * s) / 8, s); g.stroke();
        g.beginPath(); g.moveTo(0, (i * s) / 8); g.lineTo(s, (i * s) / 8); g.stroke();
      }
      g.strokeStyle = 'rgba(255,138,31,.7)';
      g.lineWidth = 6;
      g.beginPath(); g.arc(s / 2, s / 2, s * 0.17, 0, TAU); g.stroke();
      g.beginPath(); g.arc(s / 2, s / 2, s * 0.33, 0, TAU); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.08)';
      for (let i = 0; i < 80; i++) g.fillRect(rnd(0, s), rnd(0, s), rnd(2, 7), rnd(2, 7));
    } else if (theme.id === 'christmas') {
      g.fillStyle = '#f2f8ff';
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 40; i++) {
        const x = rnd(0, s); const y = rnd(0, s); const r = rnd(20, 60);
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(190,215,245,.55)'); gr.addColorStop(1, 'rgba(190,215,245,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      g.strokeStyle = 'rgba(216,38,47,.55)'; g.lineWidth = 8;
      g.beginPath(); g.arc(s / 2, s / 2, s * 0.3, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(30,140,70,.5)';
      g.beginPath(); g.arc(s / 2, s / 2, s * 0.15, 0, TAU); g.stroke();
      g.fillStyle = '#fff';
      for (let i = 0; i < 120; i++) g.fillRect(rnd(0, s), rnd(0, s), 3, 3);
    } else if (theme.id === 'desert') {
      g.fillStyle = '#e9c27a';
      g.fillRect(0, 0, s, s);
      g.strokeStyle = 'rgba(190,140,70,.45)'; g.lineWidth = 3;
      for (let i = 0; i < 26; i++) {
        const y = rnd(0, s); const x = rnd(0, s * 0.6);
        g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + 60, y - 12, x + 120, y + 12, x + rnd(140, 260), y); g.stroke();
      }
      g.fillStyle = 'rgba(150,100,50,.35)';
      for (let i = 0; i < 300; i++) g.fillRect(rnd(0, s), rnd(0, s), 2, 2);
    } else {
      // небо: пол из облаков, но поверхность ровная
      g.fillStyle = '#d9efff';
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 60; i++) {
        const x = rnd(0, s); const y = rnd(0, s); const r = rnd(24, 70);
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      for (let i = 0; i < 18; i++) {
        const x = rnd(0, s); const y = rnd(0, s); const r = rnd(18, 40);
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, 'rgba(120,175,235,.35)'); gr.addColorStop(1, 'rgba(120,175,235,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
    }
  });
}

const RAMP_N = 48;
function buildRamp(c1, c2) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(RAMP_N * 4 * 3);
  const col = new Float32Array(RAMP_N * 4 * 3);
  const idx = [];
  const a = new THREE.Color(c1);
  const b = new THREE.Color(c2);
  for (let i = 0; i < RAMP_N; i++) {
    const c = i % 2 ? b : a;
    for (let k = 0; k < 4; k++) col.set([c.r, c.g, c.b], (i * 4 + k) * 3);
    idx.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  updateRamp(g, R_FLAT, R_TOP);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m.frustumCulled = false;
  return m;
}
function updateRamp(g, rIn, rOut) {
  const p = g.attributes.position.array;
  for (let i = 0; i < RAMP_N; i++) {
    const a0 = (i / RAMP_N) * TAU;
    const a1 = ((i + 1) / RAMP_N) * TAU;
    const c0 = Math.cos(a0); const s0 = Math.sin(a0);
    const c1 = Math.cos(a1); const s1 = Math.sin(a1);
    p.set([c0 * rIn, 0.02, s0 * rIn, c0 * rOut, WALL_H, s0 * rOut, c1 * rIn, 0.02, s1 * rIn, c1 * rOut, WALL_H, s1 * rOut], i * 12);
  }
  g.attributes.position.needsUpdate = true;
  g.computeVertexNormals();
}

function padIcons() {
  const g = new THREE.Group();
  const mk = (geo, color, extra) => {
    const m = new THREE.Mesh(geo, lam(color, extra));
    m.visible = false;
    g.add(m);
    return m;
  };
  const icons = {
    shield: mk(new THREE.SphereGeometry(0.75, 14, 10), 0x38bdf8, { transparent: true, opacity: 0.8 }),
    missile: mk(new THREE.ConeGeometry(0.42, 1.5, 10), 0xef4444),
    blast: mk(new THREE.TorusGeometry(0.62, 0.24, 8, 16), 0xff8a1f),
    bow: mk(new THREE.TorusGeometry(0.7, 0.13, 8, 16, Math.PI), 0x4ade80),
    glove: mk(new THREE.BoxGeometry(0.95, 0.95, 0.95), 0xfacc15),
  };
  icons.blast.rotation.x = Math.PI / 2;
  return { g, icons };
}

function decorate(theme, parent) {
  const add = (m, a, r, y = WALL_H) => {
    m.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    parent.add(m);
  };
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU + 0.1;
    const r = R_TOP + 3.2;
    const g = new THREE.Group();
    if (theme.id === 'halloween') {
      if (i % 2 === 0) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(1.5, 12, 8), lam(0xff7a14));
        p.scale.y = 0.8; p.position.y = 1.2; g.add(p);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 0.7, 6), lam(0x2f7d32));
        st.position.y = 2.5; g.add(st);
        const e = new THREE.MeshBasicMaterial({ color: 0xffe36b });
        for (const sx of [-0.5, 0.5]) {
          const eye = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.2), e);
          eye.position.set(sx, 1.5, 1.35); g.add(eye);
        }
        g.rotation.y = -a + Math.PI / 2;
      } else {
        const t = new THREE.Mesh(new THREE.ConeGeometry(1.3, 5, 7), lam(0x2a1f3d));
        t.position.y = 2.5; g.add(t);
        const t2 = new THREE.Mesh(new THREE.ConeGeometry(0.9, 3.4, 7), lam(0x3b2c55));
        t2.position.y = 5; g.add(t2);
      }
    } else if (theme.id === 'christmas') {
      if (i % 2 === 0) {
        const cols = [0xd8262f, 0xffd23f, 0x38bdf8];
        for (let k = 0; k < 3; k++) {
          const c = new THREE.Mesh(new THREE.ConeGeometry(2.2 - k * 0.5, 2.4, 9), lam(0x1f8a4c));
          c.position.y = 1.8 + k * 1.5; g.add(c);
          const ball = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), new THREE.MeshBasicMaterial({ color: cols[(k + i) % 3] }));
          ball.position.set(1.0 - k * 0.3, 1.1 + k * 1.5, 0.8); g.add(ball);
        }
        const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.45), new THREE.MeshBasicMaterial({ color: 0xffe36b }));
        star.position.y = 6.6; g.add(star);
      } else {
        const box = new THREE.Mesh(new THREE.BoxGeometry(2, 1.8, 2), lam(i % 4 === 1 ? 0xd8262f : 0x2f6fd8));
        box.position.y = 0.9; g.add(box);
        const rb = new THREE.Mesh(new THREE.BoxGeometry(2.05, 1.85, 0.4), lam(0xffd23f));
        rb.position.y = 0.9; g.add(rb);
      }
    } else if (theme.id === 'desert') {
      if (i % 2 === 0) {
        const m = lam(0x2f9e44);
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 4, 8), m);
        body.position.y = 2; g.add(body);
        for (const s of [-1, 1]) {
          const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 1.6, 8), m);
          arm.position.set(s * 1.0, 2.6, 0); g.add(arm);
          const lnk = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.0, 8), m);
          lnk.rotation.z = Math.PI / 2; lnk.position.set(s * 0.55, 1.9, 0); g.add(lnk);
        }
      } else {
        const r = new THREE.Mesh(new THREE.DodecahedronGeometry(1.4), lam(0xa8743c));
        r.position.y = 0.9; r.scale.y = 0.7; g.add(r);
      }
    } else {
      const m = lam(0xffffff);
      for (const [x, y, z, s] of [[0, 1.4, 0, 1.9], [1.5, 1.0, 0.3, 1.4], [-1.4, 1.0, -0.2, 1.5], [0.2, 2.3, 0.2, 1.4]]) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 8), m);
        p.position.set(x, y, z); g.add(p);
      }
    }
    add(g, a, r);
  }
  // гирлянда лампочек по краю (не только в новогодней арене, но у неё цветная)
  if (theme.id === 'christmas') {
    const cols = [0xff4d4d, 0xffd23f, 0x4ade80, 0x38bdf8];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * TAU;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 5), new THREE.MeshBasicMaterial({ color: cols[i % 4] }));
      bulb.position.set(Math.cos(a) * (R_TOP + 0.4), WALL_H + 0.35, Math.sin(a) * (R_TOP + 0.4));
      parent.add(bulb);
    }
  }
}

function buildArena(theme) {
  disposeRoot();
  root = new THREE.Group();
  scene.add(root);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(R_FLAT, 64), new THREE.MeshLambertMaterial({ map: floorTexture(theme) }));
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'floor';
  root.add(floor);

  ramp = buildRamp(theme.wall[0], theme.wall[1]);
  root.add(ramp);

  // светящееся кольцо по краю ровной площадки
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64), new THREE.MeshBasicMaterial({ color: theme.rim, side: THREE.DoubleSide }));
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.04;
  rim.scale.set(R_FLAT, R_FLAT, 1);
  rim.name = 'rim';
  root.add(rim);

  decorate(theme, root);

  if (theme.snow) {
    const n = 220;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos.set([(Math.random() - 0.5) * 90, Math.random() * 40, (Math.random() - 0.5) * 70], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    snow = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.7, transparent: true, opacity: 0.95 }));
    snow.frustumCulled = false;
    root.add(snow);
  }

  hemiFor(theme);
}

function hemiFor(theme) {
  scene.children.forEach((o) => {
    if (o.isHemisphereLight) { o.color.set(theme.hemi[0]); o.groundColor.set(theme.hemi[1]); o.intensity = theme.hemi[2]; }
    if (o.isDirectionalLight) { o.color.set(theme.sun[0]); o.intensity = theme.sun[1]; }
  });
}

// ---------------------------------------------------------------- машины
function buildCar(def, isPlayer) {
  const g = new THREE.Group();
  const b = def.body;
  const bodyY = b.wr * 0.9 + b.h / 2;
  const mat = lam(def.color, def.ghost ? { transparent: true, opacity: 0.8 } : {});
  const body = new THREE.Mesh(new THREE.BoxGeometry(b.len, b.h, b.wid), mat);
  body.position.y = bodyY;
  g.add(body);
  const top = bodyY + b.h / 2;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(b.cl, b.ch, b.wid * 0.84), lam(0x1d2b3d));
  cab.position.set(b.co, top + b.ch / 2 - 0.02, 0);
  g.add(cab);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(b.cl * 0.9, 0.08, b.wid * 0.8), mat);
  roof.position.set(b.co, top + b.ch, 0);
  g.add(roof);
  const wmat = lam(0x15151a);
  const wgeo = new THREE.CylinderGeometry(b.wr, b.wr, 0.42, 14);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(wgeo, wmat);
      w.rotation.x = Math.PI / 2;
      w.position.set(sx * b.len * 0.31, b.wr, sz * (b.wid / 2));
      g.add(w);
    }
  }
  if (b.stripe) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(b.len * 0.92, 0.04, 0.3), new THREE.MeshBasicMaterial({ color: def.accent }));
    s.position.set(0, top + 0.02, 0);
    g.add(s);
  }
  if (b.spoiler) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.08, b.wid * 0.95), lam(def.accent));
    sp.position.set(-b.len / 2 + 0.15, top + 0.45, 0);
    g.add(sp);
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.08), lam(0x222222));
      leg.position.set(-b.len / 2 + 0.15, top + 0.22, sz * b.wid * 0.3);
      g.add(leg);
    }
  }
  const hl = new THREE.MeshBasicMaterial({ color: 0xfff3b0 });
  for (const sz of [-1, 1]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.3), hl);
    l.position.set(b.len / 2 + 0.01, bodyY + 0.05, sz * b.wid * 0.33);
    g.add(l);
  }
  if (def.glow) {
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(b.len * 1.25, b.wid * 1.35), new THREE.MeshBasicMaterial({ color: def.glow, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    gl.rotation.x = -Math.PI / 2;
    gl.position.y = 0.08;
    g.add(gl);
  }
  g.scale.setScalar(1.3);

  const holder = new THREE.Group();
  holder.add(g);
  if (isPlayer) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.7, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.07;
    holder.add(ring);
  }
  const shield = new THREE.Mesh(new THREE.SphereGeometry(2.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35, depthWrite: false }));
  shield.position.y = 1.2;
  shield.visible = false;
  holder.add(shield);
  return { holder, body: g, shield };
}

// ---------------------------------------------------------------- эффекты
const fxList = [];
const fxGeo = {
  ring: new THREE.RingGeometry(0.85, 1, 32),
  ball: new THREE.SphereGeometry(1, 12, 8),
};
function fx(kind, x, z, color, size, dur, y = 0.3) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
  const m = new THREE.Mesh(kind === 'ring' ? fxGeo.ring : fxGeo.ball, mat);
  if (kind === 'ring') m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.scale.setScalar(0.2);
  scene.add(m);
  fxList.push({ m, t: 0, dur, size });
}
function updateFx(dt) {
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i];
    f.t += dt;
    const k = f.t / f.dur;
    if (k >= 1) {
      scene.remove(f.m);
      f.m.material.dispose();
      fxList.splice(i, 1);
      continue;
    }
    f.m.scale.setScalar(0.2 + f.size * k);
    f.m.material.opacity = 0.9 * (1 - k);
  }
}
function clearFx() {
  for (const f of fxList) { scene.remove(f.m); f.m.material.dispose(); }
  fxList.length = 0;
}

// ---------------------------------------------------------------- матч
let mode = 'menu'; // menu | game
let W = null;
let carViews = [];
let shotViews = new Map();
let player = null;
let lastCount = 4;
let accum = 0;
let resultShown = false;
let leftEarly = false;
let curTheme = ARENAS[0];

const shotMats = {
  missile: [new THREE.ConeGeometry(0.45, 2, 8), 0xff3b30],
  arrow: [new THREE.BoxGeometry(1.6, 0.12, 0.12), 0xfff3b0],
};

function pickOpponentCars(n) {
  const base = S.car;
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.max(0, Math.min(CARS.length - 1, base + Math.round((Math.random() - 0.5) * 6)));
    out.push(CARS[idx]);
  }
  return out;
}

function startMatch() {
  curTheme = ARENAS[S.arena] || ARENAS[0];
  buildArena(curTheme);
  clearFx();
  shotViews.forEach((v) => root.remove(v));
  shotViews = new Map();

  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  const opp = pickOpponentCars(3);
  const entries = [{ name: S.name, def: CARS[S.car], isPlayer: true }];
  opp.forEach((d, i) => entries.push({ name: names[i], def: d }));
  W = createWorld(entries);
  player = W.cars[W.playerId];

  carViews = W.cars.map((c) => {
    const v = buildCar(c.def, c.isPlayer);
    root.add(v.holder);
    const blob = new THREE.Mesh(new THREE.CircleGeometry(2.0, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2;
    root.add(blob);
    v.blob = blob;
    return v;
  });

  W.pads.forEach((p) => {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.5, 0.3, 24), lam(0x20253f));
    base.position.y = 0.15;
    g.add(base);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.25, 24), new THREE.MeshBasicMaterial({ color: 0x7dd3fc, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.32;
    g.add(ring);
    const ic = padIcons();
    ic.g.position.y = 1.7;
    g.add(ic.g);
    root.add(g);
    padMeshes.push({ g, ic, ring });
  });

  mode = 'game';
  accum = 0;
  resultShown = false;
  leftEarly = false;
  lastCount = 4;
  show('hud');
  $('hud').className = 'screen on ' + (S.side === 'right' ? 'R' : 'L');
  $('abil').style.setProperty('--s', String(S.btn));
  $('spec').style.display = 'none';
  $('big').textContent = '';
  $('alive').textContent = '';
}

function endToMenu() {
  mode = 'menu';
  W = null;
  disposeRoot();
  clearFx();
  shotViews = new Map();
  carViews = [];
  showMenu();
}

function syncViews(dt) {
  const t = performance.now() / 1000;
  const R0 = W.rFlat;
  // машины
  W.cars.forEach((c, i) => {
    const v = carViews[i];
    v.holder.visible = c.alive;
    v.blob.visible = c.alive && !c.falling && Math.hypot(c.x, c.z) < W.rFlat;
    if (!c.alive) return;
    v.holder.position.set(c.x, c.y + 0.02, c.z);
    v.blob.position.set(c.x, 0.05, c.z);
    v.holder.rotation.y = -c.h;
    if (c.falling) {
      v.body.rotation.z += dt * 4;
      v.body.rotation.x += dt * 2;
    } else {
      // на стене машина слегка наклоняется
      const r = Math.hypot(c.x, c.z);
      v.body.rotation.z = r > R0 ? -0.25 : 0;
    }
    v.shield.visible = c.shield;
    if (c.shield) v.shield.scale.setScalar(1 + Math.sin(t * 6) * 0.04);
  });

  // платформы
  W.pads.forEach((p, i) => {
    const m = padMeshes[i];
    m.g.visible = !p.off;
    m.g.position.set(p.x, 0, p.z);
    for (const k in m.ic.icons) m.ic.icons[k].visible = p.type === k;
    m.ic.g.visible = !!p.type;
    m.ic.g.rotation.y = t * 2;
    m.ic.g.position.y = 1.7 + Math.sin(t * 3 + i) * 0.2;
    m.ring.material.color.set(p.type ? 0x7dd3fc : 0x4b5568);
  });

  // пол и стена сужаются, когда поднимается лава
  if (W.shrinking) {
    const s = W.rFlat / R_FLAT;
    const floor = root.getObjectByName('floor');
    const rim = root.getObjectByName('rim');
    floor.scale.set(s, s, 1);
    rim.scale.set(W.rFlat, W.rFlat, 1);
    updateRamp(ramp.geometry, W.rFlat, W.rTop);
  }

  // снаряды
  const alive = new Set(W.shots);
  shotViews.forEach((v, s) => {
    if (!alive.has(s)) { root.remove(v); v.material.dispose(); shotViews.delete(s); }
  });
  for (const s of W.shots) {
    let v = shotViews.get(s);
    if (!v) {
      const [geo, color] = shotMats[s.k];
      v = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
      root.add(v);
      shotViews.set(s, v);
    }
    v.position.set(s.x, 1.2, s.z);
    v.rotation.set(0, -s.h, s.k === 'missile' ? -Math.PI / 2 : 0);
  }

  // лава
  lavaTex.offset.set(t * 0.02, t * 0.015);
  // снег
  if (snow) {
    const p = snow.geometry.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      p[i + 1] -= dt * 4;
      p[i] += Math.sin(t + i) * dt * 0.8;
      if (p[i + 1] < 0) p[i + 1] = 40;
    }
    snow.geometry.attributes.position.needsUpdate = true;
  }
}

function handleEvents() {
  for (const e of W.events) {
    switch (e.t) {
      case 'bump': fx('ring', e.x, e.z, 0xffffff, 1.5 + e.p * 2.5, 0.25); SND.bump(); break;
      case 'hit': fx('ring', e.x, e.z, 0xffd23f, 3, 0.3); SND.bump(); break;
      case 'pickup': if (e.id === W.playerId) SND.pickup(); break;
      case 'launch': SND.launch(); break;
      case 'blast': fx('ring', e.x, e.z, 0xff8a1f, 7, 0.4); SND.boom(); break;
      case 'glove': fx('ring', e.x + Math.cos(e.h) * 4, e.z + Math.sin(e.h) * 4, 0xfacc15, 5, 0.3); SND.boom(); break;
      case 'explosion': fx('ball', e.x, e.z, 0xff6a1a, 3.5, 0.35, 1); SND.boom(); break;
      case 'shield': if (e.id === W.playerId) SND.shield(); break;
      case 'shieldBreak': fx('ring', e.x, e.z, 0x38bdf8, 4, 0.35); break;
      case 'fall': SND.fall(); break;
      case 'splash': fx('ball', e.x, e.z, 0xffb02e, 4, 0.5, LAVA_Y + 0.5); break;
      case 'go': SND.go(); $('big').textContent = 'ВПЕРЁД!'; setTimeout(() => { if ($('big').textContent === 'ВПЕРЁД!') $('big').textContent = ''; }, 700); break;
      default: break;
    }
  }
  W.events.length = 0;
}

function updateHud() {
  if (W.state === 'countdown') {
    const n = Math.ceil(W.countdown);
    if (n !== lastCount && n > 0) { lastCount = n; SND.tick(); }
    $('big').textContent = n > 0 ? String(n) : '';
  }
  const left = W.cars.filter((c) => c.alive && !c.falling).length;
  $('alive').textContent = `🚗 Живых: ${left}`;
  const ab = $('abil');
  ab.textContent = player.ability ? ICON[player.ability] : '';
  ab.classList.toggle('has', !!player.ability);

  // игрок выпал — наблюдаем
  const out = player.falling || !player.alive;
  if (out && W.state !== 'ended') {
    $('spec').style.display = 'flex';
    $('specTxt').textContent = 'Вы в лаве! Смотрите бой или выходите';
    $('specExit').textContent = `Выйти (+${5} 🪙)`;
  }
  if (W.state === 'ended' && W.endT > 1.4 && !resultShown) showResult();
}

function showResult() {
  resultShown = true;
  const won = W.winner === player;
  const r = applyReward(won);
  $('spec').style.display = 'none';
  $('big').textContent = '';
  $('rTitle').textContent = won ? '🏆 Победа!' : '💀 Поражение';
  let html = `<div>Награда: <span class="coin">+${r.coins} 🪙</span></div><div>Опыт: <b>${r.xp > 0 ? '+' : ''}${r.xp}</b></div>`;
  if (r.after > r.before) html += `<div style="color:#4ade80">⬆ Новый уровень: ${r.after}!</div>`;
  if (r.after < r.before) html += `<div style="color:#f87171">⬇ Уровень понижен: ${r.after}</div>`;
  $('rInfo').innerHTML = html;
  (won ? SND.win : SND.lose)();
  show('result');
}

function leaveMatch() {
  // выход до конца боя засчитывается как поражение
  if (W && !resultShown) {
    const r = applyReward(false);
    toast(`+${r.coins} 🪙, опыт ${r.xp}`);
  }
  endToMenu();
}

// ---------------------------------------------------------------- управление
const hud = $('hud');
const zone = $('zone');
const base = $('stickBase');
const thumb = $('stickThumb');
let stickId = null;
let stickO = { x: 0, y: 0 };
const keys = {};
const STICK_R = 55;

function setStick(x, y) {
  if (player) { player.input.sx = x; player.input.sz = y; }
}
zone.addEventListener('pointerdown', (e) => {
  if (stickId !== null) return;
  stickId = e.pointerId;
  zone.setPointerCapture(e.pointerId);
  stickO = { x: e.clientX, y: e.clientY };
  base.style.display = 'block';
  base.style.left = e.clientX + 'px';
  base.style.top = e.clientY + 'px';
  thumb.style.left = '36px';
  thumb.style.top = '36px';
  if (ac && ac.state === 'suspended') ac.resume();
});
zone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== stickId) return;
  let dx = e.clientX - stickO.x;
  let dy = e.clientY - stickO.y;
  const d = Math.hypot(dx, dy);
  if (d > STICK_R) { dx = (dx / d) * STICK_R; dy = (dy / d) * STICK_R; }
  thumb.style.left = 36 + dx + 'px';
  thumb.style.top = 36 + dy + 'px';
  setStick(dx / STICK_R, dy / STICK_R);
});
const stickEnd = (e) => {
  if (e.pointerId !== stickId) return;
  stickId = null;
  base.style.display = 'none';
  setStick(0, 0);
};
zone.addEventListener('pointerup', stickEnd);
zone.addEventListener('pointercancel', stickEnd);

function useAbility() {
  if (player && mode === 'game') player.input.use = true;
}
$('abil').addEventListener('pointerdown', (e) => { e.preventDefault(); useAbility(); });

function keyVec() {
  let x = 0;
  let y = 0;
  if (keys.ArrowLeft || keys.a) x -= 1;
  if (keys.ArrowRight || keys.d) x += 1;
  if (keys.ArrowUp || keys.w) y -= 1;
  if (keys.ArrowDown || keys.s) y += 1;
  const l = Math.hypot(x, y);
  return l ? [x / l, y / l] : [0, 0];
}
window.addEventListener('keydown', (e) => {
  keys[e.key] = true;
  if (e.key === ' ') useAbility();
  if (stickId === null && mode === 'game') setStick(...keyVec());
});
window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
  if (stickId === null && mode === 'game') setStick(...keyVec());
});

// ---------------------------------------------------------------- экраны
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('on');
  $(id).classList.add('on');
}
let toastT = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.style.display = 'none'; }, 2200);
}

function showMenu() {
  const li = levelInfo(S.xp);
  $('mName').textContent = S.name;
  $('mLvl').textContent = li.level >= MAX_LEVEL ? 'MAX' : li.level;
  $('mXp').style.width = Math.round((li.cur / li.need) * 100) + '%';
  $('mCoins').textContent = S.coins;
  const a = ARENAS[S.arena];
  const c = $('aCard');
  c.textContent = `${a.emoji} ${a.name}`;
  c.style.background = `linear-gradient(135deg, ${a.bg[0]}, ${a.bg[1]})`;
  show('menu');
}

function norm(v, lo, hi) { return Math.round(((v - lo) / (hi - lo)) * 100); }
const RAR = { common: 'Обычная', rare: 'Редкая', epic: 'Эпическая', legendary: 'Легендарная' };

function showGarage() {
  $('gCoins').textContent = S.coins;
  const list = $('garageList');
  list.innerHTML = '';
  for (const car of CARS) {
    const owned = S.owned.includes(car.id);
    const card = document.createElement('div');
    card.className = 'card' + (S.car === car.id ? ' sel' : '');
    const hex = '#' + car.color.toString(16).padStart(6, '0');
    const acc = '#' + car.accent.toString(16).padStart(6, '0');
    let btn;
    if (S.car === car.id) btn = '<button disabled>Выбрано</button>';
    else if (owned) btn = `<button class="green" data-sel="${car.id}">Выбрать</button>`;
    else btn = `<button class="gold" data-buy="${car.id}" ${S.coins < car.price ? 'disabled' : ''}>🪙 ${car.price}</button>`;
    card.innerHTML = `
      <div class="pic" style="background:linear-gradient(135deg,${hex},${acc})">🚗</div>
      <div><b>${car.name}</b><div class="rar-${car.rarity}" style="font-size:12px">${RAR[car.rarity]}</div></div>
      <div class="stat"><span>Скор.</span><div class="bar"><i style="width:${norm(car.speed, 14, 18)}%"></i></div></div>
      <div class="stat"><span>Разгон</span><div class="bar"><i style="width:${norm(car.accel, 24, 40)}%"></i></div></div>
      <div class="stat"><span>Манёвр</span><div class="bar"><i style="width:${norm(car.turn, 4, 5.8)}%"></i></div></div>
      <div class="stat"><span>Вес</span><div class="bar"><i style="width:${norm(car.mass, 0.85, 1.55)}%"></i></div></div>
      ${btn}`;
    list.appendChild(card);
  }
  show('garage');
}

$('garageList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.sel !== undefined) {
    S.car = +b.dataset.sel;
    persist();
    showGarage();
  } else if (b.dataset.buy !== undefined) {
    const car = CARS[+b.dataset.buy];
    if (S.coins >= car.price && !S.owned.includes(car.id)) {
      S.coins -= car.price;
      S.owned.push(car.id);
      S.car = car.id;
      persist();
      toast(`Куплено: ${car.name}!`);
      showGarage();
    }
  }
});

function showSettings() {
  $('sVol').value = Math.round(S.vol * 100);
  $('sBtn').value = Math.round(S.btn * 100);
  $('sName').value = S.name;
  markSide();
  show('settings');
}
let tmpSide = 'left';
function markSide() {
  tmpSide = S.side;
  $('sLeft').className = tmpSide === 'left' ? 'green' : 'gray';
  $('sRight').className = tmpSide === 'right' ? 'green' : 'gray';
}
$('sLeft').onclick = () => { tmpSide = 'left'; $('sLeft').className = 'green'; $('sRight').className = 'gray'; };
$('sRight').onclick = () => { tmpSide = 'right'; $('sRight').className = 'green'; $('sLeft').className = 'gray'; };
$('sVol').oninput = () => { S.vol = $('sVol').value / 100; beep(660, 0.1, 'triangle', 0.2); };
$('sSave').onclick = () => {
  S.vol = $('sVol').value / 100;
  S.btn = $('sBtn').value / 100;
  S.side = tmpSide;
  const n = $('sName').value.trim();
  if (n) S.name = n.slice(0, 14);
  persist();
  toast('Сохранено');
  showMenu();
};
$('sBack').onclick = () => { S.vol = JSON.parse(localStorage.getItem('arenacars_v1') || '{}').vol ?? S.vol; showMenu(); };

$('nameOk').onclick = () => {
  const n = $('nameIn').value.trim();
  if (!n) { toast('Введи ник'); return; }
  S.name = n.slice(0, 14);
  persist();
  showMenu();
};
$('aPrev').onclick = () => { S.arena = (S.arena + ARENAS.length - 1) % ARENAS.length; persist(); showMenu(); };
$('aNext').onclick = () => { S.arena = (S.arena + 1) % ARENAS.length; persist(); showMenu(); };
$('bPlay').onclick = startMatch;
$('bGarage').onclick = showGarage;
$('bSet').onclick = showSettings;
$('gBack').onclick = showMenu;
$('rAgain').onclick = () => { endToMenu(); startMatch(); };
$('rMenu').onclick = endToMenu;
$('specExit').onclick = leaveMatch;
$('pause').onclick = () => {
  if (!W || resultShown) return;
  if (confirm('Выйти из матча? Это будет засчитано как поражение.')) leaveMatch();
};

// ---------------------------------------------------------------- главный цикл
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (mode === 'game' && W) {
    accum += dt;
    let n = 0;
    while (accum >= 1 / 60 && n < 5) {
      stepWorld(W, 1 / 60);
      accum -= 1 / 60;
      n++;
    }
    handleEvents();
    syncViews(dt);
    updateHud();
  }
  updateFx(dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// старт
if (S.name) showMenu();
