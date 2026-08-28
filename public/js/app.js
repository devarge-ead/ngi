/**
 * Single-page orchestration for the Inhaler Result Analyzer.
 * Flow: pick/capture photo -> confirm -> OCR -> table detection ->
 *       batch grouping -> tabbed results with NGI calculations.
 *
 * The raw OCR output and detected-table lists are intentionally NOT shown
 * in the UI.
 */
import { runOcr, getService } from "./ocr.js";
import { detectTables } from "./tableParser.js";
import { buildBatches } from "./batches.js";
import { normalizeSampleName, detectDosageForm, STAGE_ORDER } from "./samples.js";
import { buildMassTable, deliveredDose } from "./calculations.js";
import { calculateFPD } from "./fpd.js";
import { calculateMMAD } from "./mmad.js";
import { calculateGSD } from "./gsd.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  uploadCard: $("#uploadCard"),
  previewCard: $("#previewCard"),
  resultsCard: $("#resultsCard"),
  fileDisk: $("#fileDisk"),
  btnDisk: $("#btnDisk"),
  preview: $("#preview"),
  btnRotateCcw: $("#btnRotateCcw"),
  btnRotateCw: $("#btnRotateCw"),
  btnChange: $("#btnChange"),
  btnDownload: $("#btnDownload"),
  btnAnalyze: $("#btnAnalyze"),
  status: $("#status"),
  timing: $("#timing"),
  message: $("#message"),
  tabs: $("#tabs"),
  tabContent: $("#tabContent"),
  emptyMsg: $("#emptyMsg"),
  dosageBadge: $("#dosageBadge"),
  missingMsg: $("#missingMsg"),
  calcControls: $("#calcControls"),
  flowRate: $("#flowRate"),
  unitRow: $("#unitRow"),
  deliveredDose: $("#deliveredDose"),
  flowMsg: $("#flowMsg"),
  massTableWrap: $("#massTableWrap"),
  massTbody: $("#massTbody"),
  calcNote: $("#calcNote"),
  fpdTbody: $("#fpdTbody"),
  mmadValue: $("#mmadValue"),
  gsdValue: $("#gsdValue"),
  gsdNote: $("#gsdNote"),
  sampleTable: $("#sampleTable"),
  sampleTbody: $("#sampleTable tbody"),
};

let currentBatches = null; // { [id]: { samples: { canonical: conc } } }
let currentOrder = [];
let activeId = null;
let currentPhotoDataUrl = null;
const perId = {}; // { [id]: { unit: 'ug'|'mg' } }
let serviceReady = false; // becomes true once the OCR model is fully loaded

function showEl(el, show) {
  el.classList.toggle("hidden", !show);
}

function showMessage(text, type = "error") {
  els.message.textContent = text;
  els.message.className = `message ${type}`;
}

function setStatus(text) {
  if (text) {
    els.status.textContent = text;
    showEl(els.status, true);
  } else {
    showEl(els.status, false);
  }
}

function loadPreview(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    currentPhotoDataUrl = e.target.result;
    els.preview.src = currentPhotoDataUrl;
    showEl(els.uploadCard, false);
    showEl(els.previewCard, true);
    showEl(els.resultsCard, false);
    showEl(els.btnDownload, true);
    setStatus(null);
    els.btnAnalyze.disabled = false;
  };
  reader.readAsDataURL(file);
}

els.btnDisk.addEventListener("click", () => els.fileDisk.click());

els.fileDisk.addEventListener("change", (e) => loadPreview(e.target.files[0]));

/**
 * Rotate the current preview image by the given angle (multiple of 90 deg).
 * The result is re-rendered onto a canvas and both the preview <img> and the
 * shared data URL are updated, so analysis AND download always use the current
 * (rotated) version.
 */
