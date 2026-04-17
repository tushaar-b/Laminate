/**
 * app.js — Frontend application layer
 *
 * Wires up all UI: ply management, CLT analysis, Ashby MSI scenarios,
 * advanced custom formula mode, and localStorage persistence.
 *
 * Depends on: api.js (window.CLT) and mathjs (window.math) loaded before this.
 */

/* ═══════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════ */
let lastResults    = null;   // { D11, D22, D66, E_eff, E_b, totalT }
let lastMSI        = null;   // last computed MSI result object
let totalThickness = 0;
let _aiContext     = null;   // stored for on-demand AI fetch
let _aiFetched     = false;  // prevent double-fetching

/* ═══════════════════════════════════════════════════
   SCENARIO SELECTOR
═══════════════════════════════════════════════════ */

const SCENARIO_KEYS = Object.keys(window.CLT.SCENARIOS);
const DEFAULT_SCENARIO = 'beam_min_weight_stiffness';

/** Populate the <select> with all scenario options */
function buildScenarioSelect() {
  const sel = document.getElementById('inp-scenario');
  SCENARIO_KEYS.forEach(key => {
    const sc  = window.CLT.SCENARIOS[key];
    const opt = document.createElement('option');
    opt.value       = key;
    opt.textContent = `${sc.label}  —  ${sc.formulaStr}`;
    sel.appendChild(opt);
  });

  // Restore from localStorage or use default
  const saved = localStorage.getItem('clt_scenario') || DEFAULT_SCENARIO;
  sel.value   = SCENARIO_KEYS.includes(saved) ? saved : DEFAULT_SCENARIO;
  _updateExtraInputs(sel.value);
}

/** Show/hide cost, sigma, alpha, kappa/Cp inputs based on selected scenario */
function _updateExtraInputs(key) {
  const sc = key === 'custom' ? {} : (window.CLT.SCENARIOS[key] || {});

  _toggleInput('group-cm',     sc.needsCm     || key === 'custom');
  _toggleInput('group-sigma',  sc.needsSigma  || key === 'custom');
  _toggleInput('group-alpha',  sc.needsAlpha  || key === 'custom');
  _toggleInput('group-kappa',  sc.needsKappaCp|| key === 'custom');
  _toggleInput('group-cp',     sc.needsKappaCp|| key === 'custom');
}

function _toggleInput(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.maxHeight  = visible ? '80px' : '0';
  el.style.opacity    = visible ? '1'    : '0';
  el.style.overflow   = 'hidden';
  el.setAttribute('aria-hidden', String(!visible));
  // Disable inputs inside hidden groups so they don't interfere with form
  el.querySelectorAll('input').forEach(inp => { inp.disabled = !visible; });
}

window.onScenarioChange = function() {
  const key = document.getElementById('inp-scenario').value;
  localStorage.setItem('clt_scenario', key);
  _updateExtraInputs(key);

  // If advanced mode is on but user picks a standard scenario, keep advanced
  // panel but note the selection is overriding it
  const advOn = !document.getElementById('advanced-panel').classList.contains('hidden');
  if (!advOn) return;
  // If advanced is on and user changes dropdown, un-check custom
  _setAdvancedMode(false);
};

/* ═══════════════════════════════════════════════════
   ADVANCED / CUSTOM FORMULA MODE
═══════════════════════════════════════════════════ */

window.toggleAdvanced = function() {
  const panel  = document.getElementById('advanced-panel');
  const btn    = document.getElementById('btn-advanced');
  const isOpen = !panel.classList.contains('hidden');
  _setAdvancedMode(!isOpen);
};

function _setAdvancedMode(on) {
  const panel = document.getElementById('advanced-panel');
  const btn   = document.getElementById('btn-advanced');
  panel.classList.toggle('hidden', !on);
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-expanded', String(on));
  if (on) {
    // Override scenario to 'custom' visually
    document.getElementById('inp-scenario').value = '__custom__';
    _updateExtraInputs('custom');
  } else {
    // Restore scenario to saved value
    const saved = localStorage.getItem('clt_scenario') || DEFAULT_SCENARIO;
    document.getElementById('inp-scenario').value = SCENARIO_KEYS.includes(saved) ? saved : DEFAULT_SCENARIO;
    _updateExtraInputs(document.getElementById('inp-scenario').value);
    _clearFormulaError();
  }
}

const ALLOWED_TOKENS = ['E', 'sigma', 'rho', 'Cm', 'alpha', 'kappa', 'Cp'];

