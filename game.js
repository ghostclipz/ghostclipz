(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');

  const ui = {
    hud: $('hud'),
    score: $('score'),
    meter: $('meter'),
    meterFill: $('meter-fill'),
    menu: $('screen-menu'),
    pause: $('screen-pause'),
    over: $('screen-over'),
    menuBest: $('menu-best'),
    overScore: $('over-score'),
    overBest: $('over-best'),
    newRecord: $('new-record'),
    highscores: $('highscores'),
    btnMute: $('btn-mute'),
  };

  // ---------- Tuning ----------

  const CFG = {
    baseH: 640,        // logical world height the view is scaled to
    minW: 360,         // narrowest logical world width (tall phones get a taller world instead)
    groundH: 70,
    gravity: 1700,
    flap: -520,
    maxFall: 760,
    ghostR: 17,
    speedStart: 210,
    speedMax: 360,
    speedStep: 5,      // per passed pillar
    gapStart: 210,
    gapMin: 150,
    gapStep: 3,
    spacing: 270,
    pillarW: 78,
    movingFrom: 8,     // pillars start to move after this many passes
    batsFrom: 12,
    orbsForPhase: 5,
    phaseTime: 4,
    deathDelay: 0.8,
  };

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const hash = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- Storage ----------

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // storage blocked (private mode etc.) – scores just won't persist
      }
    },
  };

  let highscores = store.get('ghostclipz.scores', []);
  if (!Array.isArray(highscores)) highscores = [];
  highscores = highscores.filter((h) => h && Number.isFinite(h.score) && Number.isFinite(h.date));
  const best = () => (highscores[0] ? highscores[0].score : 0);

  // ---------- Audio (tiny synth, no files) ----------

  const audio = {
    ctx: null,
    muted: store.get('ghostclipz.muted', false) === true,
    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, dur, { type = 'sine', vol = 0.1, to = null, delay = 0 } = {}) {
      if (this.muted || !this.ctx) return;
      const t0 = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
  };

  const sfx = {
    flap: () => audio.tone(420, 0.12, { vol: 0.07, to: 640 }),
    point: () => audio.tone(880, 0.07, { type: 'triangle', vol: 0.05 }),
    orb: () => {
      audio.tone(988, 0.1, { vol: 0.08 });
      audio.tone(1480, 0.16, { vol: 0.08, delay: 0.07 });
    },
    phase: () => audio.tone(220, 0.6, { type: 'sawtooth', vol: 0.04, to: 880 }),
    die: () => audio.tone(360, 0.6, { type: 'square', vol: 0.05, to: 60 }),
  };

  const ICON_SOUND_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_SOUND_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function renderMuteButton() {
    ui.btnMute.innerHTML = audio.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    ui.btnMute.setAttribute('aria-label', audio.muted ? 'Ton an' : 'Ton aus');
  }

  function toggleMute() {
    audio.muted = !audio.muted;
    store.set('ghostclipz.muted', audio.muted);
    renderMuteButton();
  }

  // ---------- View ----------

  const view = { dpr: 1, scale: 1, W: CFG.minW, H: CFG.baseH, ghostX: 100 };
  let stars = [];
  const groundY = () => view.H - CFG.groundH;

  function resize() {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * view.dpr);
    canvas.height = Math.round(cssH * view.dpr);
    view.scale = Math.min(cssH / CFG.baseH, cssW / CFG.minW);
    view.W = cssW / view.scale;
    view.H = cssH / view.scale;
    view.ghostX = clamp(view.W * 0.28, 70, 220);
    ghost.x = view.ghostX;
    stars = Array.from({ length: Math.round((view.W * view.H) / 3500) }, () => ({
      x: Math.random() * view.W,
      y: Math.random() * groundY() * 0.7,
      r: Math.random() * 1.4 + 0.4,
      tw: Math.random() * TAU,
    }));
  }

  // ---------- Game state ----------

  const game = {
    state: 'menu', // menu | play | pause | dead | over
    time: 0,
    score: 0,
    passed: 0,
    speed: CFG.speedStart,
    gap: CFG.gapStart,
    orbs: 0,       // collected towards the next ghost mode
    scroll: 0,     // total distance scrolled, drives parallax
    shake: 0,
    flash: 0,
    deadTimer: 0,
  };
  const ghost = { x: 100, y: 300, vy: 0, phase: 0, clearing: false, dead: false, spin: 0, trail: [] };
  let pillars = [];
  let orbs = [];
  let bats = [];
  let particles = [];
  let popups = [];

  function reset() {
    Object.assign(game, {
      time: 0, score: 0, passed: 0, speed: CFG.speedStart, gap: CFG.gapStart,
      orbs: 0, shake: 0, flash: 0, deadTimer: 0,
    });
    Object.assign(ghost, {
      x: view.ghostX, y: groundY() * 0.45, vy: 0, phase: 0, clearing: false, dead: false, spin: 0, trail: [],
    });
    pillars = [];
    orbs = [];
    bats = [];
    particles = [];
    popups = [];
    updateHud();
  }

  function gapBounds(gap) {
    const min = 60 + gap / 2;
    const max = groundY() - 40 - gap / 2;
    return [min, Math.max(min, max)];
  }

  function spawnPillar(x) {
    const prev = pillars[pillars.length - 1];
    const [min, max] = gapBounds(game.gap);
    let base = rand(min, max);
    if (prev) base = clamp(base, prev.base - 200, prev.base + 200);
    let amp = 0;
    if (game.passed >= CFG.movingFrom && Math.random() < 0.4) {
      amp = Math.min(55, (max - min) / 2);
      base = clamp(base, min + amp, max - amp);
    }
    pillars.push({
      x, base, gapY: base, gap: game.gap, amp,
      freq: rand(1.1, 1.8), ph: rand(0, TAU), t: 0,
      eyes: Math.random() < 0.35, passed: false,
    });

    // Something to grab (or dodge) in the open space before this pillar.
    if (!prev) return;
    const midX = (prev.x + CFG.pillarW + x) / 2;
    const midY = clamp((prev.base + base) / 2 + rand(-50, 50), 50, groundY() - 50);
    const batChance = game.passed >= CFG.batsFrom ? 0.3 : 0;
    const roll = Math.random();
    if (roll < batChance) {
      bats.push({ x: midX, base: midY, y: midY, t: rand(0, TAU) });
    } else if (roll < batChance + 0.45) {
      orbs.push({ x: midX, y: midY, t: rand(0, TAU), taken: false });
    }
  }

  function spawnInitialPillars() {
    let x = view.ghostX + 440;
    while (x < view.W + 40 + CFG.spacing) {
      spawnPillar(x);
      x += CFG.spacing;
    }
  }

  const orbY = (o) => o.y + Math.sin(o.t * 3) * 6;

  // ---------- Actions ----------

  function flap() {
    ghost.vy = CFG.flap;
    sfx.flap();
    for (let i = 0; i < 4; i++) {
      particles.push({
        x: ghost.x - 6, y: ghost.y + CFG.ghostR, vx: rand(-90, -30), vy: rand(20, 90),
        life: 0.4, max: 0.4, size: rand(1.5, 3.5), color: '#e9e4ff', g: 0,
      });
    }
  }

  function burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const v = rand(0.3, 1) * speed;
      const life = rand(0.4, 0.9);
      particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life, max: life, size: rand(2, 4.5), color, g: 1,
      });
    }
  }

  function popup(x, y, text, color, life = 0.8, size = 22) {
    popups.push({ x, y, text, color, life, max: life, size });
  }

  function addScore(n) {
    game.score += n;
  }

  function collectOrb(o) {
    o.taken = true;
    game.orbs = Math.min(CFG.orbsForPhase, game.orbs + 1);
    addScore(1);
    sfx.orb();
    burst(o.x, orbY(o), '#7df9ff', 14, 160);
    popup(o.x, orbY(o) - 20, '+1', '#7df9ff');
  }

  function startPhase() {
    game.orbs = 0;
    ghost.phase = CFG.phaseTime;
    game.flash = 0.6;
    sfx.phase();
    popup(view.W / 2, groundY() * 0.3, 'GEISTERMODUS!', '#ff8ad8', 1.6, 32);
    burst(ghost.x, ghost.y, '#ff8ad8', 24, 220);
  }

  function die() {
    game.state = 'dead';
    game.deadTimer = CFG.deathDelay;
    game.shake = reduceMotion ? 0 : 12;
    game.flash = 0.5;
    ghost.dead = true;
    ghost.phase = 0;
    ghost.vy = -300;
    sfx.die();
    burst(ghost.x, ghost.y, '#f4f0ff', 30, 260);
    if (navigator.vibrate) {
      try { navigator.vibrate(80); } catch { /* not allowed */ }
    }
  }

  // ---------- Screens ----------

  function showScreen(el) {
    for (const s of [ui.menu, ui.pause, ui.over]) s.classList.toggle('hidden', s !== el);
  }

  function startGame() {
    audio.unlock();
    reset();
    game.state = 'play';
    spawnInitialPillars();
    showScreen(null);
    ui.hud.classList.remove('hidden');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flap();
  }

  function pauseGame() {
    if (game.state !== 'play') return;
    game.state = 'pause';
    showScreen(ui.pause);
    ui.pause.querySelector('.btn.primary').focus({ preventScroll: true });
  }

  function resumeGame() {
    if (game.state !== 'pause') return;
    game.state = 'play';
    showScreen(null);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function toMenu() {
    game.state = 'menu';
    reset();
    ui.menuBest.textContent = best();
    ui.hud.classList.add('hidden');
    showScreen(ui.menu);
  }

  function showGameOver() {
    game.state = 'over';
    const isRecord = game.score > 0 && game.score > best();
    let entry = null;
    if (game.score > 0) {
      entry = { score: game.score, date: Date.now() };
      highscores.push(entry);
      highscores.sort((a, b) => b.score - a.score || a.date - b.date);
      highscores = highscores.slice(0, 5);
      store.set('ghostclipz.scores', highscores);
    }
    ui.overScore.textContent = game.score;
    ui.overBest.textContent = best();
    ui.newRecord.classList.toggle('hidden', !isRecord);
    renderHighscores(entry);
    ui.hud.classList.add('hidden');
    showScreen(ui.over);
    ui.over.querySelector('.btn.primary').focus({ preventScroll: true });
  }

  function renderHighscores(current) {
    const rows = highscores.map((h, i) => {
      const li = document.createElement('li');
      if (h === current) li.className = 'current';
      const cells = [
        [`${i + 1}.`, 'rank'],
        [String(h.score), 'pts'],
        [new Date(h.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }), 'date'],
      ];
      for (const [text, cls] of cells) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        li.append(span);
      }
      return li;
    });
    ui.highscores.replaceChildren(...rows);
    ui.highscores.classList.toggle('hidden', rows.length === 0);
  }

  const hudCache = { score: -1, meter: -1, active: null };
  function updateHud() {
    if (hudCache.score !== game.score) {
      ui.score.textContent = game.score;
      hudCache.score = game.score;
    }
    const active = ghost.phase > 0;
    const frac = active ? ghost.phase / CFG.phaseTime : game.orbs / CFG.orbsForPhase;
    const pct = Math.round(frac * 100);
    if (pct !== hudCache.meter) {
      ui.meterFill.style.width = `${pct}%`;
      hudCache.meter = pct;
    }
    if (active !== hudCache.active) {
      ui.meter.classList.toggle('active', active);
      hudCache.active = active;
    }
  }

  // ---------- Update ----------

  function circleRect(cx, cy, r, x, y, w, h) {
    const nx = clamp(cx, x, x + w);
    const ny = clamp(cy, y, y + h);
    return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
  }

  function hitsObstacle() {
    const r = CFG.ghostR * 0.8; // a little forgiving
    for (const p of pillars) {
      if (p.x > ghost.x + r || p.x + CFG.pillarW < ghost.x - r) continue;
      const top = p.gapY - p.gap / 2;
      const bottom = p.gapY + p.gap / 2;
      if (circleRect(ghost.x, ghost.y, r, p.x, -1000, CFG.pillarW, top + 1000)) return true;
      if (circleRect(ghost.x, ghost.y, r, p.x, bottom, CFG.pillarW, 1000)) return true;
    }
    for (const b of bats) {
      if (Math.hypot(b.x - ghost.x, b.y - ghost.y) < r + 12) return true;
    }
    return false;
  }

  function updateEffects(dt) {
    for (const p of particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * p.g * dt;
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);
    for (const p of popups) {
      p.y -= 40 * dt;
      p.life -= dt;
    }
    popups = popups.filter((p) => p.life > 0);
  }

  function update(dt) {
    game.time += dt;
    game.shake = Math.max(0, game.shake - dt * 30);
    game.flash = Math.max(0, game.flash - dt * 2.5);
    updateEffects(dt);

    if (game.state === 'menu') {
      game.scroll += 50 * dt;
      return;
    }
    if (game.state === 'over') return;

    if (game.state === 'dead') {
      game.deadTimer -= dt;
      ghost.spin += dt * 8;
      ghost.vy = Math.min(ghost.vy + CFG.gravity * dt, CFG.maxFall);
      ghost.y = Math.min(ghost.y + ghost.vy * dt, groundY() - CFG.ghostR);
      if (game.deadTimer <= 0) showGameOver();
      return;
    }

    if (game.state !== 'play') return;

    const move = game.speed * dt;
    game.scroll += move;

    // Ghost
    ghost.vy = Math.min(ghost.vy + CFG.gravity * dt, CFG.maxFall);
    ghost.y += ghost.vy * dt;
    if (ghost.y < CFG.ghostR) {
      ghost.y = CFG.ghostR;
      ghost.vy = Math.max(0, ghost.vy);
    }
    for (const t of ghost.trail) t.x -= move;
    ghost.trail.push({ x: ghost.x, y: ghost.y, vy: ghost.vy });
    if (ghost.trail.length > 7) ghost.trail.shift();

    // World
    for (const p of pillars) {
      p.x -= move;
      if (p.amp) {
        p.t += dt;
        p.gapY = p.base + Math.sin(p.t * p.freq + p.ph) * p.amp;
      }
      if (!p.passed && p.x + CFG.pillarW < ghost.x - CFG.ghostR) {
        p.passed = true;
        game.passed++;
        addScore(1);
        sfx.point();
        game.speed = Math.min(CFG.speedMax, game.speed + CFG.speedStep);
        game.gap = Math.max(CFG.gapMin, game.gap - CFG.gapStep);
      }
    }
    for (const o of orbs) {
      o.x -= move;
      o.t += dt;
      if (!o.taken && Math.hypot(o.x - ghost.x, orbY(o) - ghost.y) < CFG.ghostR + 14) collectOrb(o);
    }
    for (const b of bats) {
      b.x -= move;
      b.t += dt;
      b.y = b.base + Math.sin(b.t * 2.4) * 45;
    }

    pillars = pillars.filter((p) => p.x + CFG.pillarW > -20);
    orbs = orbs.filter((o) => o.x > -30 && !o.taken);
    bats = bats.filter((b) => b.x > -40);

    const last = pillars[pillars.length - 1];
    if (!last) spawnPillar(view.W + 40);
    else if (last.x < view.W + 40 - CFG.spacing) spawnPillar(last.x + CFG.spacing);

    // Collisions. After ghost mode ends inside a wall, keep passing until clear of it.
    const hit = hitsObstacle();
    if (ghost.phase > 0) {
      ghost.phase = Math.max(0, ghost.phase - dt);
      ghost.clearing = true;
    } else if (hit && !ghost.clearing) {
      die();
      return;
    } else if (!hit) {
      ghost.clearing = false;
    }
    if (ghost.y + CFG.ghostR * 0.8 > groundY()) {
      die();
      return;
    }

    if (ghost.phase <= 0 && game.orbs >= CFG.orbsForPhase) startPhase();
    updateHud();
  }

  // ---------- Render ----------

  function hillY(wx, base, amp) {
    return base - (Math.sin(wx * 0.004) * amp + Math.sin(wx * 0.011 + 1.3) * amp * 0.45);
  }

  function drawSky() {
    const { W, H } = view;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b0820');
    g.addColorStop(0.55, '#231a52');
    g.addColorStop(1, '#3d2a6e');
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, W + 40, H + 40);

    ctx.fillStyle = '#ffffff';
    for (const s of stars) {
      ctx.globalAlpha = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(game.time * 2 + s.tw));
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    const mx = W * 0.78;
    const my = Math.min(120, groundY() * 0.2);
    const mr = 42;
    const glow = ctx.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 3);
    glow.addColorStop(0, 'rgba(255, 244, 214, 0.32)');
    glow.addColorStop(1, 'rgba(255, 244, 214, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(mx, my, mr * 3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff4d6';
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(205, 185, 150, 0.45)';
    for (const [dx, dy, r] of [[-13, -8, 8], [14, 10, 6], [5, -18, 4], [-6, 16, 5]]) {
      ctx.beginPath();
      ctx.arc(mx + dx, my + dy, r, 0, TAU);
      ctx.fill();
    }
  }

  function drawHills(offset, base, amp, color, decor) {
    const { W, H } = view;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-20, H + 20);
    for (let x = -20; x <= W + 32; x += 12) ctx.lineTo(x, hillY(x + offset, base, amp));
    ctx.lineTo(W + 32, H + 20);
    ctx.fill();

    const step = decor === 'trees' ? 230 : 110;
    const first = Math.floor(offset / step) - 1;
    const lastI = Math.floor((offset + W) / step) + 1;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (let i = first; i <= lastI; i++) {
      if (hash(i) < 0.45) continue;
      const wx = i * step + hash(i + 0.5) * step * 0.5;
      const x = wx - offset;
      const y = hillY(wx, base, amp) + 4;
      const k = hash(i * 3.1);
      if (decor === 'trees') drawTree(x, y, 40 + k * 40, k);
      else if (k < 0.55) drawTomb(x, y, 14 + k * 10);
      else drawCross(x, y, 20 + k * 8);
    }
  }

  function drawTree(x, y, h, k) {
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 4, y - h);
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    const dir = k > 0.5 ? 1 : -1;
    ctx.moveTo(x + 2, y - h * 0.55);
    ctx.lineTo(x + 2 + dir * h * 0.4, y - h * 0.85);
    ctx.moveTo(x + 3, y - h * 0.75);
    ctx.lineTo(x + 3 - dir * h * 0.3, y - h * 1.05);
    ctx.moveTo(x + 4, y - h);
    ctx.lineTo(x + 4 + dir * h * 0.2, y - h * 1.2);
    ctx.stroke();
  }

  function drawTomb(x, y, h) {
    const w = h * 0.75;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y);
    ctx.lineTo(x - w / 2, y - h + w / 2);
    ctx.arc(x, y - h + w / 2, w / 2, Math.PI, 0);
    ctx.lineTo(x + w / 2, y);
    ctx.fill();
  }

  function drawCross(x, y, h) {
    ctx.fillRect(x - 2.5, y - h, 5, h);
    ctx.fillRect(x - 8, y - h * 0.72, 16, 5);
  }

  function drawFog(offset, y, alpha) {
    ctx.fillStyle = `rgba(200, 190, 255, ${alpha})`;
    const step = 220;
    for (let i = Math.floor(offset / step) - 1; i <= Math.floor((offset + view.W) / step) + 1; i++) {
      const x = i * step - offset + hash(i) * 80;
      ctx.beginPath();
      ctx.ellipse(x, y + hash(i + 2) * 20, 160, 26, 0, 0, TAU);
      ctx.fill();
    }
  }

  function drawColumn(x, y, w, h, capAtTop) {
    if (h <= 0) return;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#463c74');
    g.addColorStop(0.45, '#5b5091');
    g.addColorStop(1, '#30285a');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);

    // Bricks are anchored to the capped end so they move with moving gaps.
    const capH = 18;
    const bh = 22;
    const anchor = capAtTop ? y : y + h;
    const dir = capAtTop ? 1 : -1;
    ctx.strokeStyle = 'rgba(16, 11, 38, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; ; k++) {
      const ly = anchor + dir * (capH + k * bh);
      const ly2 = ly + dir * bh;
      if (dir > 0 ? ly > y + h : ly < y) break;
      ctx.moveTo(x, ly);
      ctx.lineTo(x + w, ly);
      const lo = Math.max(y, Math.min(ly, ly2));
      const hi = Math.min(y + h, Math.max(ly, ly2));
      if (hi <= lo) continue;
      const joints = k % 2 ? [w / 2] : [w / 4, (w * 3) / 4];
      for (const jx of joints) {
        ctx.moveTo(x + jx, lo);
        ctx.lineTo(x + jx, hi);
      }
    }
    ctx.stroke();

    // Cap
    const over = 6;
    const cy = capAtTop ? y : y + h - capH;
    ctx.fillStyle = '#6d62a6';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - over, cy, w + over * 2, capH, 4);
    else ctx.rect(x - over, cy, w + over * 2, capH);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(x - over + 2, capAtTop ? cy + 2 : cy + capH - 5, w + over * 2 - 4, 3);
  }

  function drawEyes(x, y, seed) {
    const blink = (game.time + seed * 5) % 4 > 3.85;
    ctx.save();
    ctx.shadowColor = '#ffb347';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ffcf6b';
    for (const dx of [-9, 9]) {
      ctx.beginPath();
      ctx.ellipse(x + dx, y, 4.5, blink ? 0.6 : 3.2, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawPillars() {
    const w = CFG.pillarW;
    const gy = groundY();
    ctx.globalAlpha = ghost.phase > 0 ? 0.5 : 1;
    for (const p of pillars) {
      const top = p.gapY - p.gap / 2;
      const bottom = p.gapY + p.gap / 2;
      drawColumn(p.x, -10, w, top + 10, false);
      drawColumn(p.x, bottom, w, gy - bottom, true);
      if (p.eyes && gy - bottom > 90) drawEyes(p.x + w / 2, bottom + 52, p.ph);
    }
    ctx.globalAlpha = 1;
  }

  function drawOrbs() {
    for (const o of orbs) {
      const y = orbY(o);
      const r = 10;
      const g = ctx.createRadialGradient(o.x, y, 1, o.x, y, r * 2.6);
      g.addColorStop(0, 'rgba(255, 255, 255, 1)');
      g.addColorStop(0.3, 'rgba(125, 249, 255, 0.9)');
      g.addColorStop(1, 'rgba(125, 249, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(o.x, y, r * 2.6, 0, TAU);
      ctx.fill();
    }
  }

  function drawBats() {
    for (const b of bats) {
      const f = Math.sin(b.t * 18);
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.fillStyle = '#1a1233';
      ctx.strokeStyle = 'rgba(255, 138, 216, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const s of [-1, 1]) {
        ctx.moveTo(0, -2);
        ctx.lineTo(s * 26, -6 - 10 * f);
        ctx.lineTo(s * 20, 4 - 4 * f);
        ctx.lineTo(s * 13, 1);
        ctx.lineTo(s * 8, 6);
        ctx.lineTo(0, 3);
      }
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, 1, 8, 9, 0, 0, TAU);
      ctx.moveTo(-6, -5);
      ctx.lineTo(-4, -13);
      ctx.lineTo(-1, -6);
      ctx.moveTo(6, -5);
      ctx.lineTo(4, -13);
      ctx.lineTo(1, -6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ff3b5c';
      ctx.fillRect(-4, -1, 2.5, 2.5);
      ctx.fillRect(1.5, -1, 2.5, 2.5);
      ctx.restore();
    }
  }

  function ghostPath(r, t) {
    const bottom = r * 1.05;
    ctx.beginPath();
    ctx.arc(0, -r * 0.15, r, Math.PI, 0);
    ctx.lineTo(r, bottom);
    const waves = 3;
    const ww = (2 * r) / waves;
    for (let i = 0; i < waves; i++) {
      const x0 = r - i * ww;
      ctx.quadraticCurveTo(x0 - ww / 2, bottom - 9, x0 - ww, bottom + Math.sin(t * 9 + i * 1.7) * 2.5);
    }
    ctx.closePath();
  }

  function drawGhostBody(alpha, tint) {
    const r = CFG.ghostR;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tint;
    ghostPath(r, game.time);
    ctx.fill();
  }

  function drawGhost() {
    if (game.state === 'menu') return;
    const phasing = ghost.phase > 0;
    const tiltOf = (vy) => clamp(vy / 900, -0.35, 0.5);

    if (phasing) {
      ghost.trail.forEach((t, i) => {
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.rotate(tiltOf(t.vy));
        drawGhostBody((i / ghost.trail.length) * 0.25, '#ff8ad8');
        ctx.restore();
      });
    }

    ctx.save();
    ctx.translate(ghost.x, ghost.y);
    ctx.rotate(ghost.dead ? ghost.spin : tiltOf(ghost.vy));
    let alpha = 1;
    if (phasing) alpha = ghost.phase < 1 && Math.sin(game.time * 40) > 0 ? 0.3 : 0.6;
    ctx.shadowColor = phasing ? '#ff8ad8' : 'rgba(200, 240, 255, 0.9)';
    ctx.shadowBlur = 18;
    drawGhostBody(alpha, phasing ? '#dffbff' : '#f7f4ff');
    ctx.shadowBlur = 0;

    // Face
    ctx.fillStyle = '#1b1433';
    if (ghost.dead) {
      ctx.strokeStyle = '#1b1433';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (const ex of [-6, 6]) {
        ctx.moveTo(ex - 3, -6);
        ctx.lineTo(ex + 3, 0);
        ctx.moveTo(ex + 3, -6);
        ctx.lineTo(ex - 3, 0);
      }
      ctx.stroke();
    } else {
      const blink = game.time % 3.2 > 3.05;
      for (const ex of [-6, 6]) {
        ctx.beginPath();
        ctx.ellipse(ex, -3, 3.2, blink ? 0.6 : 4.4, 0, 0, TAU);
        ctx.fill();
      }
      if (!blink) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-7, -6, 1.6, 1.6);
        ctx.fillRect(5, -6, 1.6, 1.6);
      }
    }
    ctx.fillStyle = 'rgba(255, 138, 216, 0.55)';
    for (const bx of [-11, 11]) {
      ctx.beginPath();
      ctx.ellipse(bx, 4, 3.5, 2, 0, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#1b1433';
    ctx.beginPath();
    if (ghost.dead || ghost.vy < -250) ctx.ellipse(0, 6, 2.4, 3, 0, 0, TAU);
    else ctx.arc(0, 4, 3, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawGround() {
    const gy = groundY();
    const { W, H } = view;
    ctx.fillStyle = '#0e0a20';
    ctx.fillRect(-20, gy, W + 40, H - gy + 20);
    ctx.fillStyle = '#2a1f4d';
    ctx.fillRect(-20, gy, W + 40, 5);
    ctx.fillStyle = '#3a2d66';
    const step = 18;
    const off = game.scroll;
    ctx.beginPath();
    for (let i = Math.floor(off / step) - 1; i <= Math.floor((off + W) / step) + 1; i++) {
      const x = i * step - off;
      const h = 4 + hash(i) * 9;
      ctx.moveTo(x, gy + 1);
      ctx.lineTo(x + 3, gy - h);
      ctx.lineTo(x + 6, gy + 1);
    }
    ctx.fill();
  }

  function drawEffects() {
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const p of popups) {
      ctx.globalAlpha = clamp((p.life / p.max) * 2, 0, 1);
      ctx.font = `900 ${p.size}px Nunito, system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#120d26';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    const { dpr, scale, W, H } = view;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    drawSky();

    ctx.save();
    if (game.shake > 0) ctx.translate(rand(-1, 1) * game.shake, rand(-1, 1) * game.shake);
    const gy = groundY();
    drawHills(game.scroll * 0.15, gy - 140, 30, '#1c1540', 'trees');
    drawFog(game.scroll * 0.3 + game.time * 8, gy - 70, 0.05);
    drawHills(game.scroll * 0.4, gy - 45, 16, '#140e2e', 'graves');
    drawPillars();
    drawOrbs();
    drawBats();
    drawGhost();
    drawGround();
    drawFog(game.scroll * 1.2 + game.time * 20, gy + 8, 0.07);
    drawEffects();
    ctx.restore();

    if (ghost.phase > 0) {
      ctx.fillStyle = `rgba(255, 138, 216, ${0.07 + 0.04 * Math.sin(game.time * 8)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (game.flash > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${game.flash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---------- Input ----------

  const isUiTarget = (t) => t instanceof Element && t.closest('button, .screen');

  window.addEventListener('pointerdown', (e) => {
    if (isUiTarget(e.target)) return;
    audio.unlock();
    if (game.state === 'play') {
      e.preventDefault();
      flap();
    }
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    const k = e.code;
    const onButton = e.target instanceof HTMLButtonElement;
    if (k === 'Space' || k === 'ArrowUp' || k === 'KeyW') {
      if (onButton) return; // let the focused button handle it natively
      e.preventDefault();
      if (e.repeat) return;
      if (game.state === 'play') flap();
      else if (game.state === 'menu' || game.state === 'over') startGame();
      else if (game.state === 'pause') resumeGame();
    } else if (k === 'Escape' || k === 'KeyP') {
      if (game.state === 'play') pauseGame();
      else if (game.state === 'pause') resumeGame();
    } else if (k === 'KeyM') {
      toggleMute();
    }
  });

  ui.menu.addEventListener('click', startGame);
  $('btn-retry').addEventListener('click', startGame);
  $('btn-menu').addEventListener('click', toMenu);
  $('btn-resume').addEventListener('click', resumeGame);
  $('btn-quit').addEventListener('click', toMenu);
  $('btn-pause').addEventListener('click', pauseGame);
  ui.btnMute.addEventListener('click', () => {
    audio.unlock();
    toggleMute();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseGame();
  });
  window.addEventListener('blur', pauseGame);
  window.addEventListener('resize', resize);

  // ---------- Loop ----------

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    if (game.state !== 'pause') update(dt);
    render();
    requestAnimationFrame(frame);
  }

  resize();
  reset();
  renderMuteButton();
  ui.menuBest.textContent = best();
  requestAnimationFrame(frame);

  // Handy for automated smoke tests; harmless for players.
  window.__ghostclipz = { game, ghost, CFG, get pillars() { return pillars; } };
})();
