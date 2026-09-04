/**
 * Single-page orchestration for the Inhaler Result Analyzer.
 * Flow: pick/capture photo -> confirm -> OCR -> table detection ->
 *       single-series result with NGI calculations.
 *
 * The raw OCR output and detected-table lists are intentionally NOT shown
 * in the UI.
 */
import { runOcr, getService } from "./ocr.js";
import { detectTables } from "./tableParser.js";
import { buildBatches } from "./batches.js";
import { detectDosageForm, STAGE_ORDER, SAMPLE_ORDER, FLOW_RATE_OPTIONS, FLOW_RATE_DEFAULTS } from "./samples.js";
import { buildMassTable, deliveredDose, meteredDose } from "./calculations.js";
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
  btnDownloadHighlight: $("#btnDownloadHighlight"),
  btnAnalyze: $("#btnAnalyze"),
  status: $("#status"),
  timing: $("#timing"),
  message: $("#message"),
  emptyMsg: $("#emptyMsg"),
  dosageBadge: $("#dosageBadge"),
  missingMsg: $("#missingMsg"),
  calcControls: $("#calcControls"),
  flowRow: $("#flowRow"),
  unitRow: $("#unitRow"),
  deliveredDose: $("#deliveredDose"),
  meteredDose: $("#meteredDose"),
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

let currentBatches = null; // { series: { samples: { canonical: conc } } }
let activeId = null; // always the single series key ("series")
let currentPhotoDataUrl = null;
// Data URL of the image with every OCR-detected text box painted in a
// translucent highlight colour (built after each analysis; downloadable only).
let currentHighlightedDataUrl = null;
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

/**
 * Yield to the browser so it can actually paint pending UI updates before a
 * heavy, synchronous block (the WASM OCR inference) runs.
 *
 * Without this, setStatus()/button-label updates are batched by the event
 * loop and never rendered on screen — the tab appears to "do nothing" for the
 * whole analysis and results just pop in at the end. The double rAF + macrotask
 * makes sure a frame has been committed before we continue.
 */
function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  });
}