window.validateCustomFormula = function(inp) {
  const formula = inp.value.trim();
  const errEl   = document.getElementById('formula-error');

  if (!formula) {
    _clearFormulaError();
    return true;
  }

  // Check for disallowed tokens that look like variable names
  try {
    if (typeof math === 'undefined') throw new Error('mathjs not loaded');
    const testScope = { E: 50, sigma: 800, rho: 1.6, Cm: 20, alpha: 0.1, kappa: 1, Cp: 500 };
    const result = math.evaluate(formula, testScope);
    if (!isFinite(result)) throw new Error('Formula produces non-finite result with test values.');
    _clearFormulaError();
    inp.classList.remove('formula-invalid');
    inp.classList.add('formula-valid');
    return true;
  } catch (e) {
    const msg = e.message.replace(/\n.*/s, ''); // first line only
    errEl.textContent = `⚠ ${msg}`;
    errEl.classList.remove('hidden');
    inp.classList.add('formula-invalid');
    inp.classList.remove('formula-valid');
    return false;
  }
};

function _clearFormulaError() {
  const errEl = document.getElementById('formula-error');
  errEl.classList.add('hidden');
  const inp = document.getElementById('inp-custom-formula');
  inp.classList.remove('formula-valid', 'formula-invalid');
}

/* ═══════════════════════════════════════════════════
   PLY MANAGEMENT
═══════════════════════════════════════════════════ */

/**
 * Add a new ply row. Defaults: T300/5208 CFRP.
 * ν₂₁ = 0.0222 is a suggested starting value (= 0.30 × 10/135).
 */
window.addLayer = function () {
  const container = document.getElementById('layers-container');
  const div = document.createElement('div');
  div.className = 'ply-row';
  div.setAttribute('role', 'listitem');

  div.innerHTML = `
    <div class="field-group">
      <label class="field-label-sm">t (mm)</label>
      <input type="number" value="2.5" step="0.1" min="0.01" class="ply-input inp-t" />
    </div>
    <div class="field-group">
      <label class="field-label-sm">θ (°)</label>
      <input type="number" value="0" class="ply-input inp-theta" />
    </div>
    <div class="field-group">
      <label class="field-label-sm">E₁ (GPa)</label>
      <input type="number" value="135" class="ply-input inp-e1" />
    </div>
    <div class="field-group">
      <label class="field-label-sm">E₂ (GPa)</label>
      <input type="number" value="10" class="ply-input inp-e2" />
    </div>
    <div class="field-group">
      <label class="field-label-sm">G₁₂ (GPa)</label>
      <input type="number" value="5" step="0.5" class="ply-input inp-g12" />
    </div>
    <div class="field-group">
      <label class="field-label-sm">ν₁₂</label>
      <input type="number" value="0.30" step="0.01" min="0" max="0.5" class="ply-input inp-v12" />
    </div>
    <div class="field-group">
      <label class="field-label-sm">ν₂₁</label>
      <input type="number" value="0.0222" step="0.001" min="0" max="0.5"
             class="ply-input inp-v21"
             title="Minor Poisson's ratio. Reference: ν₂₁ = ν₁₂ × E₂ / E₁" />
    </div>
    <button class="btn-remove" onclick="this.closest('.ply-row').remove()" title="Remove ply"
            aria-label="Remove this ply">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;
  container.appendChild(div);
};

/* ═══════════════════════════════════════════════════
   CLT ANALYSIS (main entry point)
═══════════════════════════════════════════════════ */

window.runAnalysis = function () {
  const rows = document.querySelectorAll('.ply-row');
  if (rows.length === 0) { alert('Please add at least one ply.'); return; }

  // ── Validate custom formula if advanced mode is active ──
  const advOpen = !document.getElementById('advanced-panel').classList.contains('hidden');
  if (advOpen) {
    const formulaInp = document.getElementById('inp-custom-formula');
    if (!window.validateCustomFormula(formulaInp)) {
      alert('Fix the custom formula before running analysis.');
      return;
    }
  }

  // ── Collect ply data ────────────────────────────────────
  const layerData = Array.from(rows).map(row => ({
    t:         parseFloat(row.querySelector('.inp-t').value),
    theta_rad: parseFloat(row.querySelector('.inp-theta').value) * (Math.PI / 180),
    E1:        parseFloat(row.querySelector('.inp-e1').value),
    E2:        parseFloat(row.querySelector('.inp-e2').value),
    G12:       parseFloat(row.querySelector('.inp-g12').value),
    v12:       parseFloat(row.querySelector('.inp-v12').value),
    v21:       parseFloat(row.querySelector('.inp-v21').value) || 0,
  }));

  // ── Run CLT ────────────────────────────────────────────
  const t0 = performance.now();
  const res = window.CLT.runLaminateAnalysis(layerData);
  const { D11, D22, D66, E_eff, E_b, totalT, plies } = res;
  const cltMs = performance.now() - t0;

  totalThickness = totalT;
  lastResults    = { D11, D22, D66, E_eff, E_b, totalT };

  // ── D-matrix display ────────────────────────────────────
  document.getElementById('res-dx').textContent  = _sci(D11);
  document.getElementById('res-dy').textContent  = _sci(D22);
  document.getElementById('res-dxy').textContent = _sci(D66);
  document.getElementById('res-eb').textContent  = E_b.toFixed(2) + ' GPa';
  document.getElementById('res-eeff').textContent = E_eff.toFixed(2) + ' GPa';

  // Store for engineering viz
  window._cltLastDMat = { dx: _sci(D11), dy: _sci(D22), dxy: _sci(D66) };
  const VIZ_COLORS = ['#1d6fa4','#1a8a7a','#277a5c','#1a6e82','#277a5c','#1a8a7a','#1d6fa4'];
  if (window._engAnim) window._engAnim.updatePlies(
    layerData.map((l, i) => ({
      a: +(l.theta_rad * 180 / Math.PI).toFixed(0),
      c: VIZ_COLORS[i % VIZ_COLORS.length],
    }))
  );

  // ── MSI computation (<200ms target) ────────────────────
  const msiResult = _computeAndDisplayMSI(E_eff, totalT, D11);
  const totalMs   = performance.now() - t0;
  console.debug(`[CLT] solve ${cltMs.toFixed(1)} ms | total incl. MSI ${totalMs.toFixed(1)} ms`);

  // ── Ply summary table ───────────────────────────────────
  const tbody = document.getElementById('summary-body');
  tbody.innerHTML = '';
  document.getElementById('table-hint').style.display = 'none';
  plies.forEach((l, idx) => {
    const deg = (l.theta_rad * 180 / Math.PI).toFixed(0);
    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="ply-num">${idx + 1}</td>
        <td>${l.t}</td><td>${deg}°</td>
        <td>${l.E1}</td><td>${l.E2}</td><td>${l.G12}</td>
        <td>${l.v12}</td>
        <td class="accent-cell">${l.v21.toFixed(4)}</td>
      </tr>`);
  });

  // ── Store AI context for on-demand fetch ────────────────
  const rho_kg = parseFloat(document.getElementById('inp-rho').value) || 1600;
  const indicesM123 = window.CLT.computeSelectionIndices({
    rho:  rho_kg,
    E1:   layerData[0].E1,
    E2:   layerData[0].E2,
    sigf: parseFloat(document.getElementById('inp-sigf').value) || 0,
    Dx:   D11,
    h:    totalT,
  });
  _aiContext = {
    dMatrix:  { dx: _sci(D11), dy: _sci(D22), dxy: _sci(D66) },
    indicesM123,
    msiCtx: msiResult ? { ...msiResult, E_eff, rho_eff: rho_kg / 1000 } : null,
  };
  _aiFetched = false;
  // Reset AI output panel for the next fetch
  document.getElementById('ai-output').innerHTML =
    '<span class="ai-loading">Querying material database…</span>';

  // ── Transition to results step ──────────────────────────
  goToStep(2);
};


