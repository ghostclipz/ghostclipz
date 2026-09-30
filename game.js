(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');

  const ui = {
    hud: $('hud'),
    score: $('score'),
    combo: $('combo'),
    charges: $('charges'),
    level: $('level'),
    menu: $('screen-menu'),
    pause: $('screen-pause'),
    over: $('screen-over'),
    menuBest: $('menu-best'),
    overScore: $('over-score'),
    overBest: $('over-best'),
    overStats: $('over-stats'),
    newRecord: $('new-record'),
    highscores: $('highscores'),
    btnMute: $('btn-mute'),
  };
  const pips = [...ui.charges.children];

  // ---------- Tuning ----------

  const CFG = {
    area: 420 * 640,     // every screen gets the same amount of logical play space
    ghostR: 13,
    echoR: 12,
    soulR: 8,
    speed: 250,
    clipTime: 4,         // seconds recorded per clip; also how often a new echo is born
    echoGrace: 0.8,      // a fresh echo is harmless while it materializes
    echoFade: 0.6,
    echoesStart: 4,      // echoes alive at once; the oldest fades when a new one exceeds this
    echoesMax: 12,
    levelTime: 20,
    dashTime: 0.2,
    dashSpeed: 820,
    dashAfter: 0.15,     // extra invulnerability after a dash
    chargesStart: 1,
    chargesMax: 3,
    soulsPerCharge: 3,
    comboWindow: 1.8,
    comboMax: 6,
    step: 1 / 60,        // fixed simulation step, so echoes replay exactly
    echoColors: ['#ff5d8f', '#ffb347', '#b388ff', '#7dff9a', '#6bb6ff', '#ff7df0', '#ffd84d', '#ff7d5d'],
  };

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

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

  // Scores from the old pillar game aren't comparable, so this mode keeps its own list.
  const SCORES_KEY = 'ghostclipz.echo.scores';
  let highscores = store.get(SCORES_KEY, []);
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
    noise(dur, { vol = 0.1, freq = 2000, delay = 0 } = {}) {
      if (this.muted || !this.ctx) return;
      const t0 = this.ctx.currentTime + delay;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      const gain = this.ctx.createGain();
      gain.gain.value = vol;
      src.connect(filter).connect(gain).connect(this.ctx.destination);
      src.start(t0);
    },
  };

  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
  const sfx = {
    soul: (combo) => audio.tone(660 * 2 ** (SCALE[clamp(combo, 1, 8) - 1] / 12), 0.14, { type: 'triangle', vol: 0.08 }),
    golden: () => [784, 988, 1319].forEach((f, i) => audio.tone(f, 0.14, { vol: 0.07, delay: i * 0.06 })),
    harvest: () => audio.tone(1250, 0.05, { vol: 0.025 }),
    clip: () => {
      audio.noise(0.04, { vol: 0.35, freq: 3200 });
      audio.noise(0.05, { vol: 0.25, freq: 1800, delay: 0.07 });
    },
    dash: () => {
      audio.noise(0.18, { vol: 0.2, freq: 700 });
      audio.tone(320, 0.18, { type: 'sine', vol: 0.06, to: 120 });
    },
    empty: () => audio.tone(140, 0.09, { type: 'square', vol: 0.03 }),
    kill: () => {
      audio.tone(900, 0.25, { type: 'square', vol: 0.04, to: 180 });
      audio.noise(0.2, { vol: 0.15, freq: 1200 });
    },
    level: () => [523, 659, 784, 1047].forEach((f, i) => audio.tone(f, 0.16, { type: 'triangle', vol: 0.06, delay: i * 0.08 })),
    die: () => audio.tone(360, 0.7, { type: 'sawtooth', vol: 0.05, to: 50 }),
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

  const view = { dpr: 1, scale: 1, W: 420, H: 640 };
  const arena = { x: 0, y: 0, w: 420, h: 640 };
  let motes = [];

  function resize() {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * view.dpr);
    canvas.height = Math.round(cssH * view.dpr);
    view.scale = Math.sqrt((cssW * cssH) / CFG.area);
    view.W = cssW / view.scale;
    view.H = cssH / view.scale;
    const pad = 12 / view.scale;
    arena.x = pad;
    arena.y = 84 / view.scale; // room for the HUD
    arena.w = view.W - pad * 2;
    arena.h = view.H - arena.y - pad;
    ghost.x = clamp(ghost.x, arena.x + CFG.ghostR, arena.x + arena.w - CFG.ghostR);
    ghost.y = clamp(ghost.y, arena.y + CFG.ghostR, arena.y + arena.h - CFG.ghostR);
    motes = Array.from({ length: 45 }, () => ({
      x: rand(0, view.W), y: rand(0, view.H), r: rand(0.6, 1.8),
      vx: rand(-6, 6), vy: rand(-12, -3), tw: rand(0, TAU),
    }));
  }

  // ---------- Game state ----------

  const game = {
    state: 'menu', // menu (attract demo) | play | pause | dead | over
    clock: 0,      // animation time, never reset
    time: 0,       // survived time this run
    score: 0,
    level: 1,
    levelTimer: 0,
    maxEchoes: CFG.echoesStart,
    clipTimer: CFG.clipTime,
    clipCount: 0,
    combo: 0,
    comboTimer: 0,
    charges: CFG.chargesStart,
    soulsToCharge: 0,
    echoKills: 0,
    shake: 0,
    flash: 0,
    deadTimer: 0,
  };
  const ghost = {
    x: 210, y: 320, vx: 0, vy: 0, dirX: 1, dirY: 0,
    dash: 0, dashX: 1, dashY: 0, invuln: 0, dead: false, spin: 0, trail: [],
  };
  let history = []; // the ghost's positions over the last clipTime seconds
  let echoes = [];
  let souls = [];
  let particles = [];
  let popups = [];

  const input = { keys: new Set(), mode: 'keys', pointer: null, mouse: null, target: null };

  function reset() {
    Object.assign(game, {
      time: 0, score: 0, level: 1, levelTimer: 0, maxEchoes: CFG.echoesStart,
      clipTimer: CFG.clipTime, clipCount: 0, combo: 0, comboTimer: 0,
      charges: CFG.chargesStart, soulsToCharge: 0, echoKills: 0, shake: 0, flash: 0, deadTimer: 0,
    });
    Object.assign(ghost, {
      x: arena.x + arena.w / 2, y: arena.y + arena.h / 2, vx: 0, vy: 0, dirX: 1, dirY: 0,
      dash: 0, invuln: 0, dead: false, spin: 0, trail: [],
    });
    history = [];
    echoes = [];
    souls = [];
    particles = [];
    popups = [];
    input.pointer = null;
    input.target = null;
    for (const k of Object.keys(hudCache)) delete hudCache[k];
    updateHud();
  }

  const isLethal = (e) => e.fading === null && !e.killed && e.age > CFG.echoGrace;

  function spawnSoul(x, y, golden = Math.random() < 0.1) {
    if (x === undefined) {
      const m = 24;
      for (let i = 0; i < 25; i++) {
        x = rand(arena.x + m, arena.x + arena.w - m);
        y = rand(arena.y + m, arena.y + arena.h - m);
        const farFromGhost = Math.hypot(x - ghost.x, y - ghost.y) > 90;
        const clearOfEchoes = echoes.every((e) => Math.hypot(x - e.x, y - e.y) > 50);
        if (farFromGhost && clearOfEchoes) break;
      }
    }
    souls.push({ x, y, t: rand(0, TAU), born: 0, golden, gone: false });
  }

  function spawnEcho(demo) {
    if (history.length < 20) return;
    const color = CFG.echoColors[game.clipCount % CFG.echoColors.length];
    game.clipCount++;
    const path = history.slice();
    echoes.push({
      path, pos: 0, dir: 1, age: 0, fading: null, killed: false, color,
      rate: demo ? 1 : Math.min(1.5, 1 + (game.level - 1) * 0.06),
      x: path[0].x, y: path[0].y, lookX: 0, lookY: 0,
    });
    const alive = echoes.filter((e) => e.fading === null);
    const cap = demo ? 5 : game.maxEchoes;
    if (alive.length > cap) alive[0].fading = CFG.echoFade;
    if (demo) return;
    sfx.clip();
    game.flash = Math.max(game.flash, 0.12);
    popup(ghost.x, ghost.y - 34, 'CLIP!', CFG.echoColors[(game.clipCount - 1) % CFG.echoColors.length], 0.7, 16);
    burst(path[0].x, path[0].y, color, 16, 140);
  }

  // ---------- Actions ----------

  function burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const v = rand(0.3, 1) * speed;
      const life = rand(0.35, 0.8);
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, size: rand(1.5, 4), color });
    }
  }

  function popup(x, y, text, color, life = 0.8, size = 18) {
    popups.push({ x, y, text, color, life, max: life, size });
  }

  function tryDash() {
    if (game.state !== 'play' || ghost.dash > 0) return;
    if (game.charges <= 0) {
      sfx.empty();
      popup(ghost.x, ghost.y - 30, 'keine Ladung', '#b3a8d9', 0.6, 13);
      return;
    }
    let dx = ghost.dirX;
    let dy = ghost.dirY;
    if (input.mode === 'mouse' && input.mouse) {
      const ax = input.mouse.x - ghost.x;
      const ay = input.mouse.y - ghost.y;
      const d = Math.hypot(ax, ay);
      if (d > 20) {
        dx = ax / d;
        dy = ay / d;
      }
    }
    game.charges--;
    ghost.dash = CFG.dashTime;
    ghost.dashX = dx;
    ghost.dashY = dy;
    ghost.invuln = CFG.dashTime + CFG.dashAfter;
    sfx.dash();
    burst(ghost.x, ghost.y, '#ff8ad8', 10, 120);
  }

  function collectSoul(s) {
    game.combo = game.comboTimer > 0 ? Math.min(CFG.comboMax, game.combo + 1) : 1;
    game.comboTimer = CFG.comboWindow;
    const pts = (s.golden ? 50 : 10) * game.combo;
    game.score += pts;
    if (s.golden) {
      game.charges = Math.min(CFG.chargesMax, game.charges + 1);
      sfx.golden();
    } else {
      sfx.soul(game.combo);
    }
    game.soulsToCharge++;
    if (game.soulsToCharge >= CFG.soulsPerCharge) {
      game.soulsToCharge = 0;
      if (game.charges < CFG.chargesMax) {
        game.charges++;
        popup(ghost.x, ghost.y + 34, '+1 Dash', '#ff8ad8', 0.8, 13);
      }
    }
    const color = s.golden ? '#ffd84d' : '#7df9ff';
    burst(s.x, s.y, color, 12, 150);
    popup(s.x, s.y - 16, game.combo > 1 ? `+${pts} x${game.combo}` : `+${pts}`, color);
  }

  function harvestSoul(s, e) {
    game.score += 5;
    sfx.harvest();
    burst(s.x, s.y, e.color, 8, 90);
    popup(s.x, s.y - 14, '+5', e.color, 0.6, 13);
  }

  function killEcho(e) {
    e.killed = true;
    game.echoKills++;
    const pts = 30 * Math.max(1, game.combo);
    game.score += pts;
    sfx.kill();
    game.shake = reduceMotion ? 0 : Math.max(game.shake, 5);
    burst(e.x, e.y, e.color, 26, 240);
    popup(e.x, e.y - 20, `ECHO WEG +${pts}`, e.color, 0.9, 15);
    spawnSoul(e.x, e.y, Math.random() < 0.25);
  }

  function die() {
    game.state = 'dead';
    game.deadTimer = 1.1;
    game.shake = reduceMotion ? 0 : 12;
    game.flash = 0.5;
    ghost.dead = true;
    ghost.dash = 0;
    sfx.die();
    burst(ghost.x, ghost.y, '#f4f0ff', 36, 280);
    input.pointer = null;
    if (navigator.vibrate) {
      try { navigator.vibrate(90); } catch { /* not allowed */ }
    }
  }

  // ---------- Screens ----------

  function showScreen(el) {
    for (const s of [ui.menu, ui.pause, ui.over]) s.classList.toggle('hidden', s !== el);
  }

  function blurActive() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function startGame() {
    audio.unlock();
    reset();
    game.state = 'play';
    showScreen(null);
    ui.hud.classList.remove('hidden');
    blurActive();
    const hint = coarsePointer ? 'Ziehen = bewegen · Tippen = Dash' : 'Maus / WASD = bewegen · Klick / Leertaste = Dash';
    popup(arena.x + arena.w / 2, arena.y + arena.h * 0.72, hint, '#f4f0ff', 3, 14);
  }

  function pauseGame() {
    if (game.state !== 'play') return;
    game.state = 'pause';
    input.keys.clear();
    input.pointer = null;
    showScreen(ui.pause);
    ui.pause.querySelector('.btn.primary').focus({ preventScroll: true });
  }

  function resumeGame() {
    if (game.state !== 'pause') return;
    game.state = 'play';
    showScreen(null);
    blurActive();
  }

  function toMenu() {
    reset();
    game.state = 'menu';
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
      store.set(SCORES_KEY, highscores);
    }
    ui.overScore.textContent = game.score;
    ui.overBest.textContent = best();
    ui.overStats.textContent =
      `${Math.floor(game.time)} s überlebt · Level ${game.level} · ${game.echoKills} ${game.echoKills === 1 ? 'Echo' : 'Echos'} zerstört`;
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

  const hudCache = {};
  function setHud(key, value, apply) {
    if (hudCache[key] === value) return;
    hudCache[key] = value;
    apply(value);
  }

  function updateHud() {
    setHud('score', game.score, (v) => { ui.score.textContent = v; });
    setHud('combo', game.combo >= 2 ? game.combo : 0, (v) => {
      ui.combo.textContent = v ? `x${v} Combo` : '';
      ui.combo.classList.toggle('show', v > 0);
    });
    setHud('charges', game.charges, (v) => pips.forEach((p, i) => p.classList.toggle('on', i < v)));
    setHud('level', game.level, (v) => { ui.level.textContent = `Level ${v}`; });
  }

  // ---------- Simulation ----------

  function desiredVelocity(demo) {
    let tx;
    let ty;
    if (demo) {
      const t = game.clock;
      tx = arena.x + arena.w * (0.5 + 0.34 * Math.sin(t * 0.7));
      ty = arena.y + arena.h * (0.5 + 0.32 * Math.sin(t * 1.13 + 1));
    } else if (input.mode === 'keys') {
      const k = input.keys;
      const mx = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
      const my = (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0) - (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0);
      const len = Math.hypot(mx, my);
      return len ? { x: (mx / len) * CFG.speed, y: (my / len) * CFG.speed } : { x: 0, y: 0 };
    } else {
      const t = input.mode === 'mouse' ? input.mouse : input.target;
      if (!t) return { x: 0, y: 0 };
      tx = t.x;
      ty = t.y;
    }
    const dx = tx - ghost.x;
    const dy = ty - ghost.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return { x: 0, y: 0 };
    const s = Math.min(CFG.speed, d * 10);
    return { x: (dx / d) * s, y: (dy / d) * s };
  }

  function moveGhost(h, demo) {
    const v = desiredVelocity(demo);
    const k = Math.min(1, h * 16);
    ghost.vx += (v.x - ghost.vx) * k;
    ghost.vy += (v.y - ghost.vy) * k;
    let sx = ghost.vx;
    let sy = ghost.vy;
    if (ghost.dash > 0) {
      ghost.dash -= h;
      sx = ghost.dashX * CFG.dashSpeed;
      sy = ghost.dashY * CFG.dashSpeed;
      ghost.trail.push({ x: ghost.x, y: ghost.y });
      if (ghost.trail.length > 10) ghost.trail.shift();
    } else if (ghost.trail.length) {
      ghost.trail.shift();
    }
    ghost.invuln = Math.max(0, ghost.invuln - h);
    const r = CFG.ghostR;
    ghost.x = clamp(ghost.x + sx * h, arena.x + r, arena.x + arena.w - r);
    ghost.y = clamp(ghost.y + sy * h, arena.y + r, arena.y + arena.h - r);
    const sp = Math.hypot(ghost.vx, ghost.vy);
    if (sp > 30) {
      ghost.dirX = ghost.vx / sp;
      ghost.dirY = ghost.vy / sp;
    }
  }

  function moveEchoes(h) {
    for (const e of echoes) {
      e.age += h;
      const last = e.path.length - 1;
      // Ping-pong along the recorded path so the echo never teleports.
      e.pos += e.dir * e.rate * (h / CFG.step);
      if (e.pos >= last) {
        e.pos = last - (e.pos - last);
        e.dir = -1;
      }
      if (e.pos <= 0) {
        e.pos = -e.pos;
        e.dir = 1;
      }
      e.pos = clamp(e.pos, 0, last);
      const i = Math.floor(e.pos);
      const f = e.pos - i;
      const a = e.path[i];
      const b = e.path[Math.min(last, i + 1)];
      const nx = a.x + (b.x - a.x) * f;
      const ny = a.y + (b.y - a.y) * f;
      const mv = Math.hypot(nx - e.x, ny - e.y);
      if (mv > 0.2) {
        e.lookX = (nx - e.x) / mv;
        e.lookY = (ny - e.y) / mv;
      }
      e.x = nx;
      e.y = ny;
      if (e.fading !== null) e.fading -= h;
    }
    echoes = echoes.filter((e) => !e.killed && (e.fading === null || e.fading > 0));
  }

  function updateEffects(h) {
    for (const p of particles) {
      p.x += p.vx * h;
      p.y += p.vy * h;
      p.vx *= 1 - h * 3;
      p.vy *= 1 - h * 3;
      p.life -= h;
    }
    particles = particles.filter((p) => p.life > 0);
    for (const p of popups) {
      p.y -= 30 * h;
      p.life -= h;
    }
    popups = popups.filter((p) => p.life > 0);
    for (const m of motes) {
      m.x += m.vx * h;
      m.y += m.vy * h;
      if (m.y < -5) m.y = view.H + 5;
      if (m.x < -5) m.x = view.W + 5;
      if (m.x > view.W + 5) m.x = -5;
    }
  }

  function step(h) {
    game.clock += h;
    game.shake = Math.max(0, game.shake - h * 30);
    game.flash = Math.max(0, game.flash - h * 2.5);
    updateEffects(h);

    if (game.state === 'over') {
      moveEchoes(h);
      return;
    }
    if (game.state === 'dead') {
      game.deadTimer -= h;
      ghost.spin += h * 9;
      moveEchoes(h);
      if (game.deadTimer <= 0) showGameOver();
      return;
    }

    const demo = game.state === 'menu';
    if (!demo) game.time += h;

    moveGhost(h, demo);
    history.push({ x: ghost.x, y: ghost.y });
    if (history.length > Math.round(CFG.clipTime / CFG.step)) history.shift();

    game.clipTimer -= h;
    if (game.clipTimer <= 0) {
      game.clipTimer += CFG.clipTime;
      spawnEcho(demo);
    }
    moveEchoes(h);

    const wantSouls = Math.min(7, 3 + Math.floor((game.level - 1) / 2));
    while (souls.filter((s) => !s.gone).length < wantSouls) spawnSoul();
    for (const s of souls) {
      s.t += h;
      s.born = Math.min(1, s.born + h * 3);
    }

    if (demo) return;

    if (game.comboTimer > 0) {
      game.comboTimer -= h;
      if (game.comboTimer <= 0) game.combo = 0;
    }

    // Souls: grabbed by you (points + combo) or by your echoes (small bonus).
    for (const s of souls) {
      if (Math.hypot(s.x - ghost.x, s.y - ghost.y) < CFG.ghostR + CFG.soulR + 2) {
        s.gone = true;
        collectSoul(s);
        continue;
      }
      const e = echoes.find((ec) => isLethal(ec) && Math.hypot(s.x - ec.x, s.y - ec.y) < CFG.echoR + CFG.soulR);
      if (e) {
        s.gone = true;
        harvestSoul(s, e);
      }
    }
    souls = souls.filter((s) => !s.gone);

    // Echoes: dash through them to destroy them, touch them otherwise and it's over.
    for (const e of echoes) {
      if (!isLethal(e)) continue;
      const d = Math.hypot(e.x - ghost.x, e.y - ghost.y);
      if (ghost.dash > 0 && d < CFG.ghostR + CFG.echoR + 4) {
        killEcho(e);
      } else if (ghost.invuln <= 0 && d < (CFG.ghostR + CFG.echoR) * 0.78) {
        die();
        return;
      }
    }

    game.levelTimer += h;
    if (game.levelTimer >= CFG.levelTime) {
      game.levelTimer -= CFG.levelTime;
      game.level++;
      game.maxEchoes = Math.min(CFG.echoesMax, CFG.echoesStart + game.level - 1);
      sfx.level();
      popup(arena.x + arena.w / 2, arena.y + arena.h * 0.3, `LEVEL ${game.level}`, '#ffd84d', 1.5, 34);
      popup(arena.x + arena.w / 2, arena.y + arena.h * 0.3 + 30, `bis zu ${game.maxEchoes} Echos`, '#b3a8d9', 1.5, 14);
    }
    updateHud();
  }

  // ---------- Render ----------

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function drawArena() {
    const { x, y, w, h } = arena;
    const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
    g.addColorStop(0, '#231b4a');
    g.addColorStop(1, '#120d28');
    ctx.fillStyle = g;
    roundRectPath(x, y, w, h, 18);
    ctx.fill();

    ctx.save();
    roundRectPath(x, y, w, h, 18);
    ctx.clip();
    // Faint floor tiles
    ctx.strokeStyle = 'rgba(180, 160, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const s = 44;
    for (let gx = x + (w % s) / 2; gx < x + w; gx += s) {
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
    }
    for (let gy = y + (h % s) / 2; gy < y + h; gy += s) {
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
    }
    ctx.stroke();
    // Drifting moonlight patch
    const lx = x + w * (0.5 + 0.2 * Math.sin(game.clock * 0.13));
    const ly = y + h * (0.4 + 0.15 * Math.cos(game.clock * 0.11));
    const light = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.min(w, h) * 0.6);
    light.addColorStop(0, 'rgba(160, 140, 255, 0.10)');
    light.addColorStop(1, 'rgba(160, 140, 255, 0)');
    ctx.fillStyle = light;
    ctx.fillRect(x, y, w, h);
    ctx.restore();

    ctx.save();
    ctx.shadowColor = 'rgba(125, 249, 255, 0.6)';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = 'rgba(125, 249, 255, 0.35)';
    ctx.lineWidth = 2;
    roundRectPath(x, y, w, h, 18);
    ctx.stroke();
    ctx.restore();
  }

  function drawMotes() {
    ctx.fillStyle = '#d9d0ff';
    for (const m of motes) {
      ctx.globalAlpha = 0.15 + 0.25 * (0.5 + 0.5 * Math.sin(game.clock * 1.5 + m.tw));
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawEchoPaths() {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 7]);
    ctx.lineCap = 'round';
    for (const e of echoes) {
      if (e.fading !== null) continue;
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = e.age < CFG.echoGrace ? 0.08 : 0.16;
      ctx.beginPath();
      ctx.moveTo(e.path[0].x, e.path[0].y);
      for (let i = 3; i < e.path.length; i += 3) ctx.lineTo(e.path[i].x, e.path[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSouls() {
    for (const s of souls) {
      const y = s.y + Math.sin(s.t * 3) * 3;
      const r = CFG.soulR * s.born * (s.golden ? 1.25 : 1);
      const c = s.golden ? '255, 216, 77' : '125, 249, 255';
      const g = ctx.createRadialGradient(s.x, y, 0.5, s.x, y, r * 2.8);
      g.addColorStop(0, 'rgba(255, 255, 255, 1)');
      g.addColorStop(0.3, `rgba(${c}, 0.9)`);
      g.addColorStop(1, `rgba(${c}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, y, r * 2.8, 0, TAU);
      ctx.fill();
      if (s.golden) {
        ctx.save();
        ctx.translate(s.x, y);
        ctx.rotate(s.t * 1.5);
        ctx.strokeStyle = 'rgba(255, 216, 77, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = (i * TAU) / 4;
          ctx.moveTo(Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4);
          ctx.lineTo(Math.cos(a) * r * 2.4, Math.sin(a) * r * 2.4);
        }
        ctx.stroke();
        ctx.restore();
      }
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
      ctx.quadraticCurveTo(x0 - ww / 2, bottom - r * 0.5, x0 - ww, bottom + Math.sin(t * 9 + i * 1.7) * r * 0.14);
    }
    ctx.closePath();
  }

  // Faces are drawn in a 17-unit ghost space and scaled to the ghost's radius.
  function drawGhost(x, y, o) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(o.tilt || 0);
    ctx.globalAlpha = o.alpha;
    if (o.glow) {
      ctx.shadowColor = o.glow;
      ctx.shadowBlur = 16;
    }
    ctx.fillStyle = o.fill;
    ghostPath(o.r, game.clock + (o.seed || 0));
    ctx.fill();
    ctx.shadowBlur = 0;
    if (!o.face) {
      ctx.restore();
      return;
    }
    const k = o.r / 17;
    ctx.scale(k, k);
    const lx = (o.lookX || 0) * 2.5;
    const ly = (o.lookY || 0) * 2;
    ctx.fillStyle = '#1b1433';
    if (o.face === 'dead') {
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
      ctx.beginPath();
      ctx.ellipse(0, 7, 2.4, 3, 0, 0, TAU);
      ctx.fill();
    } else if (o.face === 'echo') {
      ctx.fillStyle = 'rgba(10, 7, 24, 0.85)';
      for (const ex of [-6, 6]) {
        ctx.beginPath();
        ctx.ellipse(ex + lx, -3 + ly, 3.6, 5, 0, 0, TAU);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.ellipse(lx * 0.6, 7 + ly, 2.6, 3.4, 0, 0, TAU);
      ctx.fill();
    } else {
      const blink = game.clock % 3.2 > 3.05;
      for (const ex of [-6, 6]) {
        ctx.beginPath();
        ctx.ellipse(ex + lx, -3 + ly, 3.2, blink ? 0.6 : 4.4, 0, 0, TAU);
        ctx.fill();
      }
      if (!blink) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-7 + lx, -6 + ly, 1.6, 1.6);
        ctx.fillRect(5 + lx, -6 + ly, 1.6, 1.6);
      }
      ctx.fillStyle = 'rgba(255, 138, 216, 0.55)';
      for (const bx of [-11, 11]) {
        ctx.beginPath();
        ctx.ellipse(bx, 4, 3.5, 2, 0, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = '#1b1433';
      ctx.beginPath();
      if (o.open) ctx.ellipse(lx * 0.5, 6, 2.6, 3.2, 0, 0, TAU);
      else ctx.arc(lx * 0.5, 4, 3, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEchoes() {
    for (const e of echoes) {
      let alpha = 0.72;
      if (e.fading !== null) alpha = 0.72 * clamp(e.fading / CFG.echoFade, 0, 1);
      else if (e.age < CFG.echoGrace) alpha = 0.18 + 0.14 * Math.sin(game.clock * 30);
      drawGhost(e.x, e.y, {
        r: CFG.echoR, fill: e.color, alpha, glow: e.color, face: 'echo',
        lookX: e.lookX, lookY: e.lookY, seed: e.path.length + game.clipCount, tilt: e.lookX * 0.15,
      });
      if (e.age < CFG.echoGrace && e.fading === null) {
        // materializing ring
        ctx.save();
        ctx.strokeStyle = e.color;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.arc(e.x, e.y, CFG.echoR + 10 * (1 - e.age / CFG.echoGrace) + 4, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawPlayer() {
    const r = CFG.ghostR;
    ghost.trail.forEach((t, i) => {
      drawGhost(t.x, t.y, { r, fill: '#ff8ad8', alpha: ((i + 1) / ghost.trail.length) * 0.35 });
    });

    // Clip countdown ring: fills up until the next clip is recorded.
    if (!ghost.dead) {
      const frac = 1 - game.clipTimer / CFG.clipTime;
      const soon = game.clipTimer < 0.8;
      ctx.save();
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.arc(ghost.x, ghost.y + 2, r + 9, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = soon && Math.sin(game.clock * 30) > 0 ? '#ffffff' : '#ff5d8f';
      ctx.beginPath();
      ctx.arc(ghost.x, ghost.y + 2, r + 9, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
      ctx.stroke();
      if (soon) {
        ctx.fillStyle = '#ff5d8f';
        ctx.beginPath();
        ctx.arc(ghost.x - 11, ghost.y - r - 18, 3.5, 0, TAU);
        ctx.fill();
        ctx.font = '900 10px Nunito, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('REC', ghost.x - 5, ghost.y - r - 18);
      }
      ctx.restore();
    }

    let alpha = 1;
    if (ghost.invuln > 0 && ghost.dash <= 0) alpha = Math.sin(game.clock * 50) > 0 ? 0.9 : 0.4;
    drawGhost(ghost.x, ghost.y, {
      r, alpha,
      fill: ghost.dash > 0 ? '#ffe3f6' : '#f7f4ff',
      glow: ghost.dash > 0 ? '#ff8ad8' : 'rgba(200, 240, 255, 0.9)',
      face: ghost.dead ? 'dead' : 'normal',
      lookX: ghost.dirX, lookY: ghost.dirY,
      open: ghost.dash > 0,
      tilt: ghost.dead ? ghost.spin : clamp(ghost.vx / 1200, -0.25, 0.25),
    });
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
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#0a0718';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    const { dpr, scale, W, H } = view;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.fillStyle = '#0a0718';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    if (game.shake > 0) ctx.translate(rand(-1, 1) * game.shake, rand(-1, 1) * game.shake);
    drawArena();
    drawMotes();
    drawEchoPaths();
    drawSouls();
    drawEchoes();
    drawPlayer();
    drawEffects();
    ctx.restore();

    if (game.flash > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${game.flash * 0.45})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---------- Input ----------

  const TOUCH_GAIN = 1.4;
  const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);
  const isUiTarget = (t) => t instanceof Element && t.closest('button, .screen');
  const toWorld = (e) => ({ x: e.clientX / view.scale, y: e.clientY / view.scale });

  window.addEventListener('pointerdown', (e) => {
    if (isUiTarget(e.target)) return;
    audio.unlock();
    if (game.state !== 'play') return;
    e.preventDefault();
    if (e.pointerType === 'mouse') {
      input.mode = 'mouse';
      input.mouse = toWorld(e);
      tryDash();
      return;
    }
    if (input.pointer) {
      tryDash(); // second finger
      return;
    }
    input.mode = 'touch';
    input.pointer = { id: e.pointerId, sx: e.clientX, sy: e.clientY, gx: ghost.x, gy: ghost.y, t: performance.now(), moved: 0 };
    input.target = { x: ghost.x, y: ghost.y };
  }, { passive: false });

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) input.mode = 'mouse';
      input.mouse = toWorld(e);
      return;
    }
    const p = input.pointer;
    if (!p || p.id !== e.pointerId) return;
    // Relative drag: the finger never covers the ghost.
    const raw = {
      x: p.gx + ((e.clientX - p.sx) / view.scale) * TOUCH_GAIN,
      y: p.gy + ((e.clientY - p.sy) / view.scale) * TOUCH_GAIN,
    };
    const r = CFG.ghostR;
    const t = {
      x: clamp(raw.x, arena.x + r, arena.x + arena.w - r),
      y: clamp(raw.y, arena.y + r, arena.y + arena.h - r),
    };
    // Re-anchor when pushing past a wall so there is no dead zone on the way back.
    p.gx += t.x - raw.x;
    p.gy += t.y - raw.y;
    input.target = t;
    p.moved = Math.max(p.moved, Math.hypot(e.clientX - p.sx, e.clientY - p.sy));
  });

  const endPointer = (e) => {
    const p = input.pointer;
    if (!p || p.id !== e.pointerId) return;
    if (e.type === 'pointerup' && performance.now() - p.t < 220 && p.moved < 14) tryDash();
    input.pointer = null;
    input.target = null;
  };
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  window.addEventListener('keydown', (e) => {
    const k = e.code;
    const onButton = e.target instanceof HTMLButtonElement;
    if (MOVE_KEYS.has(k)) {
      e.preventDefault();
      input.keys.add(k);
      input.mode = 'keys';
    } else if (k === 'Space' || k === 'ShiftLeft' || k === 'ShiftRight') {
      if (onButton && k === 'Space') return; // let the focused button handle it natively
      e.preventDefault();
      if (e.repeat) return;
      if (game.state === 'play') tryDash();
      else if (k === 'Space' && (game.state === 'menu' || game.state === 'over')) startGame();
      else if (k === 'Space' && game.state === 'pause') resumeGame();
    } else if (k === 'Escape' || k === 'KeyP') {
      if (game.state === 'play') pauseGame();
      else if (game.state === 'pause') resumeGame();
    } else if (k === 'KeyM') {
      toggleMute();
    }
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.code));

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
  window.addEventListener('blur', () => {
    input.keys.clear();
    pauseGame();
  });
  window.addEventListener('resize', resize);

  // ---------- Loop ----------

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (game.state !== 'pause') {
      acc += dt;
      let n = 0;
      while (acc >= CFG.step && n < 8) {
        step(CFG.step);
        acc -= CFG.step;
        n++;
      }
      if (n === 8) acc = 0;
    }
    render();
    requestAnimationFrame(frame);
  }

  resize();
  reset();
  renderMuteButton();
  ui.menuBest.textContent = best();
  requestAnimationFrame(frame);

  // Handy for automated smoke tests; harmless for players.
  window.__ghostclipz = {
    game, ghost, input, CFG, arena, dash: tryDash,
    get echoes() { return echoes; },
    get souls() { return souls; },
  };
})();