function rotatePreview(deltaDeg) {
  const img = els.preview;
  if (!img.src || !img.naturalWidth) return;
  const deg = ((deltaDeg % 360) + 360) % 360;
  const swap = deg === 90 || deg === 270;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? img.naturalHeight : img.naturalWidth;
  canvas.height = swap ? img.naturalWidth : img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  currentPhotoDataUrl = canvas.toDataURL("image/png");
  img.src = currentPhotoDataUrl;
}

els.btnRotateCw.addEventListener("click", () => rotatePreview(90));
els.btnRotateCcw.addEventListener("click", () => rotatePreview(-90));

els.btnChange.addEventListener("click", () => {
  els.fileDisk.value = "";
  currentPhotoDataUrl = null;
  els.preview.removeAttribute("src");
  showEl(els.btnDownload, false);
  showEl(els.previewCard, false);
  showEl(els.uploadCard, true);
});

els.btnDownload.addEventListener("click", () => {
  if (!currentPhotoDataUrl) return;
  const a = document.createElement("a");
  a.href = currentPhotoDataUrl;
  a.download = "analysis-photo.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
});

/** Draw the current preview image onto a canvas for the OCR model. */
function imageToCanvas(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return canvas;
}

/** Turn a raw batch map (OCR names) into canonical sample keys. */
function toCanonicalSamples(batch) {
  const out = {};
  for (const raw of Object.keys(batch || {})) {
    const canon = normalizeSampleName(raw);
    out[canon] = batch[raw];
  }
  return out;
}

function formatNum(v, decimals) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toFixed(decimals);
}

// Display label for the selected unit ("ug" -> "μg", "mg" -> "mg").
function unitLabel(unit) {
  return unit === "ug" ? "μg" : unit;
}

function td(text) {
  const el = document.createElement("td");
  el.textContent = text;
  return el;
}
els.btnAnalyze.addEventListener("click", async () => {
  const img = els.preview;
  if (!img.src) return;
  els.btnAnalyze.disabled = true;
  setStatus(
    serviceReady
      ? "Analyzing photo…"
      : "Loading OCR model (preloading started on page load)…",
  );
  showMessage("", "info");

  try {
    const t_start = performance.now();
    const canvas = imageToCanvas(img);
    const { result, detections } = await runOcr(canvas);
    const t_ocr = performance.now();

    if (globalThis.__DEBUG_OCR__) {
      console.log("[OCR] raw result", result);
      console.log("[OCR] normalized detections", detections);
    }

    if (!detections.length) {
      setStatus(null);
      showMessage("No text was detected in the image. Try a sharper photo.");
      return;
    }

    setStatus("Locating analysis table in the photo…");
    const tables = detectTables(detections);
    if (globalThis.__DEBUG_OCR__) console.log("[OCR] detected tables", tables);

    const { batches, order } = buildBatches(tables);
    if (!order.length) {
      setStatus(null);
      showMessage(
        "No analysis table was recognized. Please check the photo (focus, framing, lighting).",
      );
      return;
    }

    const t_detect = performance.now();

    currentBatches = {};
    currentOrder = order;
    for (const id of order) {
      currentBatches[id] = { samples: toCanonicalSamples(batches[id]) };
      perId[id] = { unit: "ug" };
    }

    // Report only OCR + table/series detection time (not the calculations).
    const detectionMs = Math.round(t_detect - t_start);
    const ocrMs = Math.round(t_ocr - t_start);
    els.timing.textContent = `Analysis completed in ${detectionMs} ms · OCR ${ocrMs} ms`;
    showEl(els.timing, true);

    setStatus("Building batch results…");
    renderTabs();
    setStatus(null);
  } catch (err) {
    console.error(err);
    setStatus(null);
    showMessage(`Analysis failed: ${err && err.message ? err.message : err}`, "error");
    els.btnAnalyze.disabled = false;
  }
});

/** Render one pill tab per Sample ID. */
function renderTabs() {
  els.tabs.textContent = "";
  currentOrder.forEach((id) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.dataset.id = id;
    tab.textContent = id;
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => setActive(id));
    els.tabs.appendChild(tab);
  });
  showEl(els.resultsCard, true);

  if (currentOrder.length) setActive(currentOrder[0]);
}

