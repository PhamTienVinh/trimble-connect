/**
 * steelStatistics.js — Volume, Weight & Area Statistics with Grouping
 *
 * Computes per-object and grouped statistics for steel and all objects.
 * Integrates with objectExplorer for data and with excelExport for export.
 *
 * Assembly grouping (assemblyName, assemblyPos, assemblyPosCode) uses
 * a 3-level hierarchy:
 *   Level 1: Assembly value (e.g. assembly name)
 *   Level 2: IfcElementAssembly containers (grouping only — no weight)
 *   Level 3: Children within each container (actual quantities)
 */

import {
  getAllObjects,
  getSelectedObjects,
  getSelectedIds,
  getAssemblyContainers,
  getAssemblyChildren,
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
// Structure:
//   Level 1: Assembly value (name/pos/code)
//     Level 2: IfcElementAssembly containers
//       Level 3: Children within each container
//
// IMPORTANT: IfcElementAssembly containers are for listing/grouping ONLY.
// Actual weight/volume/area totals always come from the children.
// This prevents double-counting since IfcElementAssembly weight = SUM(children).
// ══════════════════════════════════════════════════════════════════════════════
function buildAssemblyGroupedData(enrichedObjects, groupBy) {
  const fieldKey = getAssemblyFieldKey(groupBy);
  if (!fieldKey) return null;

  // Get all IfcElementAssembly containers from objectExplorer
  const containers = getAssemblyContainers();

  // Build a map: assemblyValue → { containers: Map<containerKey, {info, children[]}>, orphans: [] }
  const assemblyGroups = {};

  // Step 1: Group containers by their assembly value
  for (const container of containers) {
    const assemblyValue = container[fieldKey] || "(Không xác định)";
    if (!assemblyGroups[assemblyValue]) {
      assemblyGroups[assemblyValue] = {
        name: assemblyValue,
        containers: new Map(),
        orphans: [], // children not belonging to any container
        totalCount: 0,
        totalVolume: 0,
        totalWeight: 0,
        totalArea: 0,
      };
    }

    // Add container entry (will be populated with children later)
    assemblyGroups[assemblyValue].containers.set(container.key, {
      info: container,
      children: [],
      totalVolume: 0,
      totalWeight: 0,
      totalArea: 0,
    });
  }

  // Step 2: Assign each enriched object to its container within the correct assembly group
  // Build a quick lookup: objectId → container key
  const objectToContainerKey = new Map();
  for (const container of containers) {
    const childObjs = getAssemblyChildren(container.modelId, container.id);
    for (const child of childObjs) {
      objectToContainerKey.set(`${child.modelId}:${child.id}`, container.key);
    }
  }

  for (const obj of enrichedObjects) {
    const assemblyValue = obj[fieldKey] || "(Không xác định)";

    // Ensure the assembly group exists
    if (!assemblyGroups[assemblyValue]) {
      assemblyGroups[assemblyValue] = {
        name: assemblyValue,
        containers: new Map(),
        orphans: [],
        totalCount: 0,
        totalVolume: 0,
        totalWeight: 0,
        totalArea: 0,
      };
    }

    const group = assemblyGroups[assemblyValue];
    const objKey = `${obj.modelId}:${obj.id}`;
    const containerKey = objectToContainerKey.get(objKey);

    if (containerKey && group.containers.has(containerKey)) {
      // Object belongs to a container within this assembly group
      const containerEntry = group.containers.get(containerKey);
      containerEntry.children.push(obj);
      containerEntry.totalVolume += obj.volume;
      containerEntry.totalWeight += obj.weight;
      containerEntry.totalArea += obj.area;
    } else if (containerKey) {
      // Object belongs to a container, but the container's assembly value differs
      // from the object's own value. Find or create the container in this group.
      const containerInfo = containers.find(c => c.key === containerKey);
      if (containerInfo && !group.containers.has(containerKey)) {
        group.containers.set(containerKey, {
          info: containerInfo,
          children: [],
          totalVolume: 0,
          totalWeight: 0,
          totalArea: 0,
        });
      }
      if (group.containers.has(containerKey)) {
        const containerEntry = group.containers.get(containerKey);
        containerEntry.children.push(obj);
        containerEntry.totalVolume += obj.volume;
        containerEntry.totalWeight += obj.weight;
        containerEntry.totalArea += obj.area;
      } else {
        group.orphans.push(obj);
      }
    } else {
      // Object doesn't belong to any IfcElementAssembly container
      group.orphans.push(obj);
    }

    // Accumulate totals (children only — never container itself)
    group.totalCount++;
    group.totalVolume += obj.volume;
    group.totalWeight += obj.weight;
    group.totalArea += obj.area;
  }

  // Step 3: Remove empty containers (no children matched)
  for (const group of Object.values(assemblyGroups)) {
    for (const [key, entry] of group.containers) {
      if (entry.children.length === 0) {
        group.containers.delete(key);
      }
    }
  }

  return assemblyGroups;
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

    // If weight is 0 but volume exists, calculate with fixed density 7850 kg/m³
    if (wt === 0 && vol > 0) {
      wt = vol * STEEL_DENSITY;
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
      weightSource: obj.weightSource || (wt > 0 && obj.weight === 0 ? "calculated" : (wt > 0 ? "ifc" : "")),
    };
  });

  currentData = enriched;

  // Update summary cards
  document.getElementById("stat-total-objects").textContent = formatNumber(objects.length);
  document.getElementById("stat-total-volume").textContent = formatVolume(totalVolume);
  document.getElementById("stat-total-weight").textContent = formatWeight(totalWeight);
  document.getElementById("stat-total-area").textContent = formatArea(totalArea);

  // ── Assembly grouping: 3-level hierarchy ──
  if (isAssemblyGrouping(groupBy)) {
    const assemblyGroups = buildAssemblyGroupedData(enriched, groupBy);
    if (assemblyGroups) {
      const sortedGroups = Object.values(assemblyGroups).sort((a, b) => b.totalWeight - a.totalWeight);
      renderAssemblyStatsTable(sortedGroups, totalVolume, totalWeight, totalArea, groupBy);

      // Update group count card
      const groupCount = sortedGroups.length;
      const el = document.getElementById("stat-total-groups");
      if (el) el.textContent = formatNumber(groupCount);

      // Hide placeholder
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
        weightSources: new Set(),
      };
    }
    groups[key].count++;
    groups[key].volume += obj.volume;
    groups[key].weight += obj.weight;
    groups[key].area += obj.area;
    if (obj.weightSource) groups[key].weightSources.add(obj.weightSource);
  }

  const sortedGroups = Object.values(groups).sort((a, b) => b.weight - a.weight);

  // Render table
  renderStatsTable(sortedGroups, totalVolume, totalWeight, totalArea);

  // Update group count card
  const el = document.getElementById("stat-total-groups");
  if (el) el.textContent = formatNumber(sortedGroups.length);

  // Hide placeholder
  document.getElementById("stats-placeholder").style.display = "none";
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Render Assembly Stats Table (3-level hierarchy) ──
// Structure:
//   ▶ Assembly Value (total weight/vol/area from children only)
//     📦 IfcElementAssembly "container name" (sub-total from its children)
//       ─ child 1
//       ─ child 2
//     ⚠️ Không thuộc Assembly (orphan children)
// ══════════════════════════════════════════════════════════════════════════════
function renderAssemblyStatsTable(assemblyGroups, totalVolume, totalWeight, totalArea, groupBy) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");

  const fieldLabel = groupBy === "assemblyName" ? "Assembly Name"
    : groupBy === "assemblyPos" ? "Assembly Pos"
    : "Assembly Code";

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
      bodyHtml += `<td>${formatWeight(containerEntry.totalWeight)}</td>`;
      bodyHtml += `</tr>`;

      // Level 3: Children
      for (const child of containerEntry.children) {
        bodyHtml += `<tr class="stats-child-row" data-assembly-group="${escHtml(group.name)}" data-container="${escHtml(containerKey)}">`;
        bodyHtml += `<td class="stats-child-name">─ ${escHtml(child.name || "(Không tên)")}</td>`;
        bodyHtml += `<td>1</td>`;
        bodyHtml += `<td>${formatVolume(child.volume)}</td>`;
        bodyHtml += `<td>${formatArea(child.area)}</td>`;
        bodyHtml += `<td>${formatWeight(child.weight)}</td>`;
        bodyHtml += `</tr>`;
      }
    }

    // Orphan children (not belonging to any IfcElementAssembly)
    if (group.orphans.length > 0) {
      const orphanVol = group.orphans.reduce((s, o) => s + o.volume, 0);
      const orphanWt = group.orphans.reduce((s, o) => s + o.weight, 0);
      const orphanArea = group.orphans.reduce((s, o) => s + o.area, 0);

      bodyHtml += `<tr class="stats-container-row stats-orphan-row" data-assembly-group="${escHtml(group.name)}" data-container="orphans">`;
      bodyHtml += `<td class="stats-container-name">`;
      bodyHtml += `<span class="stats-toggle-sm" onclick="this.closest('tr').classList.toggle('collapsed'); _toggleContainerChildren(this)">▼</span> `;
      bodyHtml += `⚠️ <em>Không thuộc Assembly container</em>`;
      bodyHtml += `</td>`;
      bodyHtml += `<td>${formatNumber(group.orphans.length)}</td>`;
      bodyHtml += `<td>${formatVolume(orphanVol)}</td>`;
      bodyHtml += `<td>${formatArea(orphanArea)}</td>`;
      bodyHtml += `<td>${formatWeight(orphanWt)}</td>`;
      bodyHtml += `</tr>`;

      for (const child of group.orphans) {
        bodyHtml += `<tr class="stats-child-row" data-assembly-group="${escHtml(group.name)}" data-container="orphans">`;
        bodyHtml += `<td class="stats-child-name">─ ${escHtml(child.name || "(Không tên)")}</td>`;
        bodyHtml += `<td>1</td>`;
        bodyHtml += `<td>${formatVolume(child.volume)}</td>`;
        bodyHtml += `<td>${formatArea(child.area)}</td>`;
        bodyHtml += `<td>${formatWeight(child.weight)}</td>`;
        bodyHtml += `</tr>`;
      }
    }
  }

  tbody.innerHTML = bodyHtml;

  tfoot.innerHTML = `
    <tr>
      <td>TỔNG CỘNG</td>
      <td>${formatNumber(totalCount)}</td>
      <td>${formatVolume(totalVolume)}</td>
      <td>${formatArea(totalArea)}</td>
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

  // Toggle visibility of all rows belonging to this group
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

  // Toggle visibility of child rows belonging to this container
  const childRows = table.querySelectorAll(
    `tr.stats-child-row[data-assembly-group="${CSS.escape(groupName)}"][data-container="${CSS.escape(containerKey)}"]`
  );
  childRows.forEach((row) => {
    row.style.display = isCollapsed ? "none" : "";
  });
};

// ── Render Standard Table (flat grouping) ──
function renderStatsTable(groups, totalVolume, totalWeight, totalArea) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");

  let bodyHtml = "";
  for (const g of groups) {
    bodyHtml += `<tr>`;
    bodyHtml += `<td>${escHtml(g.name)}</td>`;
    bodyHtml += `<td>${formatNumber(g.count)}</td>`;
    bodyHtml += `<td>${formatVolume(g.volume)}</td>`;
    bodyHtml += `<td>${formatArea(g.area)}</td>`;
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
