#!/usr/bin/env node
// Genera le grafiche del profilo (assets/*.svg) e la lista dei progetti nel README
// a partire dai repository pubblici di GitHub. Nessuna dipendenza: solo Node >= 20.
//
//   node scripts/build.mjs                   # usa l'API di GitHub (GITHUB_TOKEN opzionale)
//   node scripts/build.mjs --data repos.json # usa un file locale (per test offline)

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const USER = 'davvoz';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const README = path.join(ROOT, 'README.md');

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  bg: '#0b0e14',
  panel: '#121722',
  panel2: '#181e2b',
  line: '#242c3b',
  text: '#e6edf3',
  muted: '#7d8590',
  rec: '#ff4d6d',
  amber: '#ffb454',
};
const MONO = "'JetBrains Mono','Fira Code',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const SANS = "ui-sans-serif,-apple-system,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";

// ─── Tracce della Session View ────────────────────────────────────────────────
const TRACKS = [
  { id: 'audio', label: 'AUDIO', emoji: '🎛️', color: '#ff7849', re: /daw|audio|synth|seq|beat|piano|mixer|dsp|sound|music|ableton|midi|recorder/i },
  { id: 'games', label: 'GAMES', emoji: '🕹️', color: '#3ddc97', re: /game|arkanoid|cannone|tcg|monopol|space-station|life/i },
  { id: 'web3', label: 'WEB3', emoji: '⛓️', color: '#4cc9f0', re: /steem|hive|cur8|web3|faucet|crypto|chain/i },
  { id: 'gen', label: 'GENERATIVE', emoji: '✨', color: '#b388ff', re: /canvas|shape|poligon|knob|colonia|falling|fx|image|_ai|ai_|diffusion|deforum|emergent|clock/i },
];
// Assegnazioni esplicite: vincono sulle regex.
const OVERRIDES = {
  proprietaemergenti: 'gen',
  reality: 'gen',
  magic8: 'games',
  Ggameplatform: 'games',
  fantasygame: 'games',
  steemplatformgame2: 'games',
  provagame: 'games',
};
const SLOTS = 6;

// ─── Utility ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r2 = (n) => Math.round(n * 100) / 100;
const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const shortDate = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// PRNG deterministico: stesso input → stesso SVG, così l'Action committa solo quando cambia qualcosa.
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// Animazione "meter": altezza che rimbalza con picchi casuali ma riproducibili.
function meterAnim(rand, x, baseY, w, maxH, fill, dur) {
  const n = 14;
  const hs = Array.from({ length: n }, () => r2(maxH * (0.15 + 0.85 * Math.pow(rand(), 0.8))));
  hs.push(hs[0]);
  const ys = hs.map((h) => r2(baseY - h));
  return `<rect x="${x}" y="${ys[0]}" width="${w}" height="${hs[0]}" rx="1.5" fill="${fill}">
      <animate attributeName="height" values="${hs.join(';')}" dur="${dur}s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${ys.join(';')}" dur="${dur}s" repeatCount="indefinite"/>
    </rect>`;
}