/** Show the content for the given Sample ID (dosage form + calculations). */
function setActive(id) {
  activeId = id;
  if (!perId[id]) perId[id] = { unit: "ug" };

  els.tabs.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.id === id);
  });

  renderBatch();
}

function renderBatch() {
  const { samples } = currentBatches[activeId];
  const dosage = detectDosageForm(samples);
  const unit = perId[activeId].unit;

  // Dosage badge / missing warning.
  if (dosage.form !== null) {
    els.dosageBadge.textContent = dosage.form;
    els.dosageBadge.className = `badge ${dosage.form.toLowerCase()}`;
    showEl(els.dosageBadge, true);
    showEl(els.missingMsg, false);
  } else {
    els.dosageBadge.className = "badge hidden";
    els.missingMsg.textContent = `Missing results: ${dosage.missing.join(", ")}`;
    showEl(els.missingMsg, true);
  }

  // Calculation controls + sample table.
  const canCalculate = dosage.form !== null;
  showEl(els.calcControls, canCalculate);
  showEl(els.sampleTable, true);

  // Unit selection state.
  els.unitRow.querySelectorAll(".unit-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.unit === unit);
  });

  renderSampleTable(samples);

  if (canCalculate) {
    els.massTbody.textContent = "";
    renderCalculations();
  }
}

function renderSampleTable(samples) {
  els.sampleTbody.textContent = "";
  const names = Object.keys(samples).sort();
  if (!names.length) {
    showEl(els.emptyMsg, true);
    return;
  }
  showEl(els.emptyMsg, false);
  for (const name of names) {
    const tr = document.createElement("tr");
    tr.appendChild(td(name));

    const tdConc = document.createElement("td");
    tdConc.className = "num";
    const input = document.createElement("input");
    input.type = "number";
    input.className = "cell-input";
    input.step = "any";
    // Only the analysis samples (stages, mouth/throat, preseparator) are
    // editable; other OCR rows (if any) stay read-only text.
    const editable = ["AGIZ", "BOGAZ", "PRESEPARATOR"].includes(name) ||
      /^STAGE \d+$/.test(name);
    input.value = samples[name] === null ? "" : formatNum(samples[name], 3);
    if (!editable) input.disabled = true;
    input.addEventListener("input", () => {
      const v = input.value === "" ? null : Number(input.value);
      samples[name] = Number.isFinite(v) ? v : null;
      if (editable && currentBatches[activeId]) renderCalculations();
    });
    tdConc.appendChild(input);
    tr.appendChild(tdConc);
    els.sampleTbody.appendChild(tr);
  }
}

function renderCalculations() {
  const { samples } = currentBatches[activeId];
  const unit = perId[activeId].unit;
  const flowRate = Number(els.flowRate.value);

  if (!(flowRate > 0)) {
    // No flow rate -> hide the mass table and ask the user for it.
    showEl(els.massTableWrap, false);
    showEl(els.flowMsg, true);
    els.deliveredDose.textContent = "";
    return;
  }

  showEl(els.massTableWrap, true);
  showEl(els.flowMsg, false);

  if (!STAGE_ORDER.every((s) => typeof samples[s] === "number")) {
    els.calcNote.textContent = "Some stage masses are missing; calculations cannot run.";
    showEl(els.massTableWrap, false);
    return;
  }

  const dose = deliveredDose(samples);
  els.deliveredDose.textContent = `${formatNum(dose, 3)} ${unitLabel(unit)}`;

  const rows = buildMassTable(samples, flowRate);
  els.massTbody.textContent = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.appendChild(td(r.stage));
    tr.appendChild(td(r.cutoff === null ? "—" : `${formatNum(r.cutoff, 3)} μm`));
    tr.appendChild(td(`${formatNum(r.mass, 3)} ${unitLabel(unit)}`));
    tr.appendChild(td(`${formatNum(r.cumMass, 3)} ${unitLabel(unit)}`));
    tr.appendChild(td(`${formatNum(r.cumPct, 2)}%`));
    els.massTbody.appendChild(tr);
  }

  renderAerodynamicResults(rows, dose, unit);

  els.calcNote.textContent = "";
}

