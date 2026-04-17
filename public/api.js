/**
 * api.js — Backend / Calculation layer
 *
 * Pure engineering computations and AI API calls.
 * No DOM access — entirely separated from the UI layer (app.js).
 *
 * Loaded as a plain <script> before app.js.
 * All functions are attached to the global window.CLT namespace.
 *
 * NOTE: The Gemini API key is NOT stored here.
 * All AI requests are routed through /api/gemini (a secure server proxy).
 */

window.CLT = window.CLT || {};

// ─── PROXY ENDPOINT (no key exposed) ─────────────────────
const MODEL_PROXY = '/api/gemini';

/* ─── RETRY HELPER ──────────────────────────────────────── */
async function fetchWithRetry(url, options, maxRetries = 3) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt === maxRetries) return res;
    await new Promise(r => setTimeout(r, delay));
    delay *= 2;
  }
}

/* ─── SCENARIO DEFINITIONS ──────────────────────────────── */
/**
 * All 9 standard Ashby MSI scenarios.
 * Each entry defines: label, formula display string, variable requirements,
 * units string, key for localStorage, and compute function.
 *
 * Variable units assumed by all compute functions:
 *   E     — effective in-plane modulus [GPa]
 *   sigma — allowable stress [MPa]
 *   rho   — effective density [g/cm³]
 *   Cm    — material cost [$/kg]
 *   alpha — thermal conductivity [W/m·K]
 *   kappa — electrical conductivity [MS/m]  (mega-siemens/m)
 *   Cp    — specific heat capacity [J/kg·K]
 */
window.CLT.SCENARIOS = {
  beam_min_weight_stiffness: {
    label:         'Beam – min weight, stiffness',
    formulaStr:    'E^½ / ρ',
    formulaFull:   'E^(1/2) / rho',
    units:         'GPa^½·cm³/g',
    needsCm:       false,
    needsSigma:    false,
    needsAlpha:    false,
    needsKappaCp:  false,
    compute:       ({ E, rho }) => Math.sqrt(E) / rho,
  },
  tie_min_weight_stiffness: {
    label:         'Tie – min weight, stiffness',
    formulaStr:    'E / ρ',
    formulaFull:   'E / rho',
    units:         'GPa·cm³/g',
    needsCm:       false,
    needsSigma:    false,
    needsAlpha:    false,
    needsKappaCp:  false,
    compute:       ({ E, rho }) => E / rho,
  },
  beam_min_weight_strength: {
    label:         'Beam – min weight, strength',
    formulaStr:    'σ^⅔ / ρ',
    formulaFull:   'sigma^(2/3) / rho',
    units:         'MPa^⅔·cm³/g',
    needsCm:       false,
    needsSigma:    true,
    needsAlpha:    false,
    needsKappaCp:  false,
    compute:       ({ sigma, rho }) => Math.pow(sigma, 2/3) / rho,
  },
  beam_min_cost_stiffness: {
    label:         'Beam – min cost, stiffness',
    formulaStr:    'E^½ / (Cₘ·ρ)',
    formulaFull:   'E^(1/2) / (Cm * rho)',
    units:         'GPa^½·cm³/(g·$/kg)',
    needsCm:       true,
    needsSigma:    false,
    needsAlpha:    false,
    needsKappaCp:  false,
    compute:       ({ E, rho, Cm }) => Math.sqrt(E) / (Cm * rho),
  },
  beam_min_cost_strength: {
    label:         'Beam – min cost, strength',
    formulaStr:    'σ^⅔ / (Cₘ·ρ)',
    formulaFull:   'sigma^(2/3) / (Cm * rho)',
    units:         'MPa^⅔·cm³/(g·$/kg)',
    needsCm:       true,
    needsSigma:    true,
    needsAlpha:    false,
    needsKappaCp:  false,
    compute:       ({ sigma, rho, Cm }) => Math.pow(sigma, 2/3) / (Cm * rho),
  },
  column_min_cost_buckling: {
    label:         'Column – min cost, buckling load',
    formulaStr:    'E^½ / (Cₘ·ρ)',
    formulaFull:   'E^(1/2) / (Cm * rho)',
    units:         'GPa^½·cm³/(g·$/kg)',
    needsCm:       true,
    needsSigma:    false,
    needsAlpha:    false,
    needsKappaCp:  false,
    compute:       ({ E, rho, Cm }) => Math.sqrt(E) / (Cm * rho),
  },
  spring_min_weight_energy: {
    label:         'Spring – min weight, energy storage',
    formulaStr:    'σ² / (E·ρ)',
    formulaFull:   'sigma^2 / (E * rho)',
    units:         'MPa²·cm³/(GPa·g)',
    needsCm:       false,
    needsSigma:    true,
    needsAlpha:    false,
    needsKappaCp:  false,
    compute:       ({ sigma, E, rho }) => (sigma * sigma) / (E * rho),
  },
  thermal_min_cost: {
    label:         'Thermal insulation – min cost',
    formulaStr:    '1 / (α·Cₘ·ρ)',
    formulaFull:   '1 / (alpha * Cm * rho)',
    units:         '1 / (W·m⁻¹K⁻¹·$/kg·g·cm⁻³)',
    needsCm:       true,
    needsSigma:    false,
    needsAlpha:    true,
    needsKappaCp:  false,
    compute:       ({ alpha, Cm, rho }) => 1 / (alpha * Cm * rho),
  },
  em_max_field: {
    label:         'Electromagnet – max field',
    formulaStr:    'κ·Cₚ·ρ',
    formulaFull:   'kappa * Cp * rho',
    units:         'MS/m · J/(kg·K) · g/cm³',
    needsCm:       false,
    needsSigma:    false,
    needsAlpha:    false,
    needsKappaCp:  true,
    compute:       ({ kappa, Cp, rho }) => kappa * Cp * rho,
  },
};

