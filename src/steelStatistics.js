/**
 * steelStatistics.js — Volume, Weight & Area Statistics with Grouping
 *
 * Computes per-object and grouped statistics for steel and all objects.
 * Integrates with objectExplorer for data and with excelExport for export.
 */

import { getAllObjects, getSelectedObjects, getSelectedIds } from "./objectExplorer.js";
import { exportToExcel } from "./excelExport.js";

// ── Constants ──
const STEEL_DENSITY = 7850; // kg/m³

// ── State ──
let apiRef = null;
let viewerRef = null;
let currentData = []; // cached stats data

// ── Init ──
export function initSteelStatistics(api, viewer) {
  apiRef = api;
  viewerRef = viewer;

  // Listen for data from objectExplorer
  window.addEventListener("objects-scanned", (e) => {
    updateStatistics();
  });

  // UI bindings
  document.getElementById("stats-group-by").addEventListener("change", updateStatistics);
  document.getElementById("stats-all-toggle").addEventListener("change", updateStatistics);
  document.getElementById("btn-export-all").addEventListener("click", () => exportExcel(false));
  document.getElementById("btn-export-selected").addEventListener("click", () => exportExcel(true));

  // Listen for real-time selection changes
  window.addEventListener("selection-changed", (e) => {
    const detail = e.detail || {};
    // Auto-switch to "selected only" when objects are selected from 3D viewer
    const toggle = document.getElementById("stats-all-toggle");
    if (detail.count > 0) {
      toggle.checked = false;
    } else {
      toggle.checked = true;
    }
    updateStatistics();
  });
}

// ── Update Statistics ──
function updateStatistics() {
  const showAll = document.getElementById("stats-all-toggle").checked;
  const groupBy = document.getElementById("stats-group-by").value;

  // When "Toàn bộ dự án" is unchecked, show selected objects only
  const selIds = getSelectedIds();
  let objects;
  if (showAll) {
    objects = getAllObjects();
  } else {
    objects = getSelectedObjects(); // returns [] if nothing selected
  }
  if (!objects || objects.length === 0) {
    clearStats();
    return;
  }

  // Filter out non-3D objects and objects with zero dimensions
  objects = objects.filter(is3DObjectWithDimensions);

  if (objects.length === 0) {
    clearStats();
    return;
  }

  // Calculate totals
  let totalVolume = 0;
  let totalWeight = 0;
  let totalArea = 0;

  const enriched = objects.map((obj) => {
    let vol = obj.volume || 0;
    let wt = obj.weight || 0;
    let area = obj.area || 0;

    // If weight is 0 but volume exists, calculate from material-appropriate density
    if (wt === 0 && vol > 0) {
      const matLower = (obj.material || "").toLowerCase();
      const clsLower = (obj.ifcClass || "").toLowerCase();
      let density = STEEL_DENSITY; // default steel
      if (
        matLower.includes("concrete") || matLower.includes("bê tông") || matLower.includes("beton") ||
        clsLower === "ifcfooting" || clsLower === "ifcpile" ||
        clsLower === "ifcslab" || clsLower === "ifcwall" ||
        clsLower === "ifcwallstandardcase" ||
        clsLower === "ifcstair" || clsLower === "ifcstairflight" ||
        clsLower === "ifcramp" || clsLower === "ifcrampflight"
      ) {
        if (!matLower.includes("steel") && !matLower.includes("thép")) {
          density = 2400; // concrete
        }
      }
      if (matLower.includes("wood") || matLower.includes("gỗ") || matLower.includes("timber")) {
        density = 600; // wood
      }
      if (matLower.includes("aluminum") || matLower.includes("aluminium") || matLower.includes("nhôm")) {
        density = 2700; // aluminum
      }
      wt = vol * density;
    }

    totalVolume += vol;
    totalWeight += wt;
    totalArea += area;

    return {
      ...obj,
      volume: vol,
      weight: wt,
      area,
      density: obj.density || STEEL_DENSITY,
      densityLabel: obj.densityLabel || "Thép",
      weightSource: obj.weightSource || (wt > 0 && obj.weight === 0 ? "calculated" : (wt > 0 ? "ifc" : "")),
    };
  });

  currentData = enriched;

  // Update summary cards
  document.getElementById("stat-total-objects").textContent = formatNumber(objects.length);
  document.getElementById("stat-total-volume").textContent = formatVolume(totalVolume);
  document.getElementById("stat-total-weight").textContent = formatWeight(totalWeight);
  document.getElementById("stat-total-area").textContent = formatArea(totalArea);

  // Group data
  const groups = {};
  for (const obj of enriched) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = {
        name: key,
        count: 0,
        volume: 0,
        weight: 0,
        area: 0,
        densities: new Set(),
        weightSources: new Set(),
        densityBuckets: new Map(),
      };
    }
    groups[key].count++;
    groups[key].volume += obj.volume;
    groups[key].weight += obj.weight;
    groups[key].area += obj.area;
    if (obj.density) groups[key].densities.add(`${obj.densityLabel}|${obj.density}`);
    if (obj.weightSource) groups[key].weightSources.add(obj.weightSource);
    if (obj.density) {
      const bucketKey = `${obj.densityLabel}|${obj.density}`;
      if (!groups[key].densityBuckets.has(bucketKey)) {
        groups[key].densityBuckets.set(bucketKey, {
          label: obj.densityLabel || "Khác",
          density: obj.density || 0,
          count: 0,
          volume: 0,
          weight: 0,
          fromIfc: 0,
          fromCalculated: 0,
        });
      }
      const bucket = groups[key].densityBuckets.get(bucketKey);
      bucket.count += 1;
      bucket.volume += obj.volume || 0;
      bucket.weight += obj.weight || 0;
      if (obj.weightSource === "ifc") bucket.fromIfc += 1;
      if (obj.weightSource === "calculated") bucket.fromCalculated += 1;
    }
  }

  const sortedGroups = Object.values(groups).sort((a, b) => b.weight - a.weight);

  // Render table
  renderStatsTable(sortedGroups, totalVolume, totalWeight, totalArea);

  // Hide placeholder
  document.getElementById("stats-placeholder").style.display = "none";
}

