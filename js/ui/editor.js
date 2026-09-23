// Component list editor: add/remove, numeric + slider inputs for freq/amp/phase.
// Patches existing DOM in place on external changes (arm drag, spectrum drag, presets,
// draw "send to arm"); only rebuilds the whole list when components are added/removed
// or reordered. When a change originates from this module itself (source === 'editor'),
// patchRow() still runs, but it skips whichever field is currently focused so it never
// fights the value the person is typing; that's what lets a sanitized/clamped value
// (see MAX_FREQ/MAX_AMP below) become visible again as soon as the field blurs.

import { MAX_FREQ, MAX_AMP } from '../core/store.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

function fmtAmp(v) {
  return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0';
}

/** Wraps radians to (-180, 180] degrees for display. */
function wrapDeg180(deg) {
  let wrapped = deg % 360;
  if (wrapped <= -180) wrapped += 360;
  if (wrapped > 180) wrapped -= 360;
  return wrapped;
}

function fmtDeg(v) {
  return String(Math.round(wrapDeg180(v * RAD2DEG)));
}

/**
 * Wires a number input and a range input to mirror each other and report a
 * parsed numeric value on any change.
 */
function bindPair(numberEl, rangeEl, onChange) {
  const handle = (source) => {
    const raw = source === numberEl ? numberEl.value : rangeEl.value;
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return;
    if (source === numberEl) rangeEl.value = String(value);
    else numberEl.value = String(value);
    onChange(value);
  };
  numberEl.addEventListener('input', () => handle(numberEl));
  rangeEl.addEventListener('input', () => handle(rangeEl));
}

function buildRow(component, store) {
  const row = document.createElement('div');
  row.className = 'editor-row';
  row.dataset.id = String(component.id);

  if (component.label) {
    const label = document.createElement('div');
    label.className = 'editor-label';
    label.textContent = component.label;
    row.appendChild(label);
  }

  const swatch = document.createElement('span');
  swatch.className = 'editor-swatch';
  swatch.style.background = component.color || '#888';
  row.appendChild(swatch);

  const freqTitle = `Frequency in cycles/period, an integer from −${MAX_FREQ} to ${MAX_FREQ}`;
  const freqField = document.createElement('div');
  freqField.className = 'editor-field';
  const freqInput = document.createElement('input');
  freqInput.type = 'number';
  freqInput.step = '1';
  freqInput.min = String(-MAX_FREQ);
  freqInput.max = String(MAX_FREQ);
  freqInput.title = freqTitle;
  freqInput.value = String(component.freq);
  const freqSlider = document.createElement('input');
  freqSlider.type = 'range';
  freqSlider.min = String(-MAX_FREQ);
  freqSlider.max = String(MAX_FREQ);
  freqSlider.step = '1';
  freqSlider.title = freqTitle;
  freqSlider.value = String(component.freq);
  freqField.append(freqInput, freqSlider);
  row.appendChild(freqField);

  const ampTitle = `Amplitude (link length), from 0 to ${MAX_AMP}`;
  const ampField = document.createElement('div');
  ampField.className = 'editor-field';
  const ampInput = document.createElement('input');
  ampInput.type = 'number';
  ampInput.step = '0.01';
  ampInput.min = '0';
  ampInput.max = String(MAX_AMP);
  ampInput.title = ampTitle;
  ampInput.value = fmtAmp(component.amp);
  const ampSlider = document.createElement('input');
  ampSlider.type = 'range';
  ampSlider.min = '0';
  ampSlider.max = String(MAX_AMP);
  ampSlider.step = '0.01';
  ampSlider.title = ampTitle;
  ampSlider.value = fmtAmp(component.amp);
  ampField.append(ampInput, ampSlider);
  row.appendChild(ampField);

  const phaseTitle = 'Phase in degrees, wrapped to (−180°, 180°]';
  const phaseField = document.createElement('div');
  phaseField.className = 'editor-field';
  const phaseInput = document.createElement('input');
  phaseInput.type = 'number';
  phaseInput.step = '1';
  phaseInput.title = phaseTitle;
  phaseInput.value = fmtDeg(component.phase);
  const phaseSlider = document.createElement('input');
  phaseSlider.type = 'range';
  phaseSlider.min = '-180';
  phaseSlider.max = '180';
  phaseSlider.step = '1';
  phaseSlider.title = phaseTitle;
  phaseSlider.value = fmtDeg(component.phase);
  phaseField.append(phaseInput, phaseSlider);
  row.appendChild(phaseField);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-icon remove-btn';
  removeBtn.setAttribute('aria-label', 'Remove component');
  removeBtn.title = 'Remove this component';
  removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  row.appendChild(removeBtn);

  row.addEventListener('click', (e) => {
    if (e.target.closest('input, button')) return;
    store.set({ selectedId: component.id }, 'editor');
  });

  bindPair(freqInput, freqSlider, (value) => {
    store.updateComponent(component.id, { freq: Math.round(value) }, 'editor');
  });
  bindPair(ampInput, ampSlider, (value) => {
    store.updateComponent(component.id, { amp: Math.max(0, Math.min(MAX_AMP, value)) }, 'editor');
  });
  bindPair(phaseInput, phaseSlider, (value) => {
    store.updateComponent(component.id, { phase: value * DEG2RAD }, 'editor');
  });

  // On blur (or Enter/"change"), always resync from the store's sanitized
  // value — regardless of whether the typed text was valid. This is what
  // surfaces a clamp/round (1e6 -> MAX_FREQ, -0.5 -> 0.5 with phase+180,
  // 720deg -> 0deg) once the field loses focus, and reverts unparseable text
  // ("abc", "1e400") back to the last-good value instead of leaving it blank
  // or stuck at the rejected text (bindPair's onChange never ran for it, so
  // the store was never touched and still holds that last-good value).
  function resyncFromStore() {
    const current = store.get().components.find((c) => c.id === component.id);
    if (!current) return;
    freqInput.value = String(current.freq);
    freqSlider.value = String(current.freq);
    ampInput.value = fmtAmp(current.amp);
    ampSlider.value = fmtAmp(current.amp);
    phaseInput.value = fmtDeg(current.phase);
    phaseSlider.value = fmtDeg(current.phase);
  }
  freqInput.addEventListener('blur', resyncFromStore);
  ampInput.addEventListener('blur', resyncFromStore);
  phaseInput.addEventListener('blur', resyncFromStore);

  removeBtn.addEventListener('click', () => {
    const wasSelected = store.get().selectedId === component.id;
    store.removeComponent(component.id, 'editor');
    if (wasSelected) store.set({ selectedId: null }, 'editor');
  });

  return { el: row, freqInput, freqSlider, ampInput, ampSlider, phaseInput, phaseSlider, swatch };
}