/* ─── LAMINATE CALCULATIONS ─────────────────────────────── */

/**
 * Compute reduced stiffness (Q) and its transformed variants for a ply.
 */
window.CLT.computePlyContribution = function(ply, z_bot) {
  const { t, theta_rad, E1, E2, v12, v21, G12 } = ply;

  const denom = 1 - v12 * v21;

  const Q11 = (E1  * 1e9) / denom;
  const Q22 = (E2  * 1e9) / denom;
  const Q12 = (v12 * E2 * 1e9) / denom;
  const Q66 =  G12 * 1e9;

  const c  = Math.cos(theta_rad);
  const s  = Math.sin(theta_rad);
  const c2 = c*c, s2 = s*s, c4 = c2*c2, s4 = s2*s2, c2s2 = c2*s2;

  const Q11b =  Q11*c4 + 2*(Q12 + 2*Q66)*c2s2 + Q22*s4;
  const Q22b =  Q11*s4 + 2*(Q12 + 2*Q66)*c2s2 + Q22*c4;
  const Q12b = (Q11 + Q22 - 4*Q66)*c2s2 + Q12*(c4 + s4);
  const Q66b = (Q11 + Q22 - 2*Q12 - 2*Q66)*c2s2 + Q66*(s4 + c4);

  const zt_m = (z_bot + t) / 1000;
  const zb_m =  z_bot      / 1000;
  const Dfac  = (Math.pow(zt_m, 3) - Math.pow(zb_m, 3)) / 3;

  const t_m   = t / 1000;

  return {
    D11: Q11b * Dfac,
    D22: Q22b * Dfac,
    D66: Q66b * Dfac,
    A11: Q11b * t_m,
    A22: Q22b * t_m,
    A12: Q12b * t_m,
    A66: Q66b * t_m,
    z_top: z_bot + t,
  };
};

/**
 * Full laminate analysis: assembles D-matrix and A-matrix.
 */
