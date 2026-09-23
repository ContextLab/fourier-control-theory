// Bootstrap: store wiring, tabs, theme toggle, single rAF loop, tutorial loader.
import { createStore, PALETTE } from './core/store.js';
import { preset } from './core/presets.js';
import { lowpass, fromCoeff } from './core/fourier.js';
import { createArmView } from './ui/armView.js';
import { createSpectrumView } from './ui/spectrumView.js';
import { createEditor } from './ui/editor.js';
import { createDrawView } from './ui/drawView.js';
import { createJointPlot } from './ui/jointPlot.js';

// ---------- Theme ----------

function readStoredTheme() {
  try {
    return localStorage.getItem('theme');
  } catch (err) {
    return null;
  }
}

function storeTheme(theme) {
  try {
    localStorage.setItem('theme', theme);
  } catch (err) {
    /* ignore (private browsing / disabled storage) */
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
}

let currentTheme = readStoredTheme() || 'dark';
applyTheme(currentTheme);

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(currentTheme);
    storeTheme(currentTheme);
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: currentTheme } }));
  });
}

// ---------- Store ----------

// store.js assigns ids + palette colors to every component (withIds runs on
// the initial merge, setComponents, updateComponent and addComponent), so
// callers can hand it raw preset()/DFT output directly.
const store = createStore({
  components: preset('arm'),
  t: 0,
  playing: true,
  speed: 1,
  mode: 'arm',
  selectedId: null,
  yScale: 'amp',
  showCircles: true,
  showSkin: true,
  K: 50,
  bandwidth: 8,
  drawing: { raw: [], coeffs: [], active: false },
});

// ---------- Tabs ----------

const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
const panels = Array.from(document.querySelectorAll('.tab-panel'));

function syncTabs(state) {
  for (const btn of tabButtons) {
    const active = btn.dataset.mode === state.mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const panel of panels) {
    panel.classList.toggle('active', panel.dataset.panel === state.mode);
  }
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    store.set({ mode: btn.dataset.mode }, 'tabs');
  });
}

// Roving tabindex + arrow-key navigation for the tablist (WAI-ARIA tabs pattern).
const tabsNav = document.querySelector('.tabs[role="tablist"]');
if (tabsNav) {
  tabsNav.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const idx = tabButtons.indexOf(document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    let next;
    if (e.key === 'ArrowLeft') next = (idx - 1 + tabButtons.length) % tabButtons.length;
    else if (e.key === 'ArrowRight') next = (idx + 1) % tabButtons.length;
    else if (e.key === 'Home') next = 0;
    else next = tabButtons.length - 1;
    tabButtons[next].focus();
    store.set({ mode: tabButtons[next].dataset.mode }, 'tabs');
  });
}

function syncTabIndex(state) {
  for (const btn of tabButtons) {
    btn.tabIndex = btn.dataset.mode === state.mode ? 0 : -1;
  }
}

store.subscribe((state) => syncTabs(state), ['mode']);
store.subscribe((state) => syncTabIndex(state), ['mode']);
syncTabs(store.get());
syncTabIndex(store.get());

// ---------- Arm-tab controls ----------

const playBtn = document.getElementById('play');
const playIcon = document.getElementById('play-icon');
const timeEl = document.getElementById('time');
const speedEl = document.getElementById('speed');
const yScaleEl = document.getElementById('yscale-toggle');
const circlesEl = document.getElementById('circles-toggle');
const skinEl = document.getElementById('skin-toggle');
const presetsEl = document.getElementById('presets');
const addComponentBtn = document.getElementById('add-component');
const termsGroupEl = document.getElementById('terms-group');
const termsEl = document.getElementById('terms');
const termsValueEl = document.getElementById('terms-value');

function syncPlayIcon(state) {
  if (playIcon) playIcon.className = state.playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
}

playBtn.addEventListener('click', () => {
  const s = store.get();
  store.set({ playing: !s.playing }, 'controls');
});
store.subscribe((state) => syncPlayIcon(state), ['playing']);
syncPlayIcon(store.get());

let scrubbing = false;
timeEl.addEventListener('pointerdown', () => {
  scrubbing = true;
  store.set({ playing: false }, 'controls');
});
timeEl.addEventListener('input', () => {
  store.setTime(parseFloat(timeEl.value));
});
window.addEventListener('pointerup', () => {
  scrubbing = false;
});

speedEl.addEventListener('change', () => {
  store.set({ speed: parseFloat(speedEl.value) }, 'controls');
});

yScaleEl.addEventListener('change', () => {
  store.set({ yScale: yScaleEl.value }, 'controls');
});

circlesEl.addEventListener('change', () => {
  store.set({ showCircles: circlesEl.checked }, 'controls');
});

if (skinEl) {
  skinEl.addEventListener('change', () => {
    store.set({ showSkin: skinEl.checked }, 'controls');
  });
}