function patchRow(row, component) {
  if (document.activeElement !== row.freqInput && document.activeElement !== row.freqSlider) {
    row.freqInput.value = String(component.freq);
    row.freqSlider.value = String(component.freq);
  }
  if (document.activeElement !== row.ampInput && document.activeElement !== row.ampSlider) {
    row.ampInput.value = fmtAmp(component.amp);
    row.ampSlider.value = fmtAmp(component.amp);
  }
  if (document.activeElement !== row.phaseInput && document.activeElement !== row.phaseSlider) {
    row.phaseInput.value = fmtDeg(component.phase);
    row.phaseSlider.value = fmtDeg(component.phase);
  }
  row.swatch.style.background = component.color || '#888';
}

/**
 * @param {HTMLElement} container - #editor list container
 * @param {ReturnType<typeof import('../core/store.js').createStore>} store
 * @returns {{destroy: () => void}}
 */
export function createEditor(container, store) {
  const rows = new Map();
  let idOrder = [];

  function renderEmptyHint() {
    const hint = document.createElement('div');
    hint.className = 'editor-empty-hint';
    hint.textContent = 'No components — click + Add or pick a preset.';
    container.appendChild(hint);
  }

  function fullRebuild(state) {
    container.innerHTML = '';
    rows.clear();
    idOrder = state.components.map((c) => c.id);
    if (state.components.length === 0) {
      renderEmptyHint();
      return;
    }
    for (const component of state.components) {
      const row = buildRow(component, store);
      rows.set(component.id, row);
      container.appendChild(row.el);
    }
    updateSelection(state.selectedId);
  }

  function updateSelection(selectedId) {
    for (const [id, row] of rows) {
      row.el.classList.toggle('selected', id === selectedId);
    }
  }

  // True when the component list still has the same ids in the same order,
  // so rows can be patched in place instead of rebuilding the DOM (e.g. for a
  // "Sort by |f|" reorder, this must be false so fullRebuild picks up the new order).
  function sameShape(components) {
    if (components.length !== idOrder.length) return false;
    return components.every((c, i) => idOrder[i] === c.id);
  }

  function onStoreChange(state, changedKeys, source) {
    // selectedId highlighting always applies, even for changes this module
    // itself caused (e.g. clicking a row sets selectedId with source 'editor').
    if (changedKeys.has('selectedId')) {
      updateSelection(state.selectedId);
    }
    if (changedKeys.has('components')) {
      if (!sameShape(state.components)) {
        fullRebuild(state);
      } else {
        // patchRow() itself skips whichever field is focused, so re-running it
        // for our own edits is safe and is what lets a sanitized/clamped
        // value (e.g. an out-of-range freq or amp) show up once the field blurs.
        for (const component of state.components) {
          patchRow(rows.get(component.id), component);
        }
      }
    }
  }

  const sortBtn = document.getElementById('sort-by-freq');
  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      // Signed ascending order (not by |f|): this minimizes the frequency gap
      // Δf between adjacent links in the chain, which is what keeps adjacent
      // motor speeds close together. It only changes how the arm bends/moves
      // (the traced path is order-independent), same as before.
      const sorted = [...store.get().components].sort((a, b) => a.freq - b.freq);
      store.setComponents(sorted, 'editor');
    });
  }

  fullRebuild(store.get());
  const unsubscribe = store.subscribe(onStoreChange, ['components', 'selectedId']);

  return {
    destroy() {
      unsubscribe();
      container.innerHTML = '';
      rows.clear();
    },
  };
}