function loadPreview(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    currentPhotoDataUrl = e.target.result;
    currentHighlightedDataUrl = null;
    els.preview.src = currentPhotoDataUrl;
    showEl(els.uploadCard, false);
    showEl(els.previewCard, true);
    showEl(els.resultsCard, false);
    showEl(els.btnDownload, true);
    showEl(els.btnDownloadHighlight, false);
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
  currentHighlightedDataUrl = null;
  els.preview.removeAttribute("src");
  showEl(els.btnDownload, false);
  showEl(els.btnDownloadHighlight, false);
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

els.btnDownloadHighlight.addEventListener("click", () => {
  if (!currentHighlightedDataUrl) return;
  const a = document.createElement("a");
  a.href = currentHighlightedDataUrl;
  a.download = "ocr-highlighted.png";
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

// Translucent highlighter-pen colours used to paint every OCR text box.
// Each detection gets the next colour in sequence (cycling back to the start).
const HIGHLIGHT_COLORS = [
  "rgba(255, 213, 0, 0.40)",   // yellow
  "rgba(0, 199, 255, 0.35)",   // blue
  "rgba(0, 230, 118, 0.35)",   // green
  "rgba(255, 82, 82, 0.35)",   // red
  "rgba(255, 171, 64, 0.40)",  // orange
  "rgba(171, 71, 188, 0.35)",  // purple
];

/**
 * Build a PNG data URL of the given image with every OCR text box painted in a
 * translucent highlight colour. Boxes come from toDetections() and are already
 * in the original image pixel space, so they line up with naturalWidth/Height.
 * The result is only ever downloaded (never shown in the UI).
 */
function buildHighlightedImage(img, detections) {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  detections.forEach((det, i) => {
    ctx.fillStyle = HIGHLIGHT_COLORS[i % HIGHLIGHT_COLORS.length];
    ctx.fillRect(det.x, det.y, det.w, det.h);
  });
  return canvas.toDataURL("image/png");
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
  els.btnAnalyze.innerHTML = '<span class="icon spinner"></span> Analyzing…';
  setStatus(
    serviceReady
      ? "Analyzing photo…"
      : "Loading OCR model (preloading started on page load)…",
  );
  showMessage("", "info");

  // Yield to the browser so the "Analyzing…" message is actually painted
  // before the heavy (blocking) OCR inference below. Without this the status
  // update is batched and never appears — the UI looks frozen / do-nothing.
  await nextPaint();

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

    // Paint every detected text box on the image so the user can download it
    // and inspect what the OCR actually saw — useful for failed analyses.
    currentHighlightedDataUrl = buildHighlightedImage(img, detections);
    showEl(els.btnDownloadHighlight, true);

    setStatus("Locating analysis table in the photo…");
    await nextPaint();
    const tables = detectTables(detections);
    if (globalThis.__DEBUG_OCR__) console.log("[OCR] detected tables", tables);

    const { samples } = buildBatches(tables);
    if (!Object.keys(samples).length) {
      setStatus(null);
      showMessage(
        "No analysis table was recognized. Please check the photo (focus, framing, lighting).",
      );
      return;
    }

    const t_detect = performance.now();

    currentBatches = { series: { samples } };
    perId.series = { unit: "ug" };

    // Report only OCR + table/series detection time (not the calculations).
    const detectionMs = Math.round(t_detect - t_start);
    const ocrMs = Math.round(t_ocr - t_start);
    els.timing.textContent = `Analysis completed in ${detectionMs} ms · OCR ${ocrMs} ms`;
    showEl(els.timing, true);

    setStatus("Building results…");
    await nextPaint();
    renderResults();
    setStatus(null);
  } catch (err) {
    console.error(err);
    setStatus(null);
    showMessage(`Analysis failed: ${err && err.message ? err.message : err}`, "error");
  } finally {
    els.btnAnalyze.innerHTML = '<span class="icon">&#128269;</span> Analyze';
    els.btnAnalyze.disabled = false;
  }
});

/** Render the result view for the single series (no tabs). */
function renderResults() {
  showEl(els.resultsCard, true);
  setActive();
}

/** Show the content for the single series (dosage form + calculations). */
function setActive() {
  activeId = "series";
  if (!perId[activeId]) perId[activeId] = { unit: "ug" };

  renderBatch();
}

function renderBatch() {
  const { samples } = currentBatches[activeId];
  const dosage = detectDosageForm(samples);
  const unit = perId[activeId].unit;
  perId[activeId].form = dosage.form; // remembered for edit-triggered re-renders

  // Dosage badge / missing warning.
  if (dosage.form !== null) {
    els.dosageBadge.textContent = dosage.form;
    els.dosageBadge.className = `badge ${dosage.form.toLowerCase()}`;
    showEl(els.dosageBadge, true);
    const conflicts = dosage.conflicts ?? [];
    if (conflicts.length) {
      els.missingMsg.textContent = `Warning: ${conflicts.join("; ")}`;
      showEl(els.missingMsg, true);
    } else {
      showEl(els.missingMsg, false);
    }
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

  // Flow rate choices depend on the detected dosage form; the selected value
  // is remembered per batch. Unset (or no-longer-valid) selections fall back
  // to the form's default.
  els.flowRow.textContent = "";
  const flowOptions = dosage.form !== null ? FLOW_RATE_OPTIONS[dosage.form] ?? [] : [];
  if (
    flowOptions.length &&
    (perId[activeId].flowRate === undefined ||
      !flowOptions.includes(perId[activeId].flowRate))
  ) {
    perId[activeId].flowRate = FLOW_RATE_DEFAULTS[dosage.form];
  }
  for (const rate of flowOptions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "unit-btn flow-btn";
    btn.dataset.rate = rate;
    btn.textContent = formatNum(rate, 1);
    btn.classList.toggle("active", perId[activeId].flowRate === rate);
    els.flowRow.appendChild(btn);
  }

  renderSampleTable(samples);

  if (canCalculate) {
    els.massTbody.textContent = "";
    renderCalculations();
  }
}

function renderSampleTable(samples) {
  els.sampleTbody.textContent = "";
  // Display order follows SAMPLE_ORDER (Device first, Spacer second, ...);
  // stages are shown 1 -> 8 in this table (the mass table keeps MOC -> 1);
  // unknown names go last, alphabetically.
  const orderIdx = (n) => {
    if (/^STAGE \d+$/.test(n)) {
      const num = Number(n.replace(/\D/g, "")) || 1;
      return SAMPLE_ORDER.indexOf("STAGE 8") + (num - 1);
    }
    const i = SAMPLE_ORDER.indexOf(n);
    return i === -1 ? SAMPLE_ORDER.length : i;
  };
  const names = Object.keys(samples).sort(
    (a, b) => orderIdx(a) - orderIdx(b) || a.localeCompare(b),
  );
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
    // Only the analysis samples (stages, mouth/throat, preseparator and the
    // pre/post-measurement items) are editable; other OCR rows stay
    // read-only text.
    const editable = [
      "SPACER", "CIHAZ", "NEBULIZATOR",
      "AGIZ", "BOGAZ", "PRESEPARATOR", "FILTER",
    ].includes(name) || /^STAGE \d+$/.test(name);
    input.value = samples[name] === null ? "" : formatNum(samples[name], 3);
    if (!editable) input.disabled = true;
    input.addEventListener("input", () => {
      const v = input.value === "" ? null : Number(input.value);
      samples[name] = Number.isFinite(v) ? v : null;
      if (editable && currentBatches[activeId]) {
        // A value edit can change the detected dosage form (e.g. removing
        // PRESEPARATOR); rebuild the batch view in that case.
        const { form } = detectDosageForm(samples);
        if (form !== perId[activeId].form) renderBatch();
        else renderCalculations();
      }
    });
    tdConc.appendChild(input);
    tr.appendChild(tdConc);
    els.sampleTbody.appendChild(tr);
  }
}

function renderCalculations() {
  const { samples } = currentBatches[activeId];
  const unit = perId[activeId].unit;
  const flowRate = perId[activeId].flowRate;

  if (!(flowRate > 0)) {
    // No flow rate -> hide the mass table and ask the user for it.
    showEl(els.massTableWrap, false);
    showEl(els.flowMsg, true);
    els.deliveredDose.textContent = "";
    els.meteredDose.textContent = "";
    return;
  }

  showEl(els.massTableWrap, true);
  showEl(els.flowMsg, false);

  if (!STAGE_ORDER.every((s) => typeof samples[s] === "number")) {
    els.calcNote.textContent = "Some stage masses are missing; calculations cannot run.";
    showEl(els.massTableWrap, false);
    return;
  }

  const metered = meteredDose(samples);
  els.meteredDose.textContent = `${formatNum(metered, 3)} ${unitLabel(unit)}`;

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
    // The 5.0 μm threshold is the primary result: highlight the whole row
    // (palette green, as used by the DPI badge).
    if (thr === 5.0) tr.classList.add("fpd-row-primary");
    tr.appendChild(td(`≤ ${formatNum(thr, 2)}`));
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

// Flow rate selection (fixed choices per dosage form) triggers recalculation.
els.flowRow.addEventListener("click", (e) => {
  const btn = e.target.closest(".flow-btn");
  if (!btn || !activeId) return;
  perId[activeId].flowRate = Number(btn.dataset.rate);
  els.flowRow.querySelectorAll(".flow-btn").forEach((b) => {
    b.classList.toggle("active", b === btn);
  });
  renderCalculations();
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