window.CLT.runLaminateAnalysis = function(layerData) {
  let totalT = 0;
  layerData.forEach(l => (totalT += l.t));

  let D11 = 0, D22 = 0, D66 = 0;
  let A11 = 0, A22 = 0, A12 = 0, A66 = 0;
  let z_bot = -totalT / 2;

  const processed = layerData.map(ply => {
    const r   = window.CLT.computePlyContribution(ply, z_bot);
    D11 += r.D11;  D22 += r.D22;  D66 += r.D66;
    A11 += r.A11;  A22 += r.A22;  A12 += r.A12;  A66 += r.A66;
    z_bot = r.z_top;
    return { ...ply, ...r };
  });

  const h_m    = totalT / 1000;
  const det_A  = A11 * A22 - A12 * A12;
  const a11    = det_A > 1e-30 ? A22 / det_A : 0;
  const E_eff  = (a11 > 0 && h_m > 0) ? (1 / (h_m * a11)) / 1e9 : 0;
  const E_b    = h_m > 0 ? (12 * D11 / Math.pow(h_m, 3)) / 1e9 : 0;

  return { D11, D22, D66, A11, A22, A12, A66, E_eff, E_b, totalT, plies: processed };
};

/* ─── SCENARIO-BASED MSI ENGINE ─────────────────────────── */

window.CLT.computeMSI = function(p) {
  const { scenarioKey, E, sigma, rho, Cm, alpha, kappa, Cp,
          customFormula, sigmaIsUserSupplied } = p;

  if (scenarioKey === 'custom') {
    if (!customFormula) throw new Error('No custom formula provided.');
    if (typeof math === 'undefined') throw new Error('mathjs not loaded.');
    const scope = {
      E: E || 0, sigma: sigma || 0, rho: rho || 1,
      Cm: Cm || 1, alpha: alpha || 1, kappa: kappa || 1, Cp: Cp || 1,
    };
    const value = math.evaluate(customFormula, scope);
    return {
      value, formulaStr: customFormula, formulaFull: customFormula,
      units: 'custom', label: 'Custom Index', sigmaIsUserSupplied,
    };
  }

  const sc = window.CLT.SCENARIOS[scenarioKey];
  if (!sc) throw new Error(`Unknown scenario: ${scenarioKey}`);

  const value = sc.compute({ E, sigma, rho, Cm, alpha, kappa, Cp });
  return {
    value,
    formulaStr: sc.formulaStr,
    formulaFull: sc.formulaFull,
    units:  sc.units,
    label:  sc.label,
    sigmaIsUserSupplied,
  };
};

/* ─── CLASSIC M1/M2/M3 INDICES ──────────────────────────── */
window.CLT.computeSelectionIndices = function({ rho, E1, E2, sigf, Dx, h }) {
  const E_eff = Math.sqrt(E1 * E2);
  const h_m   = h / 1000;
  const M1 = (Math.pow(E_eff, 1/3) * Math.pow(1e9, 1/3)) / rho;
  const M2 = sigf > 0 ? Math.sqrt(sigf * 1e6) / rho : null;
  const M3 = h_m  > 0 ? Dx / (rho * Math.pow(h_m, 3)) : null;
  return { M1, M2, M3, E_eff };
};

/* ─── AI MATERIAL MATCH ─────────────────────────────────── */

/**
 * Queries Gemini via the /api/gemini proxy (key stays on the server).
 */