// ── Render Table ──
function renderStatsTable(groups, totalVolume, totalWeight, totalArea) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");

  let bodyHtml = "";
  for (const g of groups) {
    // Build density display string
    const densityInfo = formatDensityInfo(g);
    bodyHtml += `<tr>`;
    bodyHtml += `<td>${escHtml(g.name)}</td>`;
    bodyHtml += `<td>${formatNumber(g.count)}</td>`;
    bodyHtml += `<td>${formatVolume(g.volume)}</td>`;
    bodyHtml += `<td>${formatArea(g.area)}</td>`;
    bodyHtml += `<td>${formatWeight(g.weight)}</td>`;
    bodyHtml += `<td class="density-cell">${densityInfo}</td>`;
    bodyHtml += `</tr>`;
  }
  tbody.innerHTML = bodyHtml;

  tfoot.innerHTML = `
    <tr>
      <td>TỔNG CỘNG</td>
      <td>${formatNumber(groups.reduce((s, g) => s + g.count, 0))}</td>
      <td>${formatVolume(totalVolume)}</td>
      <td>${formatArea(totalArea)}</td>
      <td>${formatWeight(totalWeight)}</td>
      <td>—</td>
    </tr>
  `;
}

// ── Export Excel ──
function exportExcel(selectedOnly) {
  const groupBy = document.getElementById("stats-group-by").value;
  let data = selectedOnly ? getSelectedObjects() : getAllObjects();

  if (!data || data.length === 0) {
    console.warn("[Statistics] No data to export");
    return;
  }

  // Filter out non-3D objects and objects with zero dimensions
  data = data.filter(is3DObjectWithDimensions);

  if (data.length === 0) {
    console.warn("[Statistics] No 3D objects with dimensions to export");
    return;
  }

  // Prepare export data
  const enrichedData = data.map((obj) => ({
    ...obj,
    weight: obj.weight || (obj.volume > 0 ? obj.volume * STEEL_DENSITY : 0),
  }));

  exportToExcel(enrichedData, groupBy, selectedOnly);
}