/** Fill FPD / MMAD / GSD cards from the mass table. */
function renderAerodynamicResults(rows, deliveredTotal, unit) {
  const usable = rows.filter((r) => r.logCutoff !== null && isFinite(r.logCutoff));
  const stage1Row = rows[rows.length - 1];
  const stage1Cum = stage1Row ? stage1Row.cumMass : 0;

  // FPD for three thresholds.
  const thresholds = [1.5, 3.0, 5.0];
  els.fpdTbody.textContent = "";
  for (const thr of thresholds) {
    const res = calculateFPD({
      rows,
      threshold: thr,
      stage1Cum,
      deliveredDose: deliveredTotal,
    });
    const tr = document.createElement("tr");
    tr.appendChild(td(`${formatNum(thr, 2)}`));
    tr.appendChild(tdWithVal(res.fpd === "LOD" ? "LOD" : `${formatNum(res.fpd, 3)} ${unitLabel(unit)}`, res.fpd === "LOD"));
    tr.appendChild(tdWithVal(res.fpdPct === "LOD" ? "LOD" : `${formatNum(res.fpdPct, 3)}%`, res.fpdPct === "LOD"));
    els.fpdTbody.appendChild(tr);
  }

  // MMAD (probit 5) plus values at probit 4/6 for GSD reporting.
  const mmad = calculateMMAD({ rows: usable, probitTarget: 5 });
  els.mmadValue.textContent = typeof mmad === "number"
    ? `${formatNum(mmad, 3)} μm`
    : mmad;
  if (typeof mmad === "string") els.mmadValue.classList.add("value-lod");
  else els.mmadValue.classList.remove("value-lod");

  // GSD (needs MMAD plus fit details).
  const gsd = calculateGSD({ rows: usable, mmad: typeof mmad === "number" ? mmad : NaN });
  els.gsdValue.textContent = typeof gsd.gsd === "number" ? formatNum(gsd.gsd, 3) : String(gsd.gsd);
  if (typeof gsd.gsd === "string") els.gsdValue.classList.add("value-lod");
  else els.gsdValue.classList.remove("value-lod");
  const r2txt = gsd.r2 === "NA" ? "NA" : formatNum(gsd.r2, 3);
  els.gsdNote.textContent = `n=${gsd.n} · Slope ${formatNum(gsd.slope, 3)} · Intercept ${formatNum(gsd.intercept, 3)} · R² ${r2txt}`;
}

/** Create a <td> with an optional LOD highlight. */
function tdWithVal(text, isLod) {
  const el = td(text);
  if (isLod) el.classList.add("value-lod");
  return el;
}

// Flow rate input triggers recalculation.
els.flowRate.addEventListener("input", () => {
  if (activeId && currentBatches[activeId]) renderCalculations();
});

// Unit selection triggers recalculation.
els.unitRow.addEventListener("click", (e) => {
  const btn = e.target.closest(".unit-btn");
  if (!btn || !activeId) return;
  perId[activeId].unit = btn.dataset.unit;
  renderBatch();
});

// Reset results UX on first load.
showEl(els.resultsCard, false);
showEl(els.status, false);

// Start loading the OCR model immediately in the background. getService() is a
// singleton promise, so this warm-up and the later runOcr() call share the same
// in-flight load/initialize. If the user clicks Analyze before it finishes, the
// runOcr() await simply waits for this same promise — no double loading.
getService()
  .then(() => {
    serviceReady = true;
  })
  .catch((err) => {
    console.error("Failed to preload OCR model:", err);
  });

