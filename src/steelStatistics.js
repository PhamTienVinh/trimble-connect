import {
  getAllObjects,
  getSelectedObjects,
  getSelectedIds,
  getAssemblyContainers,
  getAssemblyChildren,
  getSavedAssemblyContainers,
} from "./objectExplorer.js";
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

// ── Check if groupBy is an assembly-type grouping ──
function isAssemblyGrouping(groupBy) {
  return groupBy === "assemblyName" || groupBy === "assemblyPos" || groupBy === "assemblyPosCode";
}

// ── Get assembly field key from groupBy ──
function getAssemblyFieldKey(groupBy) {
  switch (groupBy) {
    case "assemblyName": return "assemblyName";
    case "assemblyPos": return "assemblyPos";
    case "assemblyPosCode": return "assemblyPosCode";
    default: return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Build 3-level assembly grouped data ──
// ══════════════════════════════════════════════════════════════════════════════
function buildAssemblyGroupedData(enrichedObjects, groupBy) {
  const fieldKey = getAssemblyFieldKey(groupBy);
  if (!fieldKey) return null;

  const containers = getAssemblyContainers();
  const savedContainers = getSavedAssemblyContainers();

  const objectToContainerKey = new Map();
  const containerInfoMap = new Map();

  for (const container of containers) {
    containerInfoMap.set(container.key, container);
    const childObjs = getAssemblyChildren(container.modelId, container.id);
    for (const child of childObjs) {
      objectToContainerKey.set(`${child.modelId}:${child.id}`, container.key);
    }
  }

  for (const container of savedContainers) {
    const containerKey = `${container.modelId}:${container.id}`;
    if (!containerInfoMap.has(containerKey)) {
      containerInfoMap.set(containerKey, {
        key: containerKey,
        id: container.id,
        modelId: container.modelId,
        name: container.name || `Container ${container.id}`,
        ifcClass: container.ifcClass || "IfcElementAssembly",
        assemblyPos: container.assemblyPos || "",
        assemblyName: container.assemblyName || "",
        assemblyPosCode: container.assemblyPosCode || "",
      });
    } else {
      const existing = containerInfoMap.get(containerKey);
      if (!existing.assemblyPos && container.assemblyPos) existing.assemblyPos = container.assemblyPos;
      if (!existing.assemblyName && container.assemblyName) existing.assemblyName = container.assemblyName;
      if (!existing.assemblyPosCode && container.assemblyPosCode) existing.assemblyPosCode = container.assemblyPosCode;
    }
  }

  const assemblyGroups = {};

  for (const obj of enrichedObjects) {
    const assemblyValue = obj[fieldKey] || "(Không xác định)";

    if (!assemblyGroups[assemblyValue]) {
      assemblyGroups[assemblyValue] = {
        name: assemblyValue,
        containers: new Map(),
        orphans: [],
        totalCount: 0,
        totalVolume: 0,
        totalWeight: 0,
        totalArea: 0,
        totalNetArea: 0,
      };
    }

    const group = assemblyGroups[assemblyValue];
    const objKey = `${obj.modelId}:${obj.id}`;
    const containerKey = objectToContainerKey.get(objKey);

    if (containerKey) {
      if (!group.containers.has(containerKey)) {
        const cInfo = containerInfoMap.get(containerKey) || { name: "Container", id: 0 };
        group.containers.set(containerKey, {
          info: cInfo,
          children: [],
          totalVolume: 0,
          totalWeight: 0,
          totalArea: 0,
          totalNetArea: 0,
        });
      }
      const containerEntry = group.containers.get(containerKey);
      containerEntry.children.push(obj);
      containerEntry.totalVolume += obj.volume;
      containerEntry.totalWeight += obj.weight;
      containerEntry.totalArea += obj.area;
      containerEntry.totalNetArea += obj.netArea || 0;
    } else {
      group.orphans.push(obj);
    }

    group.totalCount++;
    group.totalVolume += obj.volume;
    group.totalWeight += obj.weight;
    group.totalArea += obj.area;
    group.totalNetArea += obj.netArea || 0;
  }

  return assemblyGroups;
}

// ── Update Statistics ──
function updateStatistics() {
  const showAll = document.getElementById("stats-all-toggle").checked;
  const groupBy = document.getElementById("stats-group-by").value;

  const selIds = getSelectedIds();
  let objects;
  if (showAll) {
    objects = getAllObjects();
  } else {
    objects = getSelectedObjects();
  }
  if (!objects || objects.length === 0) {
    clearStats();
    return;
  }

  objects = objects.filter(is3DObjectWithDimensions);

  if (objects.length === 0) {
    clearStats();
    return;
  }

  // Calculate totals
  let totalVolume = 0;
  let totalWeight = 0;
  let totalArea = 0;
  let totalNetArea = 0;

  const enriched = objects.map((obj) => {
    let vol = obj.volume || 0;
    let wt = obj.weight || 0;
    let area = obj.area || 0;
    let netArea = obj.netArea || 0;

    if (wt === 0 && vol > 0) {
      wt = vol * STEEL_DENSITY;
    }

    totalVolume += vol;
    totalWeight += wt;
    totalArea += area;
    totalNetArea += netArea;

    return {
      ...obj,
      volume: vol,
      weight: wt,
      area,
      netArea,
      density: obj.density || STEEL_DENSITY,
      weightSource: obj.weightSource || (wt > 0 && obj.weight === 0 ? "calculated" : (wt > 0 ? "ifc" : "")),
    };
  });

  currentData = enriched;

  // Update summary cards
  document.getElementById("stat-total-objects").textContent = formatNumber(objects.length);
  document.getElementById("stat-total-volume").textContent = formatVolume(totalVolume);
  document.getElementById("stat-total-weight").textContent = formatWeight(totalWeight);
  document.getElementById("stat-total-area").textContent = formatArea(totalArea);
  const netAreaEl = document.getElementById("stat-total-net-area");
  if (netAreaEl) netAreaEl.textContent = formatArea(totalNetArea);

  // ── Assembly grouping: 3-level hierarchy ──
  if (isAssemblyGrouping(groupBy)) {
    const assemblyGroups = buildAssemblyGroupedData(enriched, groupBy);
    if (assemblyGroups) {
      const sortedGroups = Object.values(assemblyGroups).sort((a, b) => b.totalWeight - a.totalWeight);
      renderAssemblyStatsTable(sortedGroups, totalVolume, totalWeight, totalArea, totalNetArea, groupBy);

      const groupCount = sortedGroups.length;
      const el = document.getElementById("stat-total-groups");
      if (el) el.textContent = formatNumber(groupCount);

      document.getElementById("stats-placeholder").style.display = "none";
      return;
    }
  }

  // ── Standard flat grouping ──
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
        netArea: 0,
        weightSources: new Set(),
      };
    }
    groups[key].count++;
    groups[key].volume += obj.volume;
    groups[key].weight += obj.weight;
    groups[key].area += obj.area;
    groups[key].netArea += obj.netArea || 0;
    if (obj.weightSource) groups[key].weightSources.add(obj.weightSource);
  }

  const sortedGroups = Object.values(groups).sort((a, b) => b.weight - a.weight);

  renderStatsTable(sortedGroups, totalVolume, totalWeight, totalArea, totalNetArea);

  const el = document.getElementById("stat-total-groups");
  if (el) el.textContent = formatNumber(sortedGroups.length);

  document.getElementById("stats-placeholder").style.display = "none";
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Render Assembly Stats Table (3-level hierarchy) ──
// ══════════════════════════════════════════════════════════════════════════════
function renderAssemblyStatsTable(assemblyGroups, totalVolume, totalWeight, totalArea, totalNetArea, groupBy) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");

  let bodyHtml = "";
  let totalCount = 0;

  for (const group of assemblyGroups) {
    totalCount += group.totalCount;

    // Level 1: Assembly value header row
    bodyHtml += `<tr class="stats-group-header" data-assembly-group="${escHtml(group.name)}">`;
    bodyHtml += `<td class="stats-group-name">`;
    bodyHtml += `<span class="stats-toggle" onclick="this.closest('tr').classList.toggle('collapsed'); _toggleAssemblyGroup(this)">▼</span> `;
    bodyHtml += `<strong>🏗️ ${escHtml(group.name)}</strong>`;
    bodyHtml += `</td>`;
    bodyHtml += `<td><strong>${formatNumber(group.totalCount)}</strong></td>`;
    bodyHtml += `<td><strong>${formatVolume(group.totalVolume)}</strong></td>`;
    bodyHtml += `<td><strong>${formatArea(group.totalArea)}</strong></td>`;
    bodyHtml += `<td><strong>${formatArea(group.totalNetArea)}</strong></td>`;
    bodyHtml += `<td><strong>${formatWeight(group.totalWeight)}</strong></td>`;
    bodyHtml += `</tr>`;

    // Level 2: IfcElementAssembly containers
    for (const [containerKey, containerEntry] of group.containers) {
      const containerName = containerEntry.info.name || `Container ${containerEntry.info.id}`;
      const containerChildCount = containerEntry.children.length;

      bodyHtml += `<tr class="stats-container-row" data-assembly-group="${escHtml(group.name)}" data-container="${escHtml(containerKey)}">`;
      bodyHtml += `<td class="stats-container-name">`;
      bodyHtml += `<span class="stats-toggle-sm" onclick="this.closest('tr').classList.toggle('collapsed'); _toggleContainerChildren(this)">▼</span> `;
      bodyHtml += `📦 <em>${escHtml(containerName)}</em>`;
      bodyHtml += `</td>`;
      bodyHtml += `<td>${formatNumber(containerChildCount)}</td>`;
      bodyHtml += `<td>${formatVolume(containerEntry.totalVolume)}</td>`;
      bodyHtml += `<td>${formatArea(containerEntry.totalArea)}</td>`;
      bodyHtml += `<td>${formatArea(containerEntry.totalNetArea)}</td>`;
      bodyHtml += `<td>${formatWeight(containerEntry.totalWeight)}</td>`;
      bodyHtml += `</tr>`;

      // Level 3: Children
      for (const child of containerEntry.children) {
        bodyHtml += `<tr class="stats-child-row" data-assembly-group="${escHtml(group.name)}" data-container="${escHtml(containerKey)}">`;
        bodyHtml += `<td class="stats-child-name">─ ${escHtml(child.name || "(Không tên)")}</td>`;
        bodyHtml += `<td>1</td>`;
        bodyHtml += `<td>${formatVolume(child.volume)}</td>`;
        bodyHtml += `<td>${formatArea(child.area)}</td>`;
        bodyHtml += `<td>${formatArea(child.netArea || 0)}</td>`;
        bodyHtml += `<td>${formatWeight(child.weight)}</td>`;
        bodyHtml += `</tr>`;
      }
    }

    // Render direct children (not in IfcElementAssembly container)
    for (const child of group.orphans) {
      bodyHtml += `<tr class="stats-child-row" data-assembly-group="${escHtml(group.name)}" data-container="direct">`;
      bodyHtml += `<td class="stats-child-name">─ ${escHtml(child.name || "(Không tên)")}</td>`;
      bodyHtml += `<td>1</td>`;
      bodyHtml += `<td>${formatVolume(child.volume)}</td>`;
      bodyHtml += `<td>${formatArea(child.area)}</td>`;
      bodyHtml += `<td>${formatArea(child.netArea || 0)}</td>`;
      bodyHtml += `<td>${formatWeight(child.weight)}</td>`;
      bodyHtml += `</tr>`;
    }
  }

  tbody.innerHTML = bodyHtml;

  tfoot.innerHTML = `
    <tr>
      <td>TỔNG CỘNG</td>
      <td>${formatNumber(totalCount)}</td>
      <td>${formatVolume(totalVolume)}</td>
      <td>${formatArea(totalArea)}</td>
      <td>${formatArea(totalNetArea)}</td>
      <td>${formatWeight(totalWeight)}</td>
    </tr>
  `;
}

