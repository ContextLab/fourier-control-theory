// Component list editor: add/remove, numeric + slider inputs for freq/amp/phase.
// Patches existing DOM in place on external changes (arm drag, spectrum drag, presets,
// draw "send to arm"); only rebuilds the whole list when components are added/removed
// or reordered. Skips re-render entirely when the store change originated from this
// module itself (source === 'editor'), since the inputs already show the typed value.

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

function fmtAmp(v) {
  return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0';
}

function fmtDeg(v) {
  return String(Math.round((v * RAD2DEG) % 360));
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

  const freqField = document.createElement('div');
  freqField.className = 'editor-field';
  const freqInput = document.createElement('input');
  freqInput.type = 'number';
  freqInput.step = '1';
  freqInput.value = String(component.freq);
  const freqSlider = document.createElement('input');
  freqSlider.type = 'range';
  freqSlider.min = '-32';
  freqSlider.max = '32';
  freqSlider.step = '1';
  freqSlider.value = String(component.freq);
  freqField.append(freqInput, freqSlider);
  row.appendChild(freqField);

  const ampField = document.createElement('div');
  ampField.className = 'editor-field';
  const ampInput = document.createElement('input');
  ampInput.type = 'number';
  ampInput.step = '0.01';
  ampInput.min = '0';
  ampInput.value = fmtAmp(component.amp);
  const ampSlider = document.createElement('input');
  ampSlider.type = 'range';
  ampSlider.min = '0';
  ampSlider.max = '2';
  ampSlider.step = '0.01';
  ampSlider.value = fmtAmp(component.amp);
  ampField.append(ampInput, ampSlider);
  row.appendChild(ampField);

  const phaseField = document.createElement('div');
  phaseField.className = 'editor-field';
  const phaseInput = document.createElement('input');
  phaseInput.type = 'number';
  phaseInput.step = '1';
  phaseInput.value = fmtDeg(component.phase);
  const phaseSlider = document.createElement('input');
  phaseSlider.type = 'range';
  phaseSlider.min = '-180';
  phaseSlider.max = '180';
  phaseSlider.step = '1';
  phaseSlider.value = fmtDeg(component.phase);
  phaseField.append(phaseInput, phaseSlider);
  row.appendChild(phaseField);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-icon remove-btn';
  removeBtn.setAttribute('aria-label', 'Remove component');
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
    store.updateComponent(component.id, { amp: Math.max(0, value) }, 'editor');
  });
  bindPair(phaseInput, phaseSlider, (value) => {
    store.updateComponent(component.id, { phase: value * DEG2RAD }, 'editor');
  });

  removeBtn.addEventListener('click', () => {
    store.removeComponent(component.id);
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

  function fullRebuild(state) {
    container.innerHTML = '';
    rows.clear();
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

  function sameShape(components) {
    if (components.length !== rows.size) return false;
    return components.every((c) => rows.has(c.id));
  }

  function onStoreChange(state, changedKeys, source) {
    if (source === 'editor') return;
    if (changedKeys.has('components')) {
      if (!sameShape(state.components)) {
        fullRebuild(state);
      } else {
        for (const component of state.components) {
          patchRow(rows.get(component.id), component);
        }
      }
    }
    if (changedKeys.has('selectedId')) {
      updateSelection(state.selectedId);
    }
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