// ─── Dati ─────────────────────────────────────────────────────────────────────
async function loadRepos() {
  const i = process.argv.indexOf('--data');
  if (i !== -1) return JSON.parse(await readFile(process.argv[i + 1], 'utf8'));

  const headers = { 'User-Agent': `${USER}-profile-builder`, Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`https://api.github.com/users/${USER}/repos?per_page=100&type=owner&sort=pushed&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function classify(repos) {
  const list = repos
    .filter((r) => !r.private && !r.fork && !r.archived && r.name !== USER)
    .map((r) => ({ ...r, when: r.pushed_at || r.updated_at }))
    .sort((a, b) => new Date(b.when) - new Date(a.when));

  const tracks = TRACKS.map((t) => ({ ...t, repos: [] }));
  for (const r of list) {
    const id = OVERRIDES[r.name] ?? TRACKS.find((t) => t.re.test(r.name))?.id;
    if (id) tracks.find((t) => t.id === id).repos.push(r);
  }
  const years = list.map((r) => new Date(r.created_at).getUTCFullYear());
  return {
    list,
    tracks,
    firstYear: Math.min(...years),
    lastYear: Math.max(...list.map((r) => new Date(r.when).getUTCFullYear())),
    stars: list.reduce((s, r) => s + (r.stargazers_count || 0), 0),
  };
}

// ─── HERO ─────────────────────────────────────────────────────────────────────
const PHRASES = [
  'faccio suonare il browser',
  'scrivo DAW per hobby (sì, davvero)',
  'insegno alle particelle a vivere',
  'costruisco giochi pixel per pixel',
  'metto le cose on-chain su Steem',
  'pair-programming con le AI dal 2022',
];

function wavePath(W, P, cy, amp, harm, phase) {
  let d = '';
  for (let x = 0; x <= W + P; x += 4) {
    const t = (2 * Math.PI * x) / P + phase;
    const y = cy + amp * (Math.sin(t) + harm[0] * Math.sin(2 * t + 1.3) + harm[1] * Math.sin(3 * t + 0.4));
    d += `${x === 0 ? 'M' : 'L'}${x} ${r2(y)}`;
  }
  return d;
}

function typewriter(x0, y, size, cw) {
  const TYPE = 0.055, HOLD = 1.6, ERASE = 0.02, GAP = 0.35;
  // timeline: [tempo, fraseAttiva, caratteriVisibili]
  const steps = [];
  let t = 0;
  PHRASES.forEach((p, i) => {
    for (let c = 0; c <= p.length; c++, t += TYPE) steps.push([t, i, c]);
    t += HOLD;
    for (let c = p.length - 1; c >= 0; c--, t += ERASE) steps.push([t, i, c]);
    t += GAP;
  });
  const T = t;
  const keyTimes = steps.map((s) => (s[0] / T).toFixed(5)).join(';');

  const texts = PHRASES.map((p, i) => {
    const widths = steps.map((s) => (s[1] === i ? r2(s[2] * cw) : 0)).join(';');
    return `<clipPath id="tw${i}"><rect x="${x0}" y="${y - size}" height="${size * 1.5}" width="0">
        <animate attributeName="width" values="${widths}" keyTimes="${keyTimes}" dur="${r2(T)}s" calcMode="discrete" repeatCount="indefinite"/>
      </rect></clipPath>
      <text x="${x0}" y="${y}" clip-path="url(#tw${i})" textLength="${r2(p.length * cw)}" lengthAdjust="spacingAndGlyphs"
        font-family="${MONO}" font-size="${size}" fill="${C.text}">${esc(p)}</text>`;
  });
  const cursorX = steps.map((s) => r2(x0 + s[2] * cw + 2)).join(';');
  const cursor = `<rect y="${y - size * 0.82}" width="${r2(cw * 0.55)}" height="${r2(size * 1.02)}" fill="${C.amber}" x="${x0}">
      <animate attributeName="x" values="${cursorX}" keyTimes="${keyTimes}" dur="${r2(T)}s" calcMode="discrete" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="1;0;1" dur="0.9s" calcMode="discrete" repeatCount="indefinite"/>
    </rect>`;
  return texts.join('\n') + cursor;
}

function knob(cx, cy, label, color, dur, rand) {
  const a = -135 + rand() * 60, b = 60 + rand() * 75;
  return `<g transform="translate(${cx} ${cy})">
      <circle r="30" fill="${C.panel2}" stroke="${C.line}" stroke-width="2"/>
      <circle r="38" fill="none" stroke="${C.line}" stroke-width="3" stroke-dasharray="179 60" transform="rotate(135)"/>
      <circle r="38" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="0 239" transform="rotate(135)">
        <animate attributeName="stroke-dasharray" values="40 239;150 239;90 239;170 239;40 239" dur="${dur}s" repeatCount="indefinite"/>
      </circle>
      <g><line y1="-8" y2="-24" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
        <animateTransform attributeName="transform" type="rotate" values="${r2(a)};${r2(b)};${r2(a + 50)};${r2(b + 20)};${r2(a)}" dur="${dur}s" repeatCount="indefinite"/>
      </g>
      <text y="62" text-anchor="middle" font-family="${MONO}" font-size="12" letter-spacing="2" fill="${C.muted}">${label}</text>
    </g>`;
}

function hero(data) {
  const W = 1200, H = 360;
  const rand = rng('hero');
  const waves = [
    { P: 300, cy: 290, amp: 16, harm: [0.35, 0.15], color: TRACKS[0].color, dur: 5, ph: 0 },
    { P: 200, cy: 292, amp: 10, harm: [0.1, 0.4], color: TRACKS[2].color, dur: 3.5, ph: 1.2 },
    { P: 400, cy: 288, amp: 22, harm: [0.5, 0.05], color: TRACKS[3].color, dur: 8, ph: 2.1 },
  ];
  const grid = [];
  for (let x = 50; x < W; x += 50) grid.push(`<line x1="${x}" y1="240" x2="${x}" y2="340" />`);
  for (const y of [265, 290, 315]) grid.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" />`);

  const cw = 13.2; // larghezza carattere mono a 22px
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="davvoz — codice, suono, giochi e GPU">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f1320"/><stop offset="1" stop-color="${C.bg}"/>
    </linearGradient>
    <radialGradient id="spot" cx="0.18" cy="0.2" r="0.7">
      <stop offset="0" stop-color="#ff7849" stop-opacity="0.16"/><stop offset="1" stop-color="#ff7849" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="name" x1="0" y1="0" x2="0.75" y2="0" spreadMethod="reflect">
      <stop offset="0" stop-color="${TRACKS[0].color}"/>
      <stop offset="0.35" stop-color="${C.amber}"/>
      <stop offset="0.7" stop-color="${TRACKS[3].color}"/>
      <stop offset="1" stop-color="${TRACKS[2].color}"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="1.5 0" dur="10s" repeatCount="indefinite"/>
    </linearGradient>
    <clipPath id="hero-frame"><rect width="${W}" height="${H}" rx="18"/></clipPath>
    <clipPath id="scope"><rect x="0" y="240" width="${W}" height="100"/></clipPath>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.12" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.88" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="edges"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
    <filter id="glow" x="-10%" y="-50%" width="120%" height="200%">
      <feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <g clip-path="url(#hero-frame)">
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#spot)"/>

    <!-- barra superiore -->
    <g font-family="${MONO}" font-size="13" letter-spacing="2">
      <circle cx="56" cy="44" r="6" fill="${C.rec}">
        <animate attributeName="opacity" values="1;0.15;1" dur="1.6s" repeatCount="indefinite"/>
      </circle>
      <text x="72" y="49" fill="${C.rec}">REC</text>
      <text x="124" y="49" fill="${C.muted}">SESSION ${data.firstYear} → ${data.lastYear} · ${data.list.length} TRACCE · ★ ${data.stars}</text>
    </g>

    <!-- nome + tagline -->
    <text x="48" y="150" font-family="${SANS}" font-size="96" font-weight="800" letter-spacing="-3" fill="url(#name)">davvoz</text>
    <text x="52" y="194" font-family="${MONO}" font-size="22" fill="${C.amber}">&gt;</text>
    ${typewriter(80, 194, 22, cw)}

    <!-- manopole -->
    ${knob(880, 110, 'CODE', TRACKS[2].color, 7, rand)}
    ${knob(990, 110, 'SOUND', TRACKS[0].color, 5.5, rand)}
    ${knob(1100, 110, 'PLAY', TRACKS[1].color, 8.5, rand)}

    <!-- oscilloscopio -->
    <rect x="0" y="240" width="${W}" height="100" fill="#07090e" opacity="0.55"/>
    <g stroke="${C.line}" stroke-width="1" opacity="0.6">${grid.join('')}</g>
    <g clip-path="url(#scope)" mask="url(#edges)" filter="url(#glow)" fill="none" stroke-width="2.2" stroke-linejoin="round">
      ${waves
        .map(
          (w) => `<path d="${wavePath(W, w.P, w.cy, w.amp, w.harm, w.ph)}" stroke="${w.color}" opacity="0.9">
        <animateTransform attributeName="transform" type="translate" from="0 0" to="-${w.P} 0" dur="${w.dur}s" repeatCount="indefinite"/>
      </path>`,
        )
        .join('\n      ')}
    </g>
    <line x1="0" y1="240" x2="${W}" y2="240" stroke="${C.line}"/>
  </g>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="none" stroke="${C.line}"/>
</svg>
`;
}

// ─── SESSION VIEW ─────────────────────────────────────────────────────────────
function session(data) {
  const W = 1200, PAD = 24, GAP = 16;
  const colW = (W - PAD * 2 - GAP * 3) / 4;
  const TOP = 64, HEAD = 36, CLIP = 44, CGAP = 8;
  const clipsTop = TOP + 16 + HEAD + 10;
  const metersTop = clipsTop + SLOTS * (CLIP + CGAP) + 10;
  const METER_H = 70;
  const H = metersTop + METER_H + 44;
  const rand = rng('session:' + data.tracks.map((t) => t.repos.length).join(','));
  const maxChars = Math.floor((colW - 44) / 7.9);

  const latest = data.list.find((r) => data.tracks.some((t) => t.repos.includes(r)));
  const latestTrack = data.tracks.find((t) => t.repos.includes(latest));

  const cols = data.tracks.map((t, ti) => {
    const x = PAD + ti * (colW + GAP);
    const out = [];
    // intestazione traccia
    out.push(`<rect x="${x}" y="${TOP + 16}" width="${colW}" height="${HEAD}" rx="6" fill="${t.color}"/>
      <text x="${x + 14}" y="${TOP + 16 + 23}" font-family="${MONO}" font-size="13" font-weight="700" letter-spacing="2" fill="${C.bg}">${t.label}</text>
      <text x="${x + colW - 14}" y="${TOP + 16 + 23}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.bg}" opacity="0.75">${t.repos.length} clip</text>`);

    for (let s = 0; s < SLOTS; s++) {
      const y = clipsTop + s * (CLIP + CGAP);
      const r = t.repos[s];
      if (!r) {
        out.push(`<rect x="${x}" y="${y}" width="${colW}" height="${CLIP}" rx="5" fill="${C.panel}" stroke="${C.line}"/>
      <rect x="${x + 14}" y="${y + CLIP / 2 - 5}" width="10" height="10" rx="1" fill="none" stroke="${C.line}" stroke-width="1.5"/>`);
        continue;
      }
      const playing = s === 0;
      const meta = `${r.language ?? '—'} · ${shortDate(r.when)}${r.stargazers_count ? ` · ★${r.stargazers_count}` : ''}`;
      if (playing) {
        const dur = r2(3 + rand() * 3);
        out.push(`<rect x="${x}" y="${y}" width="${colW}" height="${CLIP}" rx="5" fill="${t.color}"/>
      <rect x="${x}" y="${y + CLIP - 4}" width="0" height="4" fill="${C.bg}" opacity="0.35">
        <animate attributeName="width" values="0;${colW}" dur="${dur}s" repeatCount="indefinite"/>
      </rect>
      <path d="M${x + 14} ${y + 14}l11 8l-11 8z" fill="${C.bg}">
        <animate attributeName="opacity" values="1;0.25;1" dur="${r2(dur / 4)}s" repeatCount="indefinite"/>
      </path>
      <text x="${x + 34}" y="${y + 19}" font-family="${MONO}" font-size="13" font-weight="700" fill="${C.bg}">${esc(truncate(r.name, maxChars))}</text>
      <text x="${x + 34}" y="${y + 34}" font-family="${MONO}" font-size="10.5" fill="${C.bg}" opacity="0.7">${esc(meta)}</text>`);
      } else {
        out.push(`<rect x="${x}" y="${y}" width="${colW}" height="${CLIP}" rx="5" fill="${t.color}" fill-opacity="0.13" stroke="${t.color}" stroke-opacity="0.35"/>
      <path d="M${x + 14} ${y + 15}l10 7l-10 7z" fill="none" stroke="${t.color}" stroke-width="1.5" stroke-linejoin="round"/>
      <text x="${x + 34}" y="${y + 19}" font-family="${MONO}" font-size="13" fill="${C.text}">${esc(truncate(r.name, maxChars))}</text>
      <text x="${x + 34}" y="${y + 34}" font-family="${MONO}" font-size="10.5" fill="${C.muted}">${esc(meta)}</text>`);
      }
    }

    // meter + fader
    const base = metersTop + METER_H;
    out.push(`<rect x="${x}" y="${metersTop}" width="${colW}" height="${METER_H}" rx="6" fill="${C.panel}" stroke="${C.line}"/>`);
    for (let b = 0; b < 2; b++)
      out.push(meterAnim(rand, x + 16 + b * 12, base - 8, 8, METER_H - 16, `url(#meter${ti})`, r2(1.4 + rand() * 1.2)));
    const faderX = x + 64, faderW = colW - 64 - 16;
    const level = Math.min(1, 0.25 + t.repos.length / 25);
    out.push(`<rect x="${faderX}" y="${metersTop + METER_H / 2 - 2}" width="${faderW}" height="4" rx="2" fill="${C.line}"/>
      <rect x="${faderX}" y="${metersTop + METER_H / 2 - 2}" width="${r2(faderW * level)}" height="4" rx="2" fill="${t.color}"/>
      <rect x="${r2(faderX + faderW * level - 7)}" y="${metersTop + METER_H / 2 - 12}" width="14" height="24" rx="3" fill="${C.text}"/>
      <text x="${faderX}" y="${metersTop + 20}" font-family="${MONO}" font-size="10.5" letter-spacing="1" fill="${C.muted}">VOL · ${t.repos.length} repo</text>
      <text x="${faderX}" y="${metersTop + METER_H - 12}" font-family="${MONO}" font-size="10.5" letter-spacing="1" fill="${C.muted}">★ ${t.repos.reduce((s, r) => s + (r.stargazers_count || 0), 0)}</text>`);
    return out.join('\n      ');
  });

  const meterDefs = data.tracks
    .map(
      (t, i) => `<linearGradient id="meter${i}" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${t.color}"/><stop offset="0.75" stop-color="${C.amber}"/><stop offset="1" stop-color="${C.rec}"/>
    </linearGradient>`,
    )
    .join('\n    ');

  const bpm = data.list.length;
  const np = latest ? `${latest.name}` : '—';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Session view dei progetti di davvoz">
  <defs>
    ${meterDefs}
    <clipPath id="session-frame"><rect width="${W}" height="${H}" rx="18"/></clipPath>
  </defs>
  <g clip-path="url(#session-frame)">
    <rect width="${W}" height="${H}" fill="${C.bg}"/>

    <!-- transport -->
    <rect width="${W}" height="${TOP}" fill="${C.panel}"/>
    <line x1="0" y1="${TOP}" x2="${W}" y2="${TOP}" stroke="${C.line}"/>
    <g transform="translate(${PAD} 18)">
      <rect width="28" height="28" rx="5" fill="${C.panel2}" stroke="${C.line}"/>
      <path d="M10 8l11 6l-11 6z" fill="${TRACKS[1].color}"><animate attributeName="opacity" values="1;0.4;1" dur="1s" repeatCount="indefinite"/></path>
      <rect x="36" width="28" height="28" rx="5" fill="${C.panel2}" stroke="${C.line}"/>
      <rect x="45" y="9" width="10" height="10" fill="${C.muted}"/>
      <rect x="72" width="28" height="28" rx="5" fill="${C.panel2}" stroke="${C.line}"/>
      <circle cx="86" cy="14" r="5.5" fill="${C.rec}"/>
    </g>
    <g font-family="${MONO}">
      <rect x="140" y="18" width="92" height="28" rx="5" fill="${C.panel2}" stroke="${C.line}"/>
      <text x="186" y="37" text-anchor="middle" font-size="14" font-weight="700" fill="${C.amber}">${bpm}.00</text>
      <text x="242" y="30" font-size="10" letter-spacing="1.5" fill="${C.muted}">BPM</text>
      <text x="242" y="43" font-size="10" fill="${C.muted}" opacity="0.8">1 beat = 1 repo</text>

      <text x="${W - PAD}" y="30" text-anchor="end" font-size="10" letter-spacing="1.5" fill="${C.muted}">NOW PLAYING</text>
      <text x="${W - PAD}" y="46" text-anchor="end" font-size="14" font-weight="700" fill="${latestTrack?.color ?? C.text}">▶ ${esc(np)}</text>
    </g>
    <!-- timeline -->
    <g transform="translate(400 0)">
      <rect x="0" y="28" width="440" height="8" rx="4" fill="${C.panel2}" stroke="${C.line}"/>
      ${Array.from({ length: 9 }, (_, i) => `<line x1="${i * 55}" y1="22" x2="${i * 55}" y2="42" stroke="${C.line}"/>`).join('')}
      <rect x="0" y="28" width="0" height="8" rx="4" fill="${C.amber}" opacity="0.8">
        <animate attributeName="width" values="0;440" dur="8s" repeatCount="indefinite"/>
      </rect>
      <text x="0" y="56" font-family="${MONO}" font-size="10" fill="${C.muted}">${data.firstYear}</text>
      <text x="440" y="56" text-anchor="end" font-family="${MONO}" font-size="10" fill="${C.muted}">${data.lastYear}</text>
    </g>

    ${cols.join('\n    ')}

    <text x="${PAD}" y="${H - 16}" font-family="${MONO}" font-size="11" fill="${C.muted}">Ogni traccia mostra i ${SLOTS} repo con il push più recente · la clip in play è l'ultima toccata · generato da scripts/build.mjs</text>
  </g>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="none" stroke="${C.line}"/>
