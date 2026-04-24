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
// COLUMN MAPPING (confirmed from live sheet data):
//   0  → Timestamp
//   1  → Name (Last, First)
//   2  → Number of countries visiting
//   3  → Purpose of travel
//
//   1-country section:
//     4  → Country
//     5  → Start date
//     46 → End / return date
//
//   2-country section:
//     6–8  → Country 1, start, end
//     9–11 → Country 2, start, end
//
//   3-country section:
//     12–14 → Country 1, start, end
//     15–17 → Country 2, start, end
//     18–20 → Country 3, start, end
//
//   4-country section:
//     21–23 → Country 1, start, end
//     24–26 → Country 2, start, end
//     27–29 → Country 3, start, end
//     30–32 → Country 4, start, end
//
//   5-country section:
//     33–35 → Country 1, start, end
//     36–38 → Country 2, start, end
//     39–41 → Country 3, start, end
//     42–44 → Country 4, start, end
//
//   City columns (shared across ALL sections — confirmed from live gviz data):
//     58 → City for 1st stop
//     59 → City for 2nd stop
//     60 → City for 3rd stop
//     61 → City for 4th stop
//
//   47 → Concerns / questions
//   48 → End date of travel (1-country)
// ═══════════════════════════════════════════════════════════════════

const SHEET_ID  = "1og96N5wkXKgoJu-28UaNm4r-uMaVYi3vTEGmXdiH2bM";
const SHEET_GID = "658794948";
const SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${SHEET_GID}`;


// ═══════════════════════════════════════════════════════════════════
// CHECKLIST STEPS
// ═══════════════════════════════════════════════════════════════════

const CHECKLIST = [
  {
    text: "Enter patient in Travax and generate report",
    link: { href: "https://www.travax.com/", label: "Open Travax ↗" },
  },
  { text: "Determine and order recommended vaccines" },
  { text: "Schedule patient appointment for pre-travel consultation and vaccine administration",
    note: "Schedule once vaccines have arrived" },
  { text: "Write and order prescriptions" },
  {
    text: "Assemble travel kit",
    link: { href: "file:///C:/Users/jtell/Downloads/travel_kit.html", label: "Open travel kit menu ↗" },
  },
  { text: "Conduct patient appointment, administer vaccines, assign prescriptions, and provide the travel kit" },
  { text: "Schedule any follow-ups if necessary" },
  { text: "Mark patient cleared for travel" },
];

// ═══════════════════════════════════════════════════════════════════
// RUNTIME STATE
// ═══════════════════════════════════════════════════════════════════

let patients   = [];
let expandedId = null;

// ── Persistence ──────────────────────────────────────────────────
const STORAGE_KEY = "travelMedicineChecklistState_v2";
const ARCHIVE_KEY = "travelMedicineArchiveState_v1";

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function saveState(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function loadArchive() {
  try { return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]"); }
  catch { return []; }
}

function saveArchive(ids) {
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(ids));
}

// ═══════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════

const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

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

function firstDeparture(p) {
  return p.stops?.[0]?.arrival ?? "";
}

function departureChip(p) {
  const dateStr = firstDeparture(p);
  const days    = daysUntil(dateStr);
  if (days === null) return `<span class="chip chip-muted">No date</span>`;
  if (days < 0)      return `<span class="chip chip-muted">Departed</span>`;
  if (days === 0)    return `<span class="chip chip-danger">Departs today!</span>`;
  if (days <= 7)     return `<span class="chip chip-danger">Departs in ${days}d</span>`;
  if (days <= 30)    return `<span class="chip chip-warning">Departs in ${days}d</span>`;
  return `<span class="chip chip-muted">Departs ${fmtDate(dateStr)}</span>`;
}

function countryCount(stops) {
  return new Set((stops || []).map(s => s.country).filter(Boolean)).size;
}

function destinationLabel(stops) {
  if (!stops || !stops.length) return "Unknown destination";
  const first = [stops[0].country, stops[0].city].filter(Boolean).join(", ");
  if (stops.length === 1) return first;
  return `${first} + ${stops.length - 1} more`;
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

const ARCHIVE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;

// ═══════════════════════════════════════════════════════════════════
// SYNC STATUS
// ═══════════════════════════════════════════════════════════════════

function setSyncStatus(state, text) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.dataset.state = state;
  el.textContent   = text;
}

// ═══════════════════════════════════════════════════════════════════
// RENDER — Stats bar (3 cards: Not Started / In Progress / Cleared·Archived)
// ═══════════════════════════════════════════════════════════════════

function renderStats() {
  const state    = loadState();
  const archived = loadArchive();
  let notStarted = 0, inProgress = 0, complete = 0;

  patients
    .filter(p => !archived.includes(p.id))
    .forEach(p => {
      const { cls } = getProgress(p.id, state);
      if      (cls === "status-not-started") notStarted++;
      else if (cls === "status-complete")    complete++;
      else                                   inProgress++;
    });

  const archivedCount   = archived.filter(id => patients.some(p => p.id === id)).length;
  const clearedArchived = complete + archivedCount;
  const drawerOpen      = document.getElementById("archive-drawer").dataset.open === "true";

  document.getElementById("stats-bar").innerHTML = `
    <div class="stat-card stat-not-started">
      <div class="stat-count">${notStarted}</div>
      <div class="stat-label">Not started</div>
    </div>
    <div class="stat-card stat-in-progress">
      <div class="stat-count">${inProgress}</div>
      <div class="stat-label">In progress</div>
    </div>
    <button class="stat-archived${drawerOpen ? " stat-archive-active" : ""}" id="archived-stat-btn" type="button">
      <div class="stat-count">${clearedArchived}</div>
      <div class="stat-label">Cleared / Archived ${drawerOpen ? "▲" : "▼"}</div>
    </button>
  `;

  document.getElementById("archived-stat-btn").addEventListener("click", toggleArchiveDrawer);
}

// ═══════════════════════════════════════════════════════════════════
// ARCHIVE DRAWER
// ═══════════════════════════════════════════════════════════════════

function toggleArchiveDrawer() {
  const drawer = document.getElementById("archive-drawer");
  const isOpen = drawer.dataset.open === "true";
  drawer.dataset.open = String(!isOpen);
  if (!isOpen) {
    renderArchiveDrawer();
  } else {
    drawer.innerHTML = "";
  }
  renderStats();
}

function renderArchiveDrawer() {
  const drawer           = document.getElementById("archive-drawer");
  const archived         = loadArchive();
  const state            = loadState();
  const archivedPatients = patients.filter(p => archived.includes(p.id));

  if (!archivedPatients.length) {
    drawer.innerHTML = '<div class="archive-empty">No archived patients yet.</div>';
    return;
  }

  drawer.innerHTML = `
    <div class="archive-header">Archived patients</div>
    ${archivedPatients.map(p => {
      const prog = getProgress(p.id, state);
      return `
        <div class="archive-row">
          <div class="archive-info">
            <span class="archive-name">${p.name}</span>
            <span class="archive-meta">${destinationLabel(p.stops)} · Departs ${fmtDate(firstDeparture(p))}</span>
            <span class="archive-status ${prog.cls}">${prog.label}</span>
          </div>
          <button class="unarchive-btn" data-patient-id="${p.id}" type="button">Restore</button>
        </div>`;
    }).join("")}
  `;

  drawer.querySelectorAll(".unarchive-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      saveArchive(loadArchive().filter(id => id !== btn.dataset.patientId));
      renderPatients();
      renderArchiveDrawer();
      renderStats();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// RENDER — Patient list
// ═══════════════════════════════════════════════════════════════════

function getFilteredSorted() {
  const q        = (document.getElementById("search")?.value || "").toLowerCase().trim();
  const archived = loadArchive();
  const active   = patients.filter(p => !archived.includes(p.id));
  const visible  = q
    ? active.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.stops || []).some(s =>
          s.country.toLowerCase().includes(q) || s.city.toLowerCase().includes(q)))
    : active;
  return [...visible].sort((a, b) => new Date(firstDeparture(a)) - new Date(firstDeparture(b)));
}

function renderItinerary(p) {
  if (!p.stops || !p.stops.length) return "";
  const n = countryCount(p.stops);

  return `
    <div class="patient-info-section">
      <div class="info-section-title">Itinerary — ${n} ${n === 1 ? "country" : "countries"}</div>
      ${p.purpose ? `<div class="itinerary-subtitle"><span class="itinerary-subtitle-label">Purpose</span><strong>${p.purpose}</strong></div>` : ""}
      <table class="itinerary-table">
        <thead>
          <tr>
            <th>Country</th>
            <th>City / Region</th>
            <th>Arrival</th>
            <th>Departure</th>
          </tr>
        </thead>
        <tbody>
          ${p.stops.map(s => `
            <tr>
              <td class="itinerary-primary">${s.country || "—"}</td>
              <td class="itinerary-secondary">${s.city || "—"}</td>
              <td class="itinerary-date">${fmtDate(s.arrival)}</td>
              <td class="itinerary-date">${fmtDate(s.departure)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <div class="itinerary-facts">
        ${p.returnDate ? `
          <div class="fact-card">
            <span class="fact-label">Return date</span>
            <span class="fact-value">${fmtDate(p.returnDate)}</span>
          </div>` : ""}
      </div>
    </div>`;
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
    const prog       = getProgress(p.id, state);
    const ps         = state[p.id] || {};
    const isComplete = prog.done === prog.total;
    const n          = countryCount(p.stops);

    return `
<article class="patient-card" data-patient-id="${p.id}">

  <div class="card-header-row">
    <button class="patient-summary" type="button" aria-expanded="false">
      <div>
        <h3 class="patient-name">${p.name}</h3>
        <div class="patient-meta">
          <span class="chip chip-countries">${n} ${n === 1 ? "country" : "countries"}</span>
          <span class="dest-label">${destinationLabel(p.stops)}</span>
          ${departureChip(p)}
        </div>
      </div>
      <div>
        <div class="progress-pill ${prog.cls}">${prog.label}&nbsp;·&nbsp;${prog.done}/${prog.total}</div>
      </div>
    </button>
    <button class="archive-icon-btn" type="button" data-patient-id="${p.id}" title="Archive patient" aria-label="Archive ${p.name}">
      ${ARCHIVE_SVG}
    </button>
  </div>

  <div class="progress-track">
    <div class="progress-fill ${prog.cls}" style="width:${prog.pct}%"></div>
  </div>

  <div class="patient-details" id="details-${p.id}">

    <div class="archive-prompt${isComplete ? " visible" : ""}" id="prompt-${p.id}">
      <span class="archive-prompt-text">All steps complete — ready to archive this patient?</span>
      <div class="archive-prompt-actions">
        <button class="archive-prompt-confirm" type="button" data-patient-id="${p.id}">Archive</button>
        <button class="archive-prompt-dismiss" type="button" data-patient-id="${p.id}">Dismiss</button>
      </div>
    </div>

    ${renderItinerary(p)}

    <div class="checklist">
      ${CHECKLIST.map((task, i) => {
        const checked = !!ps[i];
        return `
        <label class="checklist-item${checked ? " completed" : ""}">
          <input type="checkbox" data-patient-id="${p.id}" data-task-index="${i}" ${checked ? "checked" : ""} />
          <span class="checklist-item-text">
            ${task.text}
            ${task.link ? `<a class="checklist-link" href="${task.link.href}" target="_blank" rel="noopener noreferrer">${task.link.label}</a>` : ""}
            ${task.note ? `<span class="checklist-note">⚠ ${task.note}</span>` : ""}
          </span>
        </label>`;
      }).join("")}
    </div>

    <div class="checklist-footer">
      <button class="reset-btn" type="button" data-patient-id="${p.id}">Reset checklist</button>
      <button class="archive-btn" type="button" data-patient-id="${p.id}">Archive</button>
    </div>

  </div>

</article>`;
  }).join("");

  attachEvents();
  restoreExpanded();
  renderStats();
}

