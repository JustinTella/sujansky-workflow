// ═══════════════════════════════════════════════════════════════════
// GOOGLE SHEETS INTEGRATION
//
// Reads form responses via the public gviz/tq JSON endpoint —
// no API key required as long as the sheet is shared as
// "Anyone with the link can view."
//
// Sheet:  https://docs.google.com/spreadsheets/d/1og96N5wkXKgoJu-28UaNm4r-uMaVYi3vTEGmXdiH2bM
// GID:    658794948  ← the "Form Responses" tab
//
// COLUMN MAPPING (0-based, adjust if form fields change):
//   0 → Timestamp          (auto-added by Google Forms)
//   1 → Patient name       (Last, First)
//   4 → Travel destination (country / city entered in form)
//   5 → Departure date     (date picker field)
//
// To add more fields (email, return date, travel type, etc.),
// increment the column index here and add the key to the object
// returned by parseSheetRows().
// ═══════════════════════════════════════════════════════════════════

const SHEET_ID  = "1og96N5wkXKgoJu-28UaNm4r-uMaVYi3vTEGmXdiH2bM";
const SHEET_GID = "658794948";
const SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${SHEET_GID}`;

// ═══════════════════════════════════════════════════════════════════
// SAMPLE PATIENT DATA  (shown immediately; replaced by sheet data)
// ═══════════════════════════════════════════════════════════════════

const MOCK_PATIENTS = [
  { id: "m001", name: "Morgan Hayes",    destination: "Lima, Peru",           departure: "2026-04-26", submitted: "2026-04-11" },
  { id: "m002", name: "Jordan Lee",      destination: "Lisbon, Portugal",     departure: "2026-04-29", submitted: "2026-04-10" },
  { id: "m003", name: "Avery Morgan",    destination: "Nairobi, Kenya",       departure: "2026-05-02", submitted: "2026-04-12" },
  { id: "m004", name: "Riley Patel",     destination: "Bangkok, Thailand",    departure: "2026-05-15", submitted: "2026-04-08" },
  { id: "m005", name: "Taylor Brooks",   destination: "Cape Town, S. Africa", departure: "2026-06-10", submitted: "2026-04-13" },
];

// ═══════════════════════════════════════════════════════════════════
// CHECKLIST STEPS  (edit here to add / reorder steps)
// ═══════════════════════════════════════════════════════════════════

const CHECKLIST = [
  "Review travel destinations and assess health risks",
  "Determine and schedule required/recommended vaccines",
  "Send patient a meeting invite for pre-travel consultation",
  "Conduct consultation and document recommendations",
  "Follow up with patient post-consultation",
  "Assemble and prepare travel health kit",
  "Mark patient as cleared for travel",
];

// ═══════════════════════════════════════════════════════════════════
// RUNTIME STATE
// ═══════════════════════════════════════════════════════════════════

let patients   = [];
let expandedId = null; // which patient's checklist panel is open

// ── Checklist persistence ────────────────────────────────────────
const STORAGE_KEY = "travelMedicineChecklistState_v2";

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function saveState(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

// ═══════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════

// Memoised "today at midnight" — recalculates on each page load
const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

// Append T00:00:00 to force local-timezone parsing (avoids UTC-offset issues)
function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr + "T00:00:00") - TODAY) / 86_400_000);
}

function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d) ? dateStr : d.toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function departureChip(dateStr) {
  const days = daysUntil(dateStr);
  if (days === null) return `<span class="chip chip-muted">No date</span>`;
  if (days < 0)      return `<span class="chip chip-muted">Departed</span>`;
  if (days === 0)    return `<span class="chip chip-danger">Departs today!</span>`;
  if (days <= 7)     return `<span class="chip chip-danger">Departs in ${days}d</span>`;
  if (days <= 21)    return `<span class="chip chip-warning">Departs in ${days}d</span>`;
  return `<span class="chip">Departs ${fmtDate(dateStr)}</span>`;
}

function getProgress(patientId, state) {
  const ps    = state[patientId] || {};
  const done  = CHECKLIST.filter((_, i) => ps[i]).length;
  const total = CHECKLIST.length;
  const pct   = Math.round(done / total * 100);
  if (done === 0)     return { label: "Not started", cls: "status-not-started", done, total, pct };
  if (done === total) return { label: "Complete",    cls: "status-complete",     done, total, pct };
  return               { label: "In progress",  cls: "status-in-progress",  done, total, pct };
}

// ═══════════════════════════════════════════════════════════════════
// RENDER — Stats bar
// ═══════════════════════════════════════════════════════════════════

function renderStats() {
  const state = loadState();
  let notStarted = 0, inProgress = 0, complete = 0;

  patients.forEach(p => {
    const { cls } = getProgress(p.id, state);
    if      (cls === "status-not-started") notStarted++;
    else if (cls === "status-complete")    complete++;
    else                                   inProgress++;
  });

  document.getElementById("stats-bar").innerHTML = `
    <div class="stat-card stat-not-started">
      <div class="stat-count">${notStarted}</div>
      <div class="stat-label">Not started</div>
    </div>
    <div class="stat-card stat-in-progress">
      <div class="stat-count">${inProgress}</div>
      <div class="stat-label">In progress</div>
    </div>
    <div class="stat-card stat-complete">
      <div class="stat-count">${complete}</div>
      <div class="stat-label">Cleared</div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// RENDER — Patient list