</svg>
`;
}

// ─── FOOTER (vinile) ──────────────────────────────────────────────────────────
function footer() {
  const W = 1200, H = 150, cx = 110, cy = 75;
  const grooves = [58, 52, 46, 40, 34].map((r) => `<circle r="${r}" fill="none" stroke="#1d2330" stroke-width="1.2"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grazie per l'ascolto">
  <defs>
    <linearGradient id="label" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${TRACKS[0].color}"/><stop offset="1" stop-color="${TRACKS[3].color}"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0.3" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.09"/><stop offset="0.7" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="${C.bg}" stroke="${C.line}"/>
  <g transform="translate(${cx} ${cy})">
    <g>
      <circle r="64" fill="#07090d"/>
      ${grooves}
      <circle r="24" fill="url(#label)"/>
      <text y="-6" text-anchor="middle" font-family="${MONO}" font-size="7" font-weight="700" fill="${C.bg}" letter-spacing="1">DAVVOZ</text>
      <text y="10" text-anchor="middle" font-family="${MONO}" font-size="6" fill="${C.bg}">LATO A</text>
      <circle r="3" fill="${C.bg}"/>
      <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1.8s" repeatCount="indefinite"/>
    </g>
    <circle r="64" fill="url(#shine)"/>
    <!-- braccio -->
    <g transform="translate(78 -58)">
      <circle r="7" fill="${C.panel2}" stroke="${C.line}" stroke-width="2"/>
      <path d="M0 0 L-8 72 L-26 88" fill="none" stroke="${C.muted}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="-34" y="84" width="14" height="8" rx="2" fill="${C.text}" transform="rotate(-40 -26 88)"/>
    </g>
  </g>
  <g font-family="${MONO}">
    <text x="240" y="66" font-size="22" font-weight="700" fill="${C.text}">Grazie per l'ascolto.</text>
    <text x="240" y="96" font-size="14" fill="${C.muted}">Il lato B è ancora in studio: commit in arrivo.</text>
  </g>
  <g transform="translate(${W - 230} 55)">
    ${Array.from({ length: 24 }, (_, i) => {
      const rand = rng('eq' + i);
      const hs = Array.from({ length: 8 }, () => r2(6 + rand() * 34));
      hs.push(hs[0]);
      const dur = r2(1.2 + rand());
      return `<rect x="${i * 8}" width="5" rx="1" fill="${TRACKS[i % 4].color}" opacity="0.85" y="${40 - hs[0]}" height="${hs[0]}">
      <animate attributeName="height" values="${hs.join(';')}" dur="${dur}s" repeatCount="indefinite"/>
      <animate attributeName="y" values="${hs.map((h) => r2(40 - h)).join(';')}" dur="${dur}s" repeatCount="indefinite"/>
    </rect>`;
    }).join('\n    ')}
  </g>