function applyPreset() {
  const name = presetsEl.value;
  if (!name) return;
  const n = name === 'arm' ? undefined : Math.max(1, Math.min(30, parseInt(termsEl.value, 10) || 6));
  store.setComponents(preset(name, n), 'presets');
}

presetsEl.addEventListener('change', () => {
  if (termsGroupEl) {
    termsGroupEl.style.display = presetsEl.value && presetsEl.value !== 'arm' ? 'flex' : 'none';
  }
  applyPreset();
});

if (termsEl) {
  termsEl.addEventListener('input', () => {
    if (termsValueEl) termsValueEl.textContent = termsEl.value;
    if (presetsEl.value && presetsEl.value !== 'arm') applyPreset();
  });
}

addComponentBtn.addEventListener('click', () => {
  const { components } = store.get();
  const usedFreqs = new Set(components.map((c) => c.freq));
  let freq = 1;
  while (usedFreqs.has(freq)) freq += 1;
  const id = store.addComponent({ freq, amp: 0.2, phase: 0 });
  store.set({ selectedId: id }, 'editor');
});

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const target = e.target;
  const tag = target && target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
  e.preventDefault();
  const s = store.get();
  store.set({ playing: !s.playing }, 'keyboard');
});

// ---------- Views ----------

const armCanvas = document.getElementById('arm-canvas');
const spectrumCanvas = document.getElementById('spectrum-canvas');
const controlArmCanvas = document.getElementById('control-arm-canvas');
const drawCanvas = document.getElementById('draw-canvas');
const jointCanvas = document.getElementById('joint-canvas');

// showCircles is intentionally left to fall through to state.showCircles (the
// checkbox above) rather than being pinned here.
const armView = createArmView(armCanvas, store, { interactive: true, showTrace: true });
const spectrumView = createSpectrumView(spectrumCanvas, store, {});

// Handle for the browser console and the end-to-end tests: read state, and find
// where joints and stems are currently drawn.
window.fourierDemo = { store, armView, spectrumView };

// The control-tab arm shows only the band-limited (or actuator-lag-filtered)
// reconstruction, so it visually demonstrates bandwidth truncation while the
// view's own faint background path (from `derived`, always the full series)
// stands in for the true target path.
function bandLimitedComponents() {
  const state = store.get();
  const derived = store.derived();
  const entries = Array.from(derived.spectrum.entries()).map(([freq, v]) => ({ freq, c: v.sum }));
  const feedbackEl = document.getElementById('feedback-toggle');
  const fcEl = document.getElementById('fc-slider');
  const useLag = feedbackEl && feedbackEl.checked;
  // Bandwidth truncation always applies; actuator lag, when enabled, applies
  // on top of it (both filters stack rather than being mutually exclusive).
  const bandLimited = entries.filter((e) => Math.abs(e.freq) <= state.bandwidth);
  const filtered = useLag ? lowpass(bandLimited, Math.max(0.01, parseFloat(fcEl.value))) : bandLimited;
  return filtered.map((c, i) => fromCoeff(c, { id: `bw-${i}`, color: PALETTE[i % PALETTE.length] }));
}
const controlArmView = createArmView(controlArmCanvas, store, {
  interactive: false,
  showTrace: true,
  showCircles: true,
  numberJoints: true,
  componentsOverride: bandLimitedComponents,
});
const drawView = createDrawView(drawCanvas, store);
const jointPlot = createJointPlot(jointCanvas, store);

createEditor(document.getElementById('editor'), store);

// ---------- Single rAF loop ----------

let lastTs = null;

function frame(ts) {
  if (lastTs == null) lastTs = ts;
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;

  const state = store.get();
  if (state.playing && !scrubbing && !state.dragging) {
    let t = state.t + (dt * state.speed) / 10; // one period ~= 10s at 1x
    t = ((t % 1) + 1) % 1;
    store.setTime(t);
  }

  const renderState = store.get();
  const derived = store.derived();

  if (!scrubbing) timeEl.value = String(renderState.t);

  if (renderState.mode === 'arm') {
    armView.render(renderState, derived);
    spectrumView.render(renderState, derived);
  } else if (renderState.mode === 'draw') {
    drawView.render(renderState, derived);
  } else if (renderState.mode === 'control') {
    controlArmView.render(renderState, derived);
    jointPlot.render(renderState, derived);
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// ---------- Tutorial ----------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadTutorial() {
  const el = document.getElementById('tutorial');
  if (!el) return;
  try {
    const res = await fetch('content/tutorial.html');
    if (!res.ok) throw new Error(`HTTP ${res.status} loading tutorial content`);
    const html = await res.text();
    el.innerHTML = html;
    if (typeof window.renderMathInElement === 'function') {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
      });
    }
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error"><strong>Couldn't load the tutorial.</strong> ${escapeHtml(err.message)}</div>`;
  }
}

loadTutorial();