window.CLT.fetchMaterialMatch = async function(dVals, indicesM123, msiCtx) {
  let msiBlock = '';
  if (msiCtx && msiCtx.value != null && isFinite(msiCtx.value)) {
    msiBlock = `MATERIAL SELECTION INDEX CONTEXT:
Scenario = ${msiCtx.label}.
MSI formula = ${msiCtx.formulaStr}. Computed MSI = ${msiCtx.value.toExponential(4)} ${msiCtx.units}.
Effective E = ${msiCtx.E_eff != null ? msiCtx.E_eff.toFixed(2) : 'N/A'} GPa, ρ_eff = ${msiCtx.rho_eff != null ? msiCtx.rho_eff.toFixed(3) : 'N/A'} g/cm³.
${msiCtx.sigmaIsUserSupplied ? 'Note: σ_eff is user-supplied.' : ''}
Rank candidates by MSI; state whether each exceeds or falls below this benchmark.

`;
  }

  const msiUnits = msiCtx?.units || '';
  const prompt = `${msiBlock}You are an expert composite materials database.

Context: Dx=${dVals.dx} N·m, Dy=${dVals.dy} N·m, Dxy=${dVals.dxy} N·m, E_eff=${indicesM123.E_eff?.toFixed(1)} GPa, M1=${indicesM123.M1?.toFixed(4)}

Task: Recommend exactly 2 real commercial composite materials matching these properties.

RESPOND ONLY WITH VALID JSON — no prose, no markdown, no code fences. Schema:
[
  {
    "name": "Trade Name / Designation",
    "E1_GPa": number,
    "E2_GPa": number,
    "rho_kg_m3": number,
    "G12_GPa": number,
    "msi_value": number,
    "msi_units": "${msiUnits}",
    "vs_benchmark": "above" | "below",
    "application": "one sentence"
  }
]`;

  const response = await fetchWithRetry(MODEL_PROXY, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${response.status}`;
    if (response.status === 429) {
      throw new Error(
        'API quota exceeded — free tier limit reached. ' +
        'Wait a few minutes, then try again.'
      );
    }
    throw new Error(msg);
  }

  const data  = await response.json();
  const raw   = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();

  let materials = null;
  try {
    const cleaned = raw.replace(/^```[\w]*\n?/m, '').replace(/```$/m, '').trim();
    materials = JSON.parse(cleaned);
  } catch (_) {
    materials = null;
  }

  if (Array.isArray(materials) && materials.length > 0) {
    return _renderMaterialCards(materials, msiCtx);
  }

  return `<div class="mat-fallback">${raw
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')}</div>`;
};

/**
 * Renders material objects as structured HTML cards.
 */
function _renderMaterialCards(materials, msiCtx) {
  const msiUnits = msiCtx?.units || '';

  return materials.map((m, i) => {
    const above    = (m.vs_benchmark || '').toLowerCase() === 'above';
    const badgeCls = above ? 'mat-badge--above' : 'mat-badge--below';
    const badgeTxt = above ? '↑ Above benchmark' : '↓ Below benchmark';

    const msiDisplay = (m.msi_value != null && isFinite(m.msi_value))
      ? Number(m.msi_value).toFixed(3)
      : '—';

    const props = [
      { label: 'E₁',   value: m.E1_GPa   != null ? `${m.E1_GPa} GPa`   : '—' },
      { label: 'E₂',   value: m.E2_GPa   != null ? `${m.E2_GPa} GPa`   : '—' },
      { label: 'G₁₂', value: m.G12_GPa  != null ? `${m.G12_GPa} GPa`  : '—' },
      { label: 'ρ',    value: m.rho_kg_m3 != null ? `${m.rho_kg_m3} kg/m³` : '—' },
    ];

    const propsHTML = props.map(p =>
      `<div class="mat-prop">
        <span class="mat-prop-label">${p.label}</span>
        <span class="mat-prop-value">${p.value}</span>
      </div>`
    ).join('');

    return `
    <div class="mat-card" style="--card-index:${i}">
      <div class="mat-card-header">
        <div class="mat-name-row">
          <span class="mat-index">${i + 1}</span>
          <span class="mat-name">${m.name || 'Unknown Material'}</span>
        </div>
        <span class="mat-badge ${badgeCls}">${badgeTxt}</span>
      </div>
      <div class="mat-props-grid">${propsHTML}</div>
      <div class="mat-msi-row">
        <span class="mat-msi-label">MSI</span>
        <span class="mat-msi-value">${msiDisplay}</span>
        <span class="mat-msi-units">${msiUnits}</span>
      </div>
      <p class="mat-application">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" width="11" height="11">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        ${m.application || ''}
      </p>
    </div>`;
  }).join('');
}