</svg>
`;
}

// ─── README: lista cliccabile ────────────────────────────────────────────────
function mixerMarkdown(data) {
  return data.tracks
    .map((t) => `**${t.emoji} ${t.label}** — ${t.repos.map((r) => `[${r.name}](${r.html_url})`).join(' · ')}`)
    .join('\n\n');
}

async function updateReadme(md) {
  const START = '<!-- MIXER:START -->', END = '<!-- MIXER:END -->';
  const src = await readFile(README, 'utf8');
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a === -1 || b === -1) return console.warn('README: marcatori MIXER non trovati, salto.');
  await writeFile(README, src.slice(0, a + START.length) + '\n\n' + md + '\n\n' + src.slice(b));
}

// ─── main ─────────────────────────────────────────────────────────────────────
const data = classify(await loadRepos());
await writeFile(path.join(ASSETS, 'hero.svg'), hero(data));
await writeFile(path.join(ASSETS, 'session.svg'), session(data));
await writeFile(path.join(ASSETS, 'footer.svg'), footer());
await updateReadme(mixerMarkdown(data));
console.log(
  `ok · ${data.list.length} repo · ` + data.tracks.map((t) => `${t.label}:${t.repos.length}`).join(' ') + ` · now playing: ${data.list[0]?.name}`,
);
