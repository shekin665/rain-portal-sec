'use strict';
// Background rain and an occasional soft lightning flash. The portal makes no sound.
// - Rain is drawn on a canvas behind the page content.
// - Lightning is a brief, low-contrast fade (never faster than a gentle double pulse).
// - Visitors who ask their device for reduced motion get no effects unless they switch rain on themselves,
//   and even then the lightning flash stays off.
(function () {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(key, val ? '1' : '0'); } catch { /* storage blocked */ } }

  // Working screens (dashboard, printable report) set data-rain="off": the effect starts off there.
  const workScreen = document.body.dataset.rain === 'off';
  let rainOn = load('rain-effect', !reduced && !workScreen);

  const canvas = document.createElement('canvas');
  canvas.className = 'rain-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const flash = document.createElement('div');
  flash.className = 'rain-flash';
  flash.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  document.body.append(flash);

  const g = canvas.getContext && canvas.getContext('2d');
  if (!g) return; // no canvas support: the portal works the same without the effect

  let w = 0, h = 0, dpr = 1, drops = [], raf = 0, last = 0, bolt = null;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(40, Math.min(160, Math.round(w / 9)));
    drops = Array.from({ length: count }, () => makeDrop(true));
  }

  function makeDrop(anywhere) {
    const depth = Math.random();            // 0 = far, 1 = near
    return {
      x: Math.random() * (w + 120) - 60,
      y: anywhere ? Math.random() * h : -20 - Math.random() * 80,
      len: 8 + depth * 16,
      speed: 380 + depth * 520,             // pixels per second
      alpha: 0.12 + depth * 0.2,
      width: 0.8 + depth * 0.8
    };
  }

  const SLANT = 0.22; // horizontal drift per vertical pixel

  function draw(ts) {
    raf = requestAnimationFrame(draw);
    const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
    last = ts;
    g.clearRect(0, 0, w, h);

    if (bolt) {
      const age = (ts - bolt.t0) / 700;
      if (age >= 1) bolt = null;
      else {
        g.save();
        g.strokeStyle = `rgba(110,130,215,${0.45 * (1 - age)})`;
        g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
        g.shadowColor = `rgba(150,170,255,${0.6 * (1 - age)})`; g.shadowBlur = 14;
        for (const path of bolt.paths) {
          g.beginPath();
          path.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
          g.stroke();
        }
        g.restore();
      }
    }

    for (const d of drops) {
      d.y += d.speed * dt;
      d.x += d.speed * dt * SLANT;
      if (d.y > h + 20 || d.x > w + 80) Object.assign(d, makeDrop(false));
      g.strokeStyle = `rgba(70,110,175,${d.alpha})`;
      g.lineWidth = d.width;
      g.beginPath();
      g.moveTo(d.x, d.y);
      g.lineTo(d.x - d.len * SLANT, d.y - d.len);
      g.stroke();
    }
  }

  function makeBolt() {
    const x0 = w * (0.1 + Math.random() * 0.8);
    const paths = [];
    function branch(x, y, steps, spread) {
      const pts = [[x, y]];
      for (let i = 0; i < steps; i++) {
        x += (Math.random() - 0.5) * spread; y += h * (0.5 / steps) * (0.7 + Math.random() * 0.6);
        pts.push([x, y]);
      }
      return pts;
    }
    const main = branch(x0, 0, 9, 90);
    paths.push(main);
    const b = main[3 + Math.floor(Math.random() * 3)];
    paths.push(branch(b[0], b[1], 4, 80));
    return paths;
  }

  // Gentle double pulse: two soft fades, about 0.6 s in total. Never rapid flashing.
  function pulse(opacity, ms) {
    flash.style.transition = 'none';
    flash.style.opacity = String(opacity);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      flash.style.transition = `opacity ${ms}ms ease-out`;
      flash.style.opacity = '0';
    }));
  }

  function lightning() {
    if (!rainOn || reduced || document.hidden) return;
    bolt = { t0: performance.now(), paths: makeBolt() };
    pulse(0.26, 280);
    setTimeout(() => pulse(0.16, 380), 340);
  }

  let timer = 0;
  function scheduleLightning(first) {
    clearTimeout(timer);
    const wait = first ? 5000 + Math.random() * 4000 : 20000 + Math.random() * 25000;
    timer = setTimeout(() => { lightning(); scheduleLightning(false); }, wait);
  }

  function start() {
    canvas.hidden = false;
    if (!raf) { last = 0; raf = requestAnimationFrame(draw); }
    scheduleLightning(true);
  }
  function stop() {
    canvas.hidden = true;
    cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); bolt = null;
    g.clearRect(0, 0, w, h);
  }

  // One small control, bottom right, so anyone can turn the effect off.
  const rainBtn = document.createElement('button');
  function paint() {
    rainBtn.textContent = rainOn ? 'Rain: on' : 'Rain: off';
    rainBtn.setAttribute('aria-pressed', String(rainOn));
  }
  rainBtn.type = 'button';
  rainBtn.addEventListener('click', () => {
    rainOn = !rainOn; save('rain-effect', rainOn);
    if (rainOn) start(); else stop();
    paint();
  });
  const controls = document.createElement('div');
  controls.className = 'rain-controls no-print';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Background effect');
  controls.append(rainBtn);
  document.body.append(controls);

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { last = 0; });
  resize(); paint();
  if (rainOn) start(); else canvas.hidden = true;

  window.rainEffect = { lightning }; // lets the college test the flash from the browser console
})();