// ── Helpers ──
function is3DObjectWithDimensions(obj) {
  const hasWeight = obj.weight > 0;
  const hasArea = obj.area > 0;
  const hasVolume = obj.volume > 0;
  
  // Include Tekla Bolt components even if they lack standard dimensions
  const isBolt = obj.isTeklaBolt || false;
  
  // Include Tekla-origin objects
  const isTekla = obj.isTekla || false;
  
  // Include objects with a real name (not auto-generated)
  const hasRealName = obj.name && !/^Object \d+$/.test(obj.name);
  
  // Objects accepted: have physical data, are bolts/fasteners, are Tekla, or have real names
  return hasWeight || hasArea || hasVolume || isBolt || (isTekla && hasRealName);
}

function getGroupKey(obj, groupBy) {
  switch (groupBy) {
    case "assemblyName": return obj.assemblyName || obj.assembly || "(Không xác định)";
    case "assemblyPos": return obj.assemblyPos || "(Không xác định)";
    case "assemblyPosCode": return obj.assemblyPosCode || "(Không xác định)";
    case "name": return obj.name;
    case "group": return obj.group;
    case "objectType": return obj.type || obj.ifcClass || "(Không xác định)";
    case "material": return obj.material;
    case "profile": return obj.profile || "(Không xác định)";
    case "referenceName": return obj.referenceName || "(Không xác định)";
    case "ifcClass": return obj.ifcClass || "(Không xác định)";
    default: return obj.assemblyDisplayName || obj.assembly;
  }
}

function clearStats() {
  document.getElementById("stat-total-objects").textContent = "0";
  document.getElementById("stat-total-volume").textContent = "0 m³";
  document.getElementById("stat-total-weight").textContent = "0 kg";
  document.getElementById("stat-total-area").textContent = "0 m²";
  document.getElementById("stats-table-body").innerHTML = "";
  const tfoot = document.getElementById("stats-table-footer");
  if (tfoot) {
    tfoot.innerHTML = "";
  }
  const placeholder = document.getElementById("stats-placeholder");
  if (placeholder) {
    placeholder.style.display = "block";
  }
}

function formatNumber(n) {
  return n.toLocaleString("vi-VN");
}

function formatVolume(v) {
  return v.toFixed(6) + " m³";
}

function formatArea(a) {
  return a.toFixed(4) + " m²";
}


function formatWeight(w) {
  if (w >= 1000) return (w / 1000).toFixed(2) + " tấn";
  return w.toFixed(2) + " kg";
}

function formatWeightKg(w) {
  return `${w.toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
}

/**
 * Format density info for a group.
 * Shows: "Thép (7.850 kg/m³) — V×ρ" or "Bê tông (2.400 kg/m³) — IFC" etc.
 * If group has mixed densities, shows all.
 */
function formatDensityInfo(group) {
  if (!group.densities || group.densities.size === 0) return "—";

  const detailLines = [];
  if (group.densityBuckets && group.densityBuckets.size > 0) {
    const buckets = Array.from(group.densityBuckets.values()).sort((a, b) => b.weight - a.weight);
    for (const bucket of buckets) {
      const densityText = `${bucket.label} (${Number(bucket.density).toLocaleString("vi-VN")} kg/m³)`;
      const volumeText = bucket.volume.toLocaleString("vi-VN", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
      const weightFormula = bucket.volume > 0
        ? `W = ${volumeText} m³ × ${Number(bucket.density).toLocaleString("vi-VN")} = ${formatWeightKg(bucket.volume * bucket.density)}`
        : `W = ${formatWeightKg(bucket.weight)} (từ IFC)`;
      const sourceText = bucket.fromIfc > 0 && bucket.fromCalculated > 0
        ? "IFC + V×ρ"
        : bucket.fromIfc > 0
          ? "IFC"
          : "V×ρ";
      detailLines.push(
        `<div class="density-line"><strong>${densityText}</strong> · ${weightFormula} · ${bucket.count} obj · ${sourceText}</div>`,
      );
    }
  }

  if (detailLines.length > 0) {
    return detailLines.join("");
  }
  const fallback = Array.from(group.densities).map((entry) => {
    const [label, densityStr] = entry.split("|");
    const density = Number(densityStr);
    return `${label} (${density.toLocaleString("vi-VN")} kg/m³)`;
  });
  return fallback.join(", ");
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
