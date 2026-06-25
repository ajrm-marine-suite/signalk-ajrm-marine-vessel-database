const API_BASE = "/plugins/signalk-ajrm-marine-vessel-database";

const els = {
  summary: document.getElementById("summary"),
  status: document.getElementById("status"),
  filter: document.getElementById("filter"),
  refresh: document.getElementById("refresh"),
  deleteAll: document.getElementById("deleteAll"),
  vessels: document.getElementById("vessels"),
  details: document.getElementById("details"),
  detailsName: document.getElementById("detailsName"),
  detailsSubtitle: document.getElementById("detailsSubtitle"),
  detailsList: document.getElementById("detailsList"),
  closeDetails: document.getElementById("closeDetails"),
};

let vessels = [];
let selectedMmsi = "";
let visibleVessels = [];

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    ...options,
  });
  if (!response.ok) {
    let message = `Request failed with HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // Keep the HTTP message.
    }
    throw new Error(message);
  }
  return response.json();
}

function formatDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(Math.abs(number) >= 10 ? 0 : 1)} m` : "";
}

function formatTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleString();
}

function typeName(shipType) {
  if (!shipType) return "";
  if (typeof shipType === "string") return shipType;
  return shipType.name || shipType.id || "";
}

function valueText(value) {
  return value === undefined || value === null || value === "" ? "Not known" : String(value);
}

function matchesFilter(vessel, query) {
  if (!query) return true;
  const haystack = [
    vessel.name,
    vessel.mmsi,
    vessel.callsign,
    vessel.imo,
    vessel.aisClass,
    typeName(vessel.shipType),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function render() {
  const query = els.filter.value.trim();
  visibleVessels = vessels.filter((vessel) => matchesFilter(vessel, query));
  els.summary.textContent = `${visibleVessels.length} of ${vessels.length} vessels`;

  if (!visibleVessels.length) {
    els.vessels.innerHTML = `<tr><td colspan="8" class="empty">No vessels found</td></tr>`;
    if (selectedMmsi) renderDetails(null);
    return;
  }

  if (selectedMmsi && !visibleVessels.some((vessel) => String(vessel.mmsi || "") === selectedMmsi)) {
    renderDetails(null);
  }

  els.vessels.innerHTML = visibleVessels
    .map(
      (vessel) => `<tr data-mmsi="${escapeHtml(vessel.mmsi || "")}" tabindex="0">
        <td>${escapeHtml(vessel.name || "")}</td>
        <td class="mono">${escapeHtml(vessel.mmsi || "")}</td>
        <td>${escapeHtml(vessel.callsign || "")}</td>
        <td>${escapeHtml(typeName(vessel.shipType))}</td>
        <td>${escapeHtml(vessel.aisClass || "")}</td>
        <td>${escapeHtml(formatDimension(vessel.length))}</td>
        <td>${escapeHtml(formatDimension(vessel.beam))}</td>
        <td>${escapeHtml(formatTime(vessel.lastSeen))}</td>
      </tr>`,
    )
    .join("");
  updateSelectedRow();
}

function renderDetails(vessel) {
  if (!vessel) {
    selectedMmsi = "";
    els.details.hidden = true;
    updateSelectedRow();
    return;
  }

  selectedMmsi = String(vessel.mmsi || "");
  els.details.hidden = false;
  els.detailsName.textContent = vessel.name || "Unknown vessel";
  els.detailsSubtitle.textContent = selectedMmsi ? `MMSI ${selectedMmsi}` : "No MMSI";
  const rows = [
    ["Name", vessel.name],
    ["MMSI", vessel.mmsi],
    ["Callsign", vessel.callsign],
    ["IMO", vessel.imo],
    ["Type", typeName(vessel.shipType)],
    ["AIS class", vessel.aisClass],
    ["Length", formatDimension(vessel.length)],
    ["Beam", formatDimension(vessel.beam)],
    ["GPS antenna from bow", formatDimension(vessel.aisFromBow)],
    ["GPS antenna from centre", formatDimension(vessel.aisFromCenter)],
    ["Last seen", formatTime(vessel.lastSeen)],
    ["Updated", formatTime(vessel.updatedAt)],
  ];

  els.detailsList.innerHTML = rows
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(valueText(value))}</dd></div>`,
    )
    .join("");
  updateSelectedRow();
}

function updateSelectedRow() {
  els.vessels.querySelectorAll("tr[data-mmsi]").forEach((row) => {
    row.classList.toggle("selected", row.dataset.mmsi === selectedMmsi);
  });
}

function selectVesselByMmsi(mmsi, focusRow = false) {
  const vessel = vessels.find((item) => String(item.mmsi || "") === String(mmsi || ""));
  renderDetails(vessel);
  if (focusRow) focusSelectedRow();
}

function focusSelectedRow() {
  if (!selectedMmsi) return;
  const row = [...els.vessels.querySelectorAll("tr[data-mmsi]")].find(
    (item) => item.dataset.mmsi === selectedMmsi,
  );
  if (!row) return;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

function moveSelection(direction) {
  if (!visibleVessels.length) return;
  const currentIndex = visibleVessels.findIndex(
    (vessel) => String(vessel.mmsi || "") === selectedMmsi,
  );
  const fallbackIndex = direction > 0 ? 0 : visibleVessels.length - 1;
  const nextIndex =
    currentIndex < 0
      ? fallbackIndex
      : Math.min(visibleVessels.length - 1, Math.max(0, currentIndex + direction));
  selectVesselByMmsi(visibleVessels[nextIndex]?.mmsi, true);
}

async function refresh() {
  els.status.textContent = "Loading vessel database";
  const data = await requestJson(`${API_BASE}/vessels`);
  vessels = Array.isArray(data.vessels) ? data.vessels : [];
  if (selectedMmsi && !vessels.some((vessel) => String(vessel.mmsi || "") === selectedMmsi)) {
    renderDetails(null);
  }
  render();
  const file = data.status?.databasePath ? `, stored at ${data.status.databasePath}` : "";
  els.status.textContent = `Updated ${new Date().toLocaleTimeString()}${file}`;
}

async function deleteAll() {
  const confirmed = window.confirm(
    "Delete every learned vessel from AJRM Marine Vessel Database? This is useful for clearing debug data.",
  );
  if (!confirmed) return;
  els.status.textContent = "Deleting vessel database";
  await requestJson(`${API_BASE}/delete-all`, { method: "POST" });
  vessels = [];
  renderDetails(null);
  render();
  els.status.textContent = "Vessel database cleared";
}

els.refresh.addEventListener("click", () => {
  refresh().catch(showError);
});

els.deleteAll.addEventListener("click", () => {
  deleteAll().catch(showError);
});

els.filter.addEventListener("input", render);

els.closeDetails.addEventListener("click", () => renderDetails(null));

els.vessels.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-mmsi]");
  if (row) selectVesselByMmsi(row.dataset.mmsi, true);
});

els.vessels.addEventListener("keydown", (event) => {
  const row = event.target.closest("tr[data-mmsi]");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  if (row) {
    event.preventDefault();
    selectVesselByMmsi(row.dataset.mmsi);
  }
});

function showError(error) {
  console.error(error);
  els.status.textContent = `Problem: ${error.message}`;
}

refresh().catch(showError);