// ═══════════════════════════════════════════════════════════════════

function getFilteredSorted() {
  const q = (document.getElementById("search")?.value || "").toLowerCase().trim();
  const visible = q
    ? patients.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.destination.toLowerCase().includes(q))
    : patients;
  return [...visible].sort((a, b) => new Date(a.departure) - new Date(b.departure));
}

function renderPatients() {
  const container = document.getElementById("patient-list");
  const state     = loadState();
  const sorted    = getFilteredSorted();

  if (!sorted.length) {
    container.innerHTML = '<div class="no-patients">No patients match your search.</div>';
    renderStats();
    return;
  }

  container.innerHTML = sorted.map(p => {
    const prog = getProgress(p.id, state);
    const ps   = state[p.id] || {};

    return `
<article class="patient-card" data-patient-id="${p.id}">

  <button class="patient-summary" type="button" aria-expanded="false">
    <div>
      <h3 class="patient-name">${p.name}</h3>
      <div class="patient-meta">
        <span>${p.destination}</span>
        ${departureChip(p.departure)}
        <span class="chip chip-muted">Submitted ${fmtDate(p.submitted)}</span>
      </div>
    </div>
    <div>
      <div class="progress-pill ${prog.cls}">${prog.label}&nbsp;·&nbsp;${prog.done}/${prog.total}</div>
    </div>
  </button>

  <div class="progress-track">
    <div class="progress-fill ${prog.cls}" style="width:${prog.pct}%"></div>
  </div>

  <div class="patient-details" id="details-${p.id}">
    <div class="checklist">
      ${CHECKLIST.map((task, i) => {
        const checked = !!ps[i];
        return `
        <label class="checklist-item${checked ? " completed" : ""}">
          <input
            type="checkbox"
            data-patient-id="${p.id}"
            data-task-index="${i}"
            ${checked ? "checked" : ""}
          />
          <span class="checklist-item-text">${task}</span>
        </label>`;
      }).join("")}
    </div>
    <div class="checklist-footer">
      <button class="reset-btn" type="button" data-patient-id="${p.id}">
        Reset checklist
      </button>
    </div>
  </div>

</article>`;
  }).join("");

  attachEvents();
  restoreExpanded();
  renderStats();
}

// Re-open whichever patient panel was open before a re-render
function restoreExpanded() {
  if (!expandedId) return;
  const card = document.querySelector(`[data-patient-id="${expandedId}"]`);
  if (!card) return;
  const btn     = card.querySelector(".patient-summary");
  const details = document.getElementById(`details-${expandedId}`);
  if (btn && details) {
    btn.setAttribute("aria-expanded", "true");
    details.classList.add("active");
  }
}

// ═══════════════════════════════════════════════════════════════════
// TARGETED DOM UPDATE — avoids re-rendering the full list when a
// checkbox changes state (which would collapse the open panel).
// ═══════════════════════════════════════════════════════════════════

function updatePatientProgress(patientId, state) {
  const prog = getProgress(patientId, state);
  const card = document.querySelector(`[data-patient-id="${patientId}"]`);
  if (!card) return;

  const pill = card.querySelector(".progress-pill");
  if (pill) {
    pill.textContent = `${prog.label} · ${prog.done}/${prog.total}`;
    pill.className   = `progress-pill ${prog.cls}`;
  }

  const fill = card.querySelector(".progress-fill");
  if (fill) {
    fill.style.width = `${prog.pct}%`;
    fill.className   = `progress-fill ${prog.cls}`;
  }
}

