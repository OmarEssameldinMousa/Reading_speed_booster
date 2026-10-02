// Celebrations that grow with the milestone: a small cool sparkle for a section, warm confetti for a
// chapter, fireworks for a big book milestone. One shared full-screen canvas, no dependencies.

export type Level = 1 | 2 | 3 | 4;

export interface CelebrateOpts {
  level: Level;
  x?: number; // origin in viewport px (level 1 bursts here)
  y?: number;
  title?: string; // banner text for levels 3-4
  subtitle?: string;
  sound?: boolean;
}

// cool → warm as the milestone grows
export const PALETTES: Record<Level, string[]> = {
  1: ['#2a9df4', '#33c3b0', '#7bd389', '#a0c4ff'],
  2: ['#7bd389', '#f6d743', '#f4a261', '#2a9df4', '#ffe08a'],
  3: ['#f6c343', '#f4a261', '#e76f51', '#ffd166', '#ff9f1c', '#fff3b0'],
  4: ['#ff595e', '#ffca3a', '#ff924c', '#ffd700', '#ff6f91', '#fff1a8', '#c77dff'],
};

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
  shape: 'rect' | 'circle' | 'star';
  life: number; // seconds left
  max: number;
  drag: number;
  gravity: number;
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let parts: P[] = [];
let raf = 0;
let last = 0;
const timers: number[] = [];

type Listener = (o: CelebrateOpts) => void;
const listeners = new Set<Listener>();
/** The app shows banners and plays nothing else here; it subscribes to celebrations. */
export function onCelebrate(l: Listener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function reducedMotion() {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function ensureCanvas() {
  if (canvas?.isConnected) return;
  canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function burst(x: number, y: number, n: number, colors: string[], speed: number, opts: Partial<P> & { spread?: number; angle?: number } = {}) {
  const spread = opts.spread ?? Math.PI * 2;
  const angle = opts.angle ?? -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const a = angle + rnd(-spread / 2, spread / 2);
    const v = speed * rnd(0.45, 1);
    const life = rnd(0.9, 1.6) * (opts.life ?? 1);
    parts.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      rot: rnd(0, Math.PI * 2),
      vr: rnd(-12, 12),
      size: rnd(4, 8) * (opts.size ?? 1),
      color: pick(colors),
      shape: opts.shape ?? (Math.random() < 0.6 ? 'rect' : 'circle'),
      life,
      max: life,
      drag: opts.drag ?? 1.6,
      gravity: opts.gravity ?? 520,
    });
  }
}

function star(c: CanvasRenderingContext2D, r: number) {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.45 : r;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  c.closePath();
  c.fill();
}

function frame(t: number) {
  const c = ctx;
  if (!c || !canvas) return;
  const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
  last = t;
  c.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => (p.life -= dt) > 0 && p.y < innerHeight + 40);
  for (const p of parts) {
    p.vx -= p.vx * p.drag * dt;
    p.vy += p.gravity * dt - p.vy * p.drag * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    c.save();
    c.globalAlpha = Math.min(1, (p.life / p.max) * 2);
    c.translate(p.x, p.y);
    c.rotate(p.rot);
    c.fillStyle = p.color;
    if (p.shape === 'circle') {
      c.beginPath();
      c.arc(0, 0, p.size / 2, 0, Math.PI * 2);
      c.fill();
    } else if (p.shape === 'star') star(c, p.size);
    else c.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    c.restore();
  }
  if (parts.length) raf = requestAnimationFrame(frame);
  else {
    raf = 0;
    c.clearRect(0, 0, innerWidth, innerHeight);
  }
}

function run() {
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
}

function later(ms: number, f: () => void) {
  timers.push(window.setTimeout(f, ms));
}

/** A short rising chime, one note per level (off unless enabled in Settings). */
function chime(level: Level) {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new AC();
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5].slice(0, level + 1);
    notes.forEach((f, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t0 = ac.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.connect(g).connect(ac.destination);
      o.start(t0);
      o.stop(t0 + 0.55);
    });
    setTimeout(() => void ac.close(), 1500);
  } catch {
    /* no audio */
  }
}

/** "+1 section" rising from the caret. */
function floatText(text: string, x: number, y: number) {
  const el = document.createElement('div');
  el.className = 'fx-float';
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

export function celebrate(o: CelebrateOpts) {
  for (const l of listeners) l(o);
  if (o.sound) chime(o.level);
  if (reducedMotion()) return; // banners still show; no particles
  ensureCanvas();
  const W = innerWidth;
  const H = innerHeight;
  const colors = PALETTES[o.level];
  const x = o.x ?? W / 2;
  const y = o.y ?? H / 2;
  if (o.level === 1) {
    burst(x, y, 34, colors, 260, { size: 0.8, gravity: 300, life: 0.8 });
    if (o.title) floatText(o.title, x, y);
  } else if (o.level === 2) {
    burst(-10, H * 0.85, 70, colors, 900, { angle: -Math.PI / 3, spread: 0.7 });
    burst(W + 10, H * 0.85, 70, colors, 900, { angle: (-2 * Math.PI) / 3, spread: 0.7 });
  } else if (o.level === 3) {
    burst(-10, H * 0.8, 110, colors, 1100, { angle: -Math.PI / 3, spread: 0.8 });
    burst(W + 10, H * 0.8, 110, colors, 1100, { angle: (-2 * Math.PI) / 3, spread: 0.8 });
    for (let k = 0; k < 4; k++) later(300 + k * 260, () => {
      for (let i = 0; i < 40; i++) burst(rnd(0, W), -20, 1, colors, 60, { angle: Math.PI / 2, spread: 0.6, gravity: 160, drag: 0.6, life: 2.4 });
      run();
    });
  } else {
    // fireworks: rockets bursting into stars, then a golden rain
    for (let k = 0; k < 7; k++)
      later(k * 380, () => {
        const fx = rnd(W * 0.15, W * 0.85);
        const fy = rnd(H * 0.15, H * 0.45);
        const pal = [pick(colors), pick(colors), '#fff6d5'];
        burst(fx, fy, 90, pal, 520, { shape: 'star', size: 0.9, gravity: 140, drag: 1.1, life: 1.6 });
        burst(fx, fy, 40, pal, 260, { shape: 'circle', size: 0.6, gravity: 120, drag: 1.4, life: 1.2 });
        run();
      });
    later(2800, () => {
      for (let i = 0; i < 160; i++) burst(rnd(0, W), -20, 1, ['#ffd700', '#ffca3a', '#fff1a8', '#ff924c'], 60, { angle: Math.PI / 2, spread: 0.5, gravity: 140, drag: 0.5, life: 3 });
      run();
    });
  }
  run();
}

/** Stop everything (e.g. when leaving the page). */
export function stopCelebrations() {
  timers.splice(0).forEach(clearTimeout);
  parts = [];
}