/* ═══════════════════════════════════════════════════
   MSI COMPUTATION + DISPLAY
═══════════════════════════════════════════════════ */

function _computeAndDisplayMSI(E_eff, totalT, D11) {
  const rho_kg  = parseFloat(document.getElementById('inp-rho').value)   || 1600;
  const sigma   = parseFloat(document.getElementById('inp-sigf').value)   || null;
  const Cm      = parseFloat(document.getElementById('inp-cm').value)     || 1;
  const alpha   = parseFloat(document.getElementById('inp-alpha').value)  || 1;
  const kappa   = parseFloat(document.getElementById('inp-kappa').value)  || 1;
  const Cp      = parseFloat(document.getElementById('inp-cp').value)     || 500;
  const rho_gcc = rho_kg / 1000;  // kg/m³ → g/cm³

  const advOpen  = !document.getElementById('advanced-panel').classList.contains('hidden');
  const scenarioKey = advOpen
    ? 'custom'
    : (document.getElementById('inp-scenario').value || DEFAULT_SCENARIO);
  const customFormula = document.getElementById('inp-custom-formula').value.trim();

  try {
    const msi = window.CLT.computeMSI({
      scenarioKey,
      E:     E_eff,
      sigma: sigma > 0 ? sigma : null,
      rho:   rho_gcc,
      Cm,
      alpha,
      kappa,
      Cp,
      customFormula: advOpen ? customFormula : null,
      sigmaIsUserSupplied: true,  // no FPF implementation; always user-supplied
    });

    lastMSI = msi;
    _renderMSIRow(msi, E_eff, rho_gcc);
    return msi;
  } catch (e) {
    console.warn('[MSI] computation error:', e.message);
    document.getElementById('msi-result-row').classList.add('hidden');
    return null;
  }
}