// ═══════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════

function attachEvents() {

  // ── Expand / collapse ──────────────────────────────────────────
  document.querySelectorAll(".patient-summary").forEach(btn => {
    btn.addEventListener("click", () => {
      const patientId = btn.closest(".patient-card").dataset.patientId;
      const details   = document.getElementById(`details-${patientId}`);
      const isOpen    = btn.getAttribute("aria-expanded") === "true";

      btn.setAttribute("aria-expanded", String(!isOpen));
      details.classList.toggle("active", !isOpen);
      expandedId = !isOpen ? patientId : null;
    });
  });

  // ── Checkboxes — targeted update, panel stays open ────────────
  document.querySelectorAll(".checklist-item input[type='checkbox']").forEach(cb => {
    cb.addEventListener("change", () => {
      const patientId  = cb.dataset.patientId;
      const taskIndex  = Number(cb.dataset.taskIndex);
      const state      = loadState();

      if (!state[patientId]) state[patientId] = {};
      state[patientId][taskIndex] = cb.checked;
      saveState(state);

      // Strikethrough on the label
      cb.closest(".checklist-item").classList.toggle("completed", cb.checked);

      // Update badge + progress bar without touching the open panel
      updatePatientProgress(patientId, state);

      // Refresh summary counts
      renderStats();
    });
  });

  // ── Reset buttons ──────────────────────────────────────────────
  document.querySelectorAll(".reset-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const patientId = btn.dataset.patientId;
      const state     = loadState();
      state[patientId] = {};
      saveState(state);

      // Uncheck every box in this patient's panel
      const details = document.getElementById(`details-${patientId}`);
      if (details) {
        details.querySelectorAll(".checklist-item").forEach(item => {
          item.classList.remove("completed");
          item.querySelector("input").checked = false;
        });
      }

      updatePatientProgress(patientId, state);
      renderStats();
    });
  });
}

// Called by the search input's oninput
function onSearch() {
  renderPatients();
}

// ═══════════════════════════════════════════════════════════════════
// SHEET DATA PARSING
// ═══════════════════════════════════════════════════════════════════

function normalizeSheetText(text) {
  // Strip the gviz JSONP wrapper:  google.visualization.Query.setResponse({...});
  const jsonText = text
    .replace(/^[^\(]*\(/, "")
    .replace(/\)\s*;?\s*$/, "");

  // Convert Sheets date literals  Date(YYYY,M,D)  →  ISO strings
  return jsonText.replace(
    /Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)/g,
    (_, y, m, d, h = 0, mi = 0, s = 0) =>
      `"${y}-${String(+m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` +
      `T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}Z"`
  );
}

function parseDateValue(v) {
  if (!v && v !== 0) return "";
  const d = new Date(typeof v === "number" ? v : String(v));
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

function parseSheetRows(table) {
  return (table.rows || []).map((row, i) => {
    const cells = row.c || [];
    const get   = idx => cells[idx]?.v ?? null;

    // Adjust these indices if the form column order ever changes
    const submitted   = parseDateValue(get(0));
    const name        = String(get(1) ?? "Unknown patient").trim();
    const destination = String(get(4) ?? "Unknown destination").trim();
    const departure   = parseDateValue(get(5));

    return {
      id:          `sheet-${name.replace(/\s+/g, "-").toLowerCase()}-${i}`,
      name,
      destination,
      departure,
      submitted,
    };
  });
}

async function fetchSheetPatients() {
  const res  = await fetch(SHEET_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const data = JSON.parse(normalizeSheetText(text));
  if (!data?.table) throw new Error("Unexpected response shape");
  return parseSheetRows(data.table);
}

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════

async function init() {
  // Show mock data immediately so the page feels instant
  patients = MOCK_PATIENTS;
  renderPatients();

  // Then try to load real submissions from the sheet
  try {
    const sheetPatients = await fetchSheetPatients();
    if (sheetPatients.length) {
      patients = sheetPatients;
      renderPatients();
      console.info(`Loaded ${sheetPatients.length} patient(s) from Google Sheets.`);
    } else {
      console.info("Sheet returned no rows — keeping sample data.");
    }
  } catch (err) {
    console.warn("Google Sheet unavailable, using sample data:", err.message);
  }
}

init();