// ── Global toggle helpers for assembly hierarchy ──
window._toggleAssemblyGroup = function(el) {
  const headerRow = el.closest("tr");
  const groupName = headerRow.dataset.assemblyGroup;
  const isCollapsed = headerRow.classList.contains("collapsed");
  const table = headerRow.closest("tbody");
  if (!table) return;

  const rows = table.querySelectorAll(`tr[data-assembly-group="${CSS.escape(groupName)}"]`);
  rows.forEach((row) => {
    if (row === headerRow) return;
    row.style.display = isCollapsed ? "none" : "";
  });
};

window._toggleContainerChildren = function(el) {
  const containerRow = el.closest("tr");
  const groupName = containerRow.dataset.assemblyGroup;
  const containerKey = containerRow.dataset.container;
  const isCollapsed = containerRow.classList.contains("collapsed");
  const table = containerRow.closest("tbody");
  if (!table) return;

  const childRows = table.querySelectorAll(
    `tr.stats-child-row[data-assembly-group="${CSS.escape(groupName)}"][data-container="${CSS.escape(containerKey)}"]`
  );
  childRows.forEach((row) => {
    row.style.display = isCollapsed ? "none" : "";
  });
};

// ── Render Standard Table (flat grouping) ──
function renderStatsTable(groups, totalVolume, totalWeight, totalArea, totalNetArea) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");

  let bodyHtml = "";
  for (const g of groups) {
    bodyHtml += `<tr>`;
    bodyHtml += `<td>${escHtml(g.name)}</td>`;
    bodyHtml += `<td>${formatNumber(g.count)}</td>`;
    bodyHtml += `<td>${formatVolume(g.volume)}</td>`;
    bodyHtml += `<td>${formatArea(g.area)}</td>`;
    bodyHtml += `<td>${formatArea(g.netArea)}</td>`;
    bodyHtml += `<td>${formatWeight(g.weight)}</td>`;
    bodyHtml += `</tr>`;
  }
  tbody.innerHTML = bodyHtml;

  tfoot.innerHTML = `
    <tr>
      <td>TỔNG CỘNG</td>
      <td>${formatNumber(groups.reduce((s, g) => s + g.count, 0))}</td>
      <td>${formatVolume(totalVolume)}</td>
      <td>${formatArea(totalArea)}</td>
      <td>${formatArea(totalNetArea)}</td>
      <td>${formatWeight(totalWeight)}</td>
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

  data = data.filter(is3DObjectWithDimensions);

  if (data.length === 0) {
    console.warn("[Statistics] No 3D objects with dimensions to export");
    return;
  }

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
  const isBolt = obj.isTeklaBolt || false;
  const isTekla = obj.isTekla || false;
  const hasRealName = obj.name && !/^Object \d+$/.test(obj.name);
  return hasWeight || hasArea || hasVolume || isBolt || (isTekla && hasRealName);
}

function getGroupKey(obj, groupBy) {
  switch (groupBy) {
    case "assemblyName": return obj.assemblyName || "(Không xác định)";
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
  const netAreaEl = document.getElementById("stat-total-net-area");
  if (netAreaEl) netAreaEl.textContent = "0 m²";
  document.getElementById("stats-table-body").innerHTML = "";
  const tfoot = document.getElementById("stats-table-footer");
  if (tfoot) {
    tfoot.innerHTML = "";
  }
  const placeholder = document.getElementById("stats-placeholder");
  if (placeholder) {
    placeholder.style.display = "block";
  }
  const el = document.getElementById("stat-total-groups");
  if (el) el.textContent = "0";
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

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