function _renderMSIRow(msi, E_eff, rho_eff) {
  const row        = document.getElementById('msi-result-row');
  const valEl      = document.getElementById('msi-main-value');
  const formulaEl  = document.getElementById('msi-main-formula');
  const scenarioEl = document.getElementById('msi-rv-scenario');
  const unitsEl    = document.getElementById('msi-rv-units');
  const ttFormula  = document.getElementById('msi-tt-formula');
  const ttEff      = document.getElementById('msi-tt-eff');

  if (msi.value == null || !isFinite(msi.value)) {
    row.classList.add('hidden');
    return;
  }

  valEl.textContent      = msi.value.toExponential(4);
  formulaEl.textContent  = msi.formulaStr;
  scenarioEl.textContent = msi.label;
  unitsEl.textContent    = msi.units;
  ttFormula.textContent  = msi.formulaFull || msi.formulaStr;
  ttEff.textContent      = `E_eff = ${E_eff.toFixed(2)} GPa, ρ_eff = ${rho_eff.toFixed(3)} g/cm³`;

  row.classList.remove('hidden');
}

/* ═══════════════════════════════════════════════════
   CLASSIC M1/M2/M3 BUTTON
═══════════════════════════════════════════════════ */

window.computeAndShowMSI = function () {
  if (!lastResults) {
    alert('Run CLT Analysis first.');
    return;
  }
  const rho  = parseFloat(document.getElementById('inp-rho').value)         || 1600;
  const sigf = parseFloat(document.getElementById('inp-sigf-classic').value) || 0;
  const rows  = document.querySelectorAll('.ply-row');
  const n     = rows.length;
  const E1avg = [...rows].reduce((s,r) => s + parseFloat(r.querySelector('.inp-e1').value), 0) / n;
  const E2avg = [...rows].reduce((s,r) => s + parseFloat(r.querySelector('.inp-e2').value), 0) / n;

  const idx = window.CLT.computeSelectionIndices({
    rho, E1: E1avg, E2: E2avg, sigf,
    Dx: lastResults.D11, h: totalThickness,
  });

  document.getElementById('msi-m1').textContent = idx.M1.toExponential(3);
  document.getElementById('msi-m2').textContent = idx.M2 != null ? idx.M2.toExponential(3) : 'N/A';
  document.getElementById('msi-m3').textContent = idx.M3 != null ? idx.M3.toExponential(3) : 'N/A';
  document.getElementById('msi-output').classList.remove('hidden');
};

/* ═══════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════ */
function _sci(v) {
  return (!isFinite(v) || isNaN(v)) ? '—' : v.toExponential(3);
}

/* ═══════════════════════════════════════════════════
   STEP NAVIGATION
═══════════════════════════════════════════════════ */

function goToStep(n) {
  const current = document.querySelector('.step.step-active');
  const target  = document.getElementById(`step-${n}`);
  if (!current || !target || current === target) return;

  // Update step bar indicator
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    const s = i + 1;
    dot.classList.remove('step-dot-active', 'step-dot-done');
    if (s < n)  dot.classList.add('step-dot-done');
    if (s === n) dot.classList.add('step-dot-active');
  });

  // Sync engineering visualization
  if (window._engAnim) window._engAnim.setMode(n);
  const sidebar = document.getElementById('viz-sidebar');
  if (sidebar) sidebar.classList.toggle('viz-hidden', n === 3);
  anime({
    targets: current,
    opacity:    [1, 0],
    translateY: [0, -14],
    duration: 220,
    easing: 'easeInQuad',
    complete: () => {
      current.classList.remove('step-active');
      requestAnimationFrame(() => {
        target.classList.add('step-active');
        requestAnimationFrame(() => {
          anime({
            targets: target,
            opacity:    [0, 1],
            translateY: [16, 0],
            duration: 380,
            easing: 'easeOutExpo',
          });
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      });
    },
  });
}
window.goToStep = goToStep;

window.getAISuggestions = function () {
  if (_aiFetched) return;  // already fetching or fetched
  _aiFetched = true;

  const aiOut = document.getElementById('ai-output');
  if (!_aiContext) {
    aiOut.innerHTML = '<span class="ai-error">⚠ Run CLT analysis first.</span>';
    return;
  }

  window.CLT.fetchMaterialMatch(
    _aiContext.dMatrix,
    _aiContext.indicesM123,
    _aiContext.msiCtx
  )
    .then(html => { aiOut.innerHTML = html || '<em>No response from AI.</em>'; })
    .catch(err  => { aiOut.innerHTML = `<span class="ai-error">⚠ ${err.message}</span>`;
                     _aiFetched = false; });  // allow retry on error
};

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
buildScenarioSelect();
window.addLayer();
window.addLayer();