function restoreExpanded() {
  if (!expandedId) return;
  const card = document.querySelector(`[data-patient-id="${expandedId}"]`);
  if (!card) return;
  const btn     = card.querySelector(".patient-summary");
  const details = document.getElementById(`details-${expandedId}`);
  if (btn && details) {
    btn.setAttribute("aria-expanded", "true");
    details.classList.add("active");
    card.classList.add("is-open");
  }
}

// ═══════════════════════════════════════════════════════════════════
// TARGETED DOM UPDATE
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

  const prompt = document.getElementById(`prompt-${patientId}`);
  if (prompt) {
    prompt.classList.toggle("visible", prog.done === prog.total);
  }
}

// ═══════════════════════════════════════════════════════════════════
// ARCHIVE ACTION
// ═══════════════════════════════════════════════════════════════════

function doArchive(patientId) {
  const archived = loadArchive();
  if (!archived.includes(patientId)) archived.push(patientId);
  saveArchive(archived);
  if (expandedId === patientId) expandedId = null;
  renderPatients();
  const drawer = document.getElementById("archive-drawer");
  if (drawer.dataset.open === "true") renderArchiveDrawer();
  renderStats();
}

// ═══════════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════════

function attachEvents() {

  document.querySelectorAll(".patient-summary").forEach(btn => {
    btn.addEventListener("click", () => {
      const card      = btn.closest(".patient-card");
      const patientId = card.dataset.patientId;
      const details   = document.getElementById(`details-${patientId}`);
      const isOpen    = btn.getAttribute("aria-expanded") === "true";

      btn.setAttribute("aria-expanded", String(!isOpen));
      details.classList.toggle("active", !isOpen);
      card.classList.toggle("is-open", !isOpen);
      expandedId = !isOpen ? patientId : null;
    });
  });

  document.querySelectorAll(".checklist-item input[type='checkbox']").forEach(cb => {
    cb.addEventListener("change", () => {
      const patientId = cb.dataset.patientId;
      const taskIndex = Number(cb.dataset.taskIndex);
      const state     = loadState();

      if (!state[patientId]) state[patientId] = {};
      state[patientId][taskIndex] = cb.checked;
      saveState(state);

      cb.closest(".checklist-item").classList.toggle("completed", cb.checked);
      updatePatientProgress(patientId, state);
      renderStats();
    });
  });

  document.querySelectorAll(".checklist-link").forEach(link => {
    link.addEventListener("click", e => e.stopPropagation());
  });

  document.querySelectorAll(".reset-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const patientId = btn.dataset.patientId;
      const state     = loadState();
      state[patientId] = {};
      saveState(state);

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

  document.querySelectorAll(".archive-icon-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      doArchive(btn.dataset.patientId);
    });
  });

  document.querySelectorAll(".archive-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      doArchive(btn.dataset.patientId);
    });
  });

  document.querySelectorAll(".archive-prompt-confirm").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      doArchive(btn.dataset.patientId);
    });
  });

  document.querySelectorAll(".archive-prompt-dismiss").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      btn.closest(".archive-prompt").classList.remove("visible");
    });
  });
}

function onSearch() {
  renderPatients();
}

// ═══════════════════════════════════════════════════════════════════
// SHEET DATA PARSING
// ═══════════════════════════════════════════════════════════════════

// Handles JS Date objects, M/D/YYYY strings, ISO strings, numbers
function parseDateValue(v) {
  if (!v && v !== 0) return "";
  if (v instanceof Date) return isNaN(v) ? "" : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  const d = new Date(typeof v === "number" ? v : s);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

// "Last, First"  →  "First Last"
function formatName(raw) {
  if (!raw) return "Unknown patient";
  const parts = String(raw).split(",").map(p => p.trim());
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : String(raw).trim();
}

function parseSheetRows(table) {
  return (table.rows || []).map((row, i) => {
    const cells = row.c || [];
    const get   = idx => cells[idx]?.v ?? null;
    const pd    = idx => parseDateValue(cells[idx]?.f ?? null) || parseDateValue(get(idx));
    const str   = idx => String(get(idx) ?? "").trim();
    const pick  = (...indices) => indices.map(str).find(Boolean) || "";

    const submitted    = pd(0);
    const name         = formatName(get(1));
    const numCountries = Number(get(2) || 1);
    const purpose      = str(3);

    // City columns 58–61 are shared across all sections (confirmed from live gviz data).
    // Stop n (0-based) → column 58+n.
    const layouts = {
      1: {
        stops: [
          { country: 4, arrival: 5, departure: 48, city: [55, 49] },
        ],
        returnDate: 48,
      },
      2: {
        stops: [
          { country: 6, arrival: 7, departure: 8, city: [54, 50] },
          { country: 9, arrival: 10, departure: 11, city: [51, 56, 59] },
        ],
        returnDate: 11,
      },
      3: {
        stops: [
          { country: 12, arrival: 13, departure: 14, city: [50, 54, 58] },
          { country: 15, arrival: 16, departure: 17, city: [56, 51, 59] },
          { country: 18, arrival: 19, departure: 20, city: [60, 57] },
        ],
        returnDate: 20,
      },
      4: {
        stops: [
          { country: 21, arrival: 22, departure: 23, city: [58, 54, 50] },
          { country: 24, arrival: 25, departure: 26, city: [59, 56, 51] },
          { country: 27, arrival: 28, departure: 29, city: [57, 60] },
          { country: 30, arrival: 31, departure: 32, city: [61] },
        ],
        returnDate: 32,
      },
      5: {
        stops: [
          { country: 33, arrival: 34, departure: 35, city: [62, 63, 58] },
          { country: 36, arrival: 37, departure: 38, city: [64, 68, 59] },
          { country: 39, arrival: 40, departure: 41, city: [65, 69, 60] },
          { country: 42, arrival: 43, departure: 44, city: [66, 70, 61] },
        ],
        returnDate: 44,
      },
    };

    const layout = layouts[numCountries] || layouts[5];
    let stops = layout.stops.map(stop => ({
      country: str(stop.country),
      city: pick(...stop.city),
      arrival: pd(stop.arrival),
      departure: pd(stop.departure),
    }));
    let returnDate = pd(layout.returnDate);

    stops = stops.filter(s => s.country || s.city);
    if (!stops.length) stops = [{ country: "Unknown", city: "", arrival: "", departure: "" }];

    return {
      id: `sheet-${name.replace(/\s+/g, "-").toLowerCase()}-${i}`,
      name, purpose, returnDate, submitted, stops,
    };
  });
}

// Uses JSONP to bypass CORS when running from file:// URLs
function fetchSheetPatients() {
  return new Promise((resolve, reject) => {
    const cb     = `_gviz_${Date.now()}`;
    const script = document.createElement("script");

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Request timed out"));
    }, 10000);

    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }

    window[cb] = function(data) {
      cleanup();
      if (!data?.table) { reject(new Error("Unexpected response")); return; }
      resolve(parseSheetRows(data.table));
    };

    script.onerror = () => { cleanup(); reject(new Error("Script load failed")); };
    script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
                 `?tqx=out:json;responseHandler:${cb}&gid=${SHEET_GID}`;
    document.head.appendChild(script);
  });
}

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════

async function init() {
  // Show loading state while fetching
  document.getElementById("patient-list").innerHTML =
    '<div class="no-patients">Loading patients from form responses…</div>';
  document.getElementById("stats-bar").innerHTML = "";

  try {
    const sheetPatients = await fetchSheetPatients();
    patients = sheetPatients;
    renderPatients();

    if (patients.length) {
      setSyncStatus("ok", `${patients.length} response${patients.length === 1 ? "" : "s"} loaded`);
    } else {
      setSyncStatus("ok", "No responses yet");
      document.getElementById("patient-list").innerHTML =
        '<div class="no-patients">No form responses yet. Responses will appear here automatically once patients submit the form.</div>';
    }
    console.info(`Loaded ${patients.length} patient(s) from Google Sheets.`);
  } catch (err) {
    setSyncStatus("error", "Could not load – check sheet access");
    document.getElementById("patient-list").innerHTML =
      '<div class="no-patients">Could not load form responses. Make sure the sheet is shared as "Anyone with the link can view."</div>';
    console.warn("Google Sheet unavailable:", err.message);
  }
}

init();
