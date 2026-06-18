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

  // UI bindings are set up below after setupColumnToggle()

  // Column toggle (Tất cả / Gross / Net)
  setupColumnToggle();

  // ── Container Search binding (debounced) ──
  let containerSearchTimeout = null;
  const containerSearchInput = document.getElementById("container-search-input");
  const containerSearchClear = document.getElementById("container-search-clear");

  if (containerSearchInput) {
    containerSearchInput.addEventListener("input", () => {
      clearTimeout(containerSearchTimeout);
      containerSearchTimeout = setTimeout(() => {
        filterContainerRows(containerSearchInput.value);
        containerSearchClear.style.display = containerSearchInput.value ? "block" : "none";
      }, 300);
    });
  }
  if (containerSearchClear) {
    containerSearchClear.addEventListener("click", () => {
      if (containerSearchInput) containerSearchInput.value = "";
      containerSearchClear.style.display = "none";
      filterContainerRows("");
    });
  }

  // ── Container Isolate button ──
  const containerIsolateBtn = document.getElementById("btn-container-isolate");
  if (containerIsolateBtn) {
    containerIsolateBtn.addEventListener("click", () => {
      isolateSelectedContainers();
    });
  }

  // ── Show/hide container search row based on group-by mode ──
  const statsGroupBy = document.getElementById("stats-group-by");
  function toggleContainerSearchVisibility() {
    const searchRow = document.getElementById("container-search-row");
    if (searchRow) {
      searchRow.style.display = statsGroupBy.value === "assemblyContainer" ? "flex" : "none";
    }
  }
  if (statsGroupBy) {
    statsGroupBy.addEventListener("change", () => {
      toggleContainerSearchVisibility();
      updateStatistics();
    });
    toggleContainerSearchVisibility();
  }

  document.getElementById("stats-all-toggle").addEventListener("change", updateStatistics);
  document.getElementById("btn-export-all").addEventListener("click", () => exportExcel(false));
  document.getElementById("btn-export-selected").addEventListener("click", () => exportExcel(true));

  // Listen for real-time selection changes (3D → Panel sync)
  window.addEventListener("selection-changed", (e) => {
    const detail = e.detail || {};
    const toggle = document.getElementById("stats-all-toggle");
    if (detail.count > 0) {
      toggle.checked = false;
    } else {
      toggle.checked = true;
    }
    updateStatistics();

    // Sync 3D selection to container checkboxes
    if (isContainerMode(document.getElementById("stats-group-by").value)) {
      syncViewerSelectionToContainerCheckboxes(detail);
    }
  });
}

// ── Check if groupBy is an assembly-type grouping ──
function isAssemblyGrouping(groupBy) {
  return groupBy === "assemblyName" || groupBy === "assemblyPos" || groupBy === "assemblyPosCode";
}

// ── Check if groupBy is the dedicated container mode ──
function isContainerMode(groupBy) {
  return groupBy === "assemblyContainer";
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
        assemblyWeight: container.assemblyWeight || container.weight || 0,
      });
    } else {
      const existing = containerInfoMap.get(containerKey);
      if (!existing.assemblyPos && container.assemblyPos) existing.assemblyPos = container.assemblyPos;
      if (!existing.assemblyName && container.assemblyName) existing.assemblyName = container.assemblyName;
      if (!existing.assemblyPosCode && container.assemblyPosCode) existing.assemblyPosCode = container.assemblyPosCode;
      if (!existing.assemblyWeight && (container.assemblyWeight || container.weight)) {
        existing.assemblyWeight = container.assemblyWeight || container.weight || 0;
      }
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
        totalNetVolume: 0,
        totalGrossVolume: 0,
        totalNetWeight: 0,
        totalGrossWeight: 0,
        totalGrossArea: 0,
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
          totalNetVolume: 0,
          totalGrossVolume: 0,
          totalNetWeight: 0,
          totalGrossWeight: 0,
          totalGrossArea: 0,
          totalNetArea: 0,
          assemblyWeight: cInfo.assemblyWeight || 0,
        });
      }
      const containerEntry = group.containers.get(containerKey);
      containerEntry.children.push(obj);
      containerEntry.totalNetVolume += obj.netVolume || 0;
      containerEntry.totalGrossVolume += obj.grossVolume || 0;
      containerEntry.totalNetWeight += obj.netWeight || 0;
      containerEntry.totalGrossWeight += obj.grossWeight || 0;
      containerEntry.totalGrossArea += obj.grossArea || 0;
      containerEntry.totalNetArea += obj.netArea || 0;
    } else {
      group.orphans.push(obj);
    }

    group.totalCount++;
    group.totalNetVolume += obj.netVolume || 0;
    group.totalGrossVolume += obj.grossVolume || 0;
    group.totalNetWeight += obj.netWeight || 0;
    group.totalGrossWeight += obj.grossWeight || 0;
    group.totalGrossArea += obj.grossArea || 0;
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
  let totalNetVolume = 0, totalGrossVolume = 0;
  let totalNetWeight = 0, totalGrossWeight = 0;
  let totalGrossArea = 0, totalNetArea = 0;

  const enriched = objects.map((obj) => {
    let netVol = obj.netVolume || obj.volume || 0;
    let grossVol = obj.grossVolume || obj.volume || 0;
    let netWt = obj.netWeight || obj.weight || 0;
    let grossWt = obj.grossWeight || obj.weight || 0;
    let grossArea = obj.grossArea || obj.area || 0;
    let netArea = obj.netArea || 0;

    if (netWt === 0 && netVol > 0) {
      netWt = netVol * STEEL_DENSITY;
    }
    if (grossWt === 0 && grossVol > 0) {
      grossWt = grossVol * STEEL_DENSITY;
    }

    totalNetVolume += netVol;
    totalGrossVolume += grossVol;
    totalNetWeight += netWt;
    totalGrossWeight += grossWt;
    totalGrossArea += grossArea;
    totalNetArea += netArea;

    return {
      ...obj,
      netVolume: netVol,
      grossVolume: grossVol,
      netWeight: netWt,
      grossWeight: grossWt,
      grossArea,
      netArea,
      volume: netVol,
      weight: netWt,
      area: grossArea,
      density: obj.density || STEEL_DENSITY,
      weightSource: obj.weightSource || (netWt > 0 && obj.weight === 0 ? "calculated" : (netWt > 0 ? "ifc" : "")),
    };
  });

  currentData = enriched;

  // Update summary cards
  document.getElementById("stat-total-objects").textContent = formatNumber(objects.length);
  if (document.getElementById("stat-total-gross-volume")) document.getElementById("stat-total-gross-volume").textContent = formatVolume(totalGrossVolume);
  if (document.getElementById("stat-total-net-volume")) document.getElementById("stat-total-net-volume").textContent = formatVolume(totalNetVolume);
  if (document.getElementById("stat-total-gross-area")) document.getElementById("stat-total-gross-area").textContent = formatArea(totalGrossArea);
  if (document.getElementById("stat-total-net-area")) document.getElementById("stat-total-net-area").textContent = formatArea(totalNetArea);
  if (document.getElementById("stat-total-gross-weight")) document.getElementById("stat-total-gross-weight").textContent = formatWeight(totalGrossWeight);
  if (document.getElementById("stat-total-net-weight")) document.getElementById("stat-total-net-weight").textContent = formatWeight(totalNetWeight);

  // ── Assembly Container mode: show containers as primary items ──
  if (isContainerMode(groupBy)) {
    renderContainerStatsTable(enriched, totalNetVolume, totalGrossVolume, totalNetWeight, totalGrossWeight, totalGrossArea, totalNetArea);
    document.getElementById("stats-placeholder").style.display = "none";
    return;
  }

  // ── Standard flat grouping ──
  const groups = {};
  for (const obj of enriched) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = {
        name: key,
        count: 0,
        netVolume: 0,
        grossVolume: 0,
        netWeight: 0,
        grossWeight: 0,
        grossArea: 0,
        netArea: 0,
        weightSources: new Set(),
      };
    }
    groups[key].count++;
    groups[key].netVolume += obj.netVolume || 0;
    groups[key].grossVolume += obj.grossVolume || 0;
    groups[key].netWeight += obj.netWeight || 0;
    groups[key].grossWeight += obj.grossWeight || 0;
    groups[key].grossArea += obj.grossArea || 0;
    groups[key].netArea += obj.netArea || 0;
    if (obj.weightSource) groups[key].weightSources.add(obj.weightSource);
  }

  const sortedGroups = Object.values(groups).sort((a, b) => b.netWeight - a.netWeight);

  renderStatsTable(sortedGroups, totalNetVolume, totalGrossVolume, totalNetWeight, totalGrossWeight, totalGrossArea, totalNetArea);

  const el = document.getElementById("stat-total-groups");
  if (el) el.textContent = formatNumber(sortedGroups.length);

  document.getElementById("stats-placeholder").style.display = "none";
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Render Assembly Stats Table (3-level hierarchy) ──
// ══════════════════════════════════════════════════════════════════════════════
function renderAssemblyStatsTable(assemblyGroups, totalNetVolume, totalGrossVolume, totalNetWeight, totalGrossWeight, totalGrossArea, totalNetArea, groupBy) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");

  // Check if any group has assembly weight data
  let hasAsmWeight = false;
  for (const group of assemblyGroups) {
    for (const [, containerEntry] of group.containers) {
      if (containerEntry.assemblyWeight > 0) {
        hasAsmWeight = true;
        break;
      }
    }
    if (hasAsmWeight) break;
  }

  // Update table header to include assembly weight column if data exists
  const thead = document.querySelector("#stats-table thead tr");
  if (thead) {
    const asmHeader = thead.querySelector(".asm-weight-header");
    if (hasAsmWeight) {
      if (!asmHeader) {
        const th = document.createElement("th");
        th.className = "asm-weight-header";
        th.textContent = "Asm Weight (kg)";
        const lastTh = thead.querySelectorAll("th");
        lastTh[lastTh.length - 1].after(th);
      }
    } else if (asmHeader) {
      asmHeader.remove();
    }
  }

  let bodyHtml = "";
  let totalCount = 0;
  let totalAsmWeight = 0;

  for (const group of assemblyGroups) {
    totalCount += group.totalCount;

    // Calculate group-level assembly weight
    let groupAsmWeight = 0;
    for (const [, containerEntry] of group.containers) {
      if (containerEntry.assemblyWeight > 0) {
        groupAsmWeight += containerEntry.assemblyWeight;
      }
    }
    totalAsmWeight += groupAsmWeight;

    // Level 1: Assembly value header row
    bodyHtml += `<tr class="stats-group-header" data-assembly-group="${escHtml(group.name)}">`;
    bodyHtml += `<td class="stats-group-name">`;
    bodyHtml += `<span class="stats-toggle" onclick="this.closest('tr').classList.toggle('collapsed'); _toggleAssemblyGroup(this)">▼</span> `;
    bodyHtml += `<strong>🏗️ ${escHtml(group.name)}</strong>`;
    bodyHtml += `</td>`;
    bodyHtml += `<td><strong>${formatNumber(group.totalCount)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatVolume(group.totalGrossVolume)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatVolume(group.totalNetVolume)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatArea(group.totalGrossArea)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatArea(group.totalNetArea)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatWeight(group.totalGrossWeight)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatWeight(group.totalNetWeight)}</strong></td>`;
    if (hasAsmWeight) {
      bodyHtml += `<td><strong>${groupAsmWeight > 0 ? formatWeight(groupAsmWeight) : "—"}</strong></td>`;
    }
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
      bodyHtml += `<td class="col-gross">${formatVolume(containerEntry.totalGrossVolume)}</td>`;
      bodyHtml += `<td class="col-net">${formatVolume(containerEntry.totalNetVolume)}</td>`;
      bodyHtml += `<td class="col-gross">${formatArea(containerEntry.totalGrossArea)}</td>`;
      bodyHtml += `<td class="col-net">${formatArea(containerEntry.totalNetArea)}</td>`;
      bodyHtml += `<td class="col-gross">${formatWeight(containerEntry.totalGrossWeight)}</td>`;
      bodyHtml += `<td class="col-net">${formatWeight(containerEntry.totalNetWeight)}</td>`;
      if (hasAsmWeight) {
        bodyHtml += `<td>${containerEntry.assemblyWeight > 0 ? formatWeight(containerEntry.assemblyWeight) : "—"}</td>`;
      }
      bodyHtml += `</tr>`;

      // Level 3: Children
      for (const child of containerEntry.children) {
        bodyHtml += `<tr class="stats-child-row" data-assembly-group="${escHtml(group.name)}" data-container="${escHtml(containerKey)}">`;
        bodyHtml += `<td class="stats-child-name">─ ${escHtml(child.name || "(Không tên)")}</td>`;
        bodyHtml += `<td>1</td>`;
        bodyHtml += `<td class="col-gross">${formatVolume(child.grossVolume)}</td>`;
        bodyHtml += `<td class="col-net">${formatVolume(child.netVolume)}</td>`;
        bodyHtml += `<td class="col-gross">${formatArea(child.grossArea)}</td>`;
        bodyHtml += `<td class="col-net">${formatArea(child.netArea || 0)}</td>`;
        bodyHtml += `<td class="col-gross">${formatWeight(child.grossWeight)}</td>`;
        bodyHtml += `<td class="col-net">${formatWeight(child.netWeight)}</td>`;
        if (hasAsmWeight) {
          bodyHtml += `<td>${child.assemblyWeight > 0 ? formatWeight(child.assemblyWeight) : "—"}</td>`;
        }
        bodyHtml += `</tr>`;
      }
    }

    // Render direct children (not in IfcElementAssembly container)
    for (const child of group.orphans) {
      bodyHtml += `<tr class="stats-child-row" data-assembly-group="${escHtml(group.name)}" data-container="direct">`;
      bodyHtml += `<td class="stats-child-name">─ ${escHtml(child.name || "(Không tên)")}</td>`;
      bodyHtml += `<td>1</td>`;
      bodyHtml += `<td class="col-gross">${formatVolume(child.grossVolume)}</td>`;
      bodyHtml += `<td class="col-net">${formatVolume(child.netVolume)}</td>`;
      bodyHtml += `<td class="col-gross">${formatArea(child.grossArea)}</td>`;
      bodyHtml += `<td class="col-net">${formatArea(child.netArea || 0)}</td>`;
      bodyHtml += `<td class="col-gross">${formatWeight(child.grossWeight)}</td>`;
      bodyHtml += `<td class="col-net">${formatWeight(child.netWeight)}</td>`;
      if (hasAsmWeight) {
        bodyHtml += `<td>${child.assemblyWeight > 0 ? formatWeight(child.assemblyWeight) : "—"}</td>`;
      }
      bodyHtml += `</tr>`;
    }
  }

  tbody.innerHTML = bodyHtml;

  let footerHtml = `
    <tr>
      <td>TỔNG CỘNG</td>
      <td>${formatNumber(totalCount)}</td>
      <td class="col-gross">${formatVolume(totalGrossVolume)}</td>
      <td class="col-net">${formatVolume(totalNetVolume)}</td>
      <td class="col-gross">${formatArea(totalGrossArea)}</td>
      <td class="col-net">${formatArea(totalNetArea)}</td>
      <td class="col-gross">${formatWeight(totalGrossWeight)}</td>
      <td class="col-net">${formatWeight(totalNetWeight)}</td>`;
  if (hasAsmWeight) {
    footerHtml += `<td>${totalAsmWeight > 0 ? formatWeight(totalAsmWeight) : "—"}</td>`;
  }
  footerHtml += `</tr>`;
  tfoot.innerHTML = footerHtml;
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
function renderStatsTable(groups, totalNetVolume, totalGrossVolume, totalNetWeight, totalGrossWeight, totalGrossArea, totalNetArea) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");

  // Remove assembly weight header from table header if it exists
  const thead = document.querySelector("#stats-table thead tr");
  if (thead) {
    const asmHeader = thead.querySelector(".asm-weight-header");
    if (asmHeader) {
      asmHeader.remove();
    }
  }

  let bodyHtml = "";
  for (const g of groups) {
    bodyHtml += `<tr>`;
    bodyHtml += `<td>${escHtml(g.name)}</td>`;
    bodyHtml += `<td>${formatNumber(g.count)}</td>`;
    bodyHtml += `<td class="col-gross">${formatVolume(g.grossVolume)}</td>`;
    bodyHtml += `<td class="col-net">${formatVolume(g.netVolume)}</td>`;
    bodyHtml += `<td class="col-gross">${formatArea(g.grossArea)}</td>`;
    bodyHtml += `<td class="col-net">${formatArea(g.netArea)}</td>`;
    bodyHtml += `<td class="col-gross">${formatWeight(g.grossWeight)}</td>`;
    bodyHtml += `<td class="col-net">${formatWeight(g.netWeight)}</td>`;
    bodyHtml += `</tr>`;
  }
  tbody.innerHTML = bodyHtml;

  tfoot.innerHTML = `
    <tr>
      <td>TỔNG CỘNG</td>
      <td>${formatNumber(groups.reduce((s, g) => s + g.count, 0))}</td>
      <td class="col-gross">${formatVolume(totalGrossVolume)}</td>
      <td class="col-net">${formatVolume(totalNetVolume)}</td>
      <td class="col-gross">${formatArea(totalGrossArea)}</td>
      <td class="col-net">${formatArea(totalNetArea)}</td>
      <td class="col-gross">${formatWeight(totalGrossWeight)}</td>
      <td class="col-net">${formatWeight(totalNetWeight)}</td>
    </tr>
  `;
}
// ══════════════════════════════════════════════════════════════════════════════
// ── Render Container Stats Table (UPGRADED) ──
// - Checkbox per container (for selection + V/A/W display)
// - Position Code displayed
// - Search via filterContainerRows
// - 2-way sync with 3D viewer
// - Isolate support
// ══════════════════════════════════════════════════════════════════════════════
function renderContainerStatsTable(enrichedObjects, totalNetVolume, totalGrossVolume, totalNetWeight, totalGrossWeight, totalGrossArea, totalNetArea) {
  const tbody = document.getElementById("stats-table-body");
  const tfoot = document.getElementById("stats-table-footer");
  const containers = getSavedAssemblyContainers();

  // Remove assembly weight header if exists
  const thead = document.querySelector("#stats-table thead tr");
  if (thead) {
    const asmHeader = thead.querySelector(".asm-weight-header");
    if (asmHeader) asmHeader.remove();
  }

  if (!containers || containers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:20px;">Không tìm thấy IfcElementAssembly container</td></tr>`;
    tfoot.innerHTML = "";
    const el = document.getElementById("stat-total-groups");
    if (el) el.textContent = "0";
    return;
  }

  // Build children lookup + compute V/A/W from children
  const containerChildrenMap_local = new Map();
  const allContainerChildKeys = new Set();
  const containerVAW = new Map(); // containerKey → { weight, volume, area }

  for (const container of containers) {
    const containerKey = `${container.modelId}:${container.id}`;
    const childIds = getAssemblyChildren(container.modelId, container.id);
    containerChildrenMap_local.set(containerKey, childIds);

    let totalW = 0, totalV = 0, totalA = 0;
    for (const child of childIds) {
      allContainerChildKeys.add(`${child.modelId}:${child.id}`);
      const enriched = enrichedObjects.find(e => e.modelId === child.modelId && e.id === child.id);
      if (enriched) {
        totalW += enriched.netWeight || enriched.weight || 0;
        totalV += enriched.netVolume || enriched.volume || 0;
        totalA += enriched.grossArea || enriched.area || 0;
      }
    }
    // Fallback to container's own values if children sum = 0
    if (totalW === 0 && totalV === 0) {
      totalW = container.weight || container.assemblyWeight || 0;
      totalV = container.volume || 0;
      totalA = container.area || 0;
    }
    containerVAW.set(containerKey, { weight: totalW, volume: totalV, area: totalA });
  }

  // Sort containers
  const sorted = [...containers].sort((a, b) => {
    const nameA = (a.assemblyName || a.name || "").toLowerCase();
    const nameB = (b.assemblyName || b.name || "").toLowerCase();
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    return (a.assemblyPos || "").localeCompare(b.assemblyPos || "");
  });

  let bodyHtml = "";
  let containerTotalWeight = 0, containerTotalVolume = 0, containerTotalArea = 0;

  for (const container of sorted) {
    const containerKey = `${container.modelId}:${container.id}`;
    const children = containerChildrenMap_local.get(containerKey) || [];
    const vaw = containerVAW.get(containerKey) || { weight: 0, volume: 0, area: 0 };

    const asmName = container.assemblyName || container.name || "";
    const asmPos = container.assemblyPos || "";
    const asmPosCode = container.assemblyPosCode || "";
    const searchText = `${asmName} ${asmPos} ${asmPosCode}`.toLowerCase();

    // Build display label: Pos | Name | Code
    let displayParts = [];
    if (asmPos) displayParts.push(asmPos);
    if (asmName) displayParts.push(asmName);
    if (asmPosCode) displayParts.push(`[${asmPosCode}]`);
    const displayName = displayParts.join(" | ") || `Container ${container.id}`;

    containerTotalWeight += vaw.weight;
    containerTotalVolume += vaw.volume;
    containerTotalArea += vaw.area;

    // Container header row with checkbox
    bodyHtml += `<tr class="stats-group-header container-selectable" data-assembly-group="${escHtml(containerKey)}" data-container-key="${escHtml(containerKey)}" data-search-text="${escHtml(searchText)}" data-model-id="${escHtml(container.modelId)}" data-object-id="${container.id}">`;
    bodyHtml += `<td class="stats-group-name">`;
    bodyHtml += `<input type="checkbox" class="container-checkbox" data-container-key="${escHtml(containerKey)}" onclick="event.stopPropagation(); window._onContainerCheckboxChanged()" /> `;
    bodyHtml += `<span class="stats-toggle" onclick="event.stopPropagation(); this.closest('tr').classList.toggle('collapsed'); _toggleAssemblyGroup(this)">▼</span> `;
    bodyHtml += `<strong>📦 ${escHtml(displayName)}</strong>`;
    bodyHtml += `</td>`;
    bodyHtml += `<td><strong>${formatNumber(children.length)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatVolume(vaw.volume)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatVolume(vaw.volume)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatArea(vaw.area)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatArea(vaw.area)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatWeight(vaw.weight)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatWeight(vaw.weight)}</strong></td>`;
    bodyHtml += `</tr>`;

    // Children rows
    for (const child of children) {
      const enrichedChild = enrichedObjects.find(e => e.modelId === child.modelId && e.id === child.id);
      const cObj = enrichedChild || child;
      bodyHtml += `<tr class="stats-child-row" data-assembly-group="${escHtml(containerKey)}" data-container-key="${escHtml(containerKey)}">`;
      bodyHtml += `<td class="stats-child-name">─ ${escHtml(cObj.name || "(Không tên)")}</td>`;
      bodyHtml += `<td>1</td>`;
      bodyHtml += `<td class="col-gross">${formatVolume(cObj.grossVolume || cObj.volume || 0)}</td>`;
      bodyHtml += `<td class="col-net">${formatVolume(cObj.netVolume || cObj.volume || 0)}</td>`;
      bodyHtml += `<td class="col-gross">${formatArea(cObj.grossArea || cObj.area || 0)}</td>`;
      bodyHtml += `<td class="col-net">${formatArea(cObj.netArea || 0)}</td>`;
      bodyHtml += `<td class="col-gross">${formatWeight(cObj.grossWeight || cObj.weight || 0)}</td>`;
      bodyHtml += `<td class="col-net">${formatWeight(cObj.netWeight || cObj.weight || 0)}</td>`;
      bodyHtml += `</tr>`;
    }
  }

  // Orphan objects
  const orphans = enrichedObjects.filter(obj => !allContainerChildKeys.has(`${obj.modelId}:${obj.id}`));
  if (orphans.length > 0) {
    let orphanWeight = 0, orphanVolume = 0, orphanArea = 0;
    for (const o of orphans) {
      orphanWeight += o.grossWeight || o.weight || 0;
      orphanVolume += o.grossVolume || o.volume || 0;
      orphanArea += o.grossArea || o.area || 0;
    }

    bodyHtml += `<tr class="stats-group-header" data-assembly-group="__orphans__" data-search-text="orphan không thuộc container">`;
    bodyHtml += `<td class="stats-group-name">`;
    bodyHtml += `<span class="stats-toggle" onclick="this.closest('tr').classList.toggle('collapsed'); _toggleAssemblyGroup(this)">▼</span> `;
    bodyHtml += `<strong>🔗 Không thuộc Container</strong>`;
    bodyHtml += `</td>`;
    bodyHtml += `<td><strong>${formatNumber(orphans.length)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatVolume(orphanVolume)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatVolume(orphanVolume)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatArea(orphanArea)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatArea(orphanArea)}</strong></td>`;
    bodyHtml += `<td class="col-gross"><strong>${formatWeight(orphanWeight)}</strong></td>`;
    bodyHtml += `<td class="col-net"><strong>${formatWeight(orphanWeight)}</strong></td>`;
    bodyHtml += `</tr>`;

    for (const obj of orphans) {
      bodyHtml += `<tr class="stats-child-row" data-assembly-group="__orphans__">`;
      bodyHtml += `<td class="stats-child-name">─ ${escHtml(obj.name || "(Không tên)")}</td>`;
      bodyHtml += `<td>1</td>`;
      bodyHtml += `<td class="col-gross">${formatVolume(obj.grossVolume || obj.volume || 0)}</td>`;
      bodyHtml += `<td class="col-net">${formatVolume(obj.netVolume || obj.volume || 0)}</td>`;
      bodyHtml += `<td class="col-gross">${formatArea(obj.grossArea || obj.area || 0)}</td>`;
      bodyHtml += `<td class="col-net">${formatArea(obj.netArea || 0)}</td>`;
      bodyHtml += `<td class="col-gross">${formatWeight(obj.grossWeight || obj.weight || 0)}</td>`;
      bodyHtml += `<td class="col-net">${formatWeight(obj.netWeight || obj.weight || 0)}</td>`;
      bodyHtml += `</tr>`;
    }
  }

  tbody.innerHTML = bodyHtml;

  // Bind click on container row → toggle checkbox + select in 3D
  tbody.querySelectorAll("tr.container-selectable").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || e.target.classList.contains("stats-toggle")) return;
      const cb = row.querySelector(".container-checkbox");
      if (cb) {
        cb.checked = !cb.checked;
        window._onContainerCheckboxChanged();
      }
    });
  });

  tfoot.innerHTML = `
    <tr>
      <td>TỔNG CỘNG (${sorted.length} containers)</td>
      <td>${formatNumber(enrichedObjects.length)}</td>
      <td class="col-gross">${formatVolume(totalGrossVolume)}</td>
      <td class="col-net">${formatVolume(totalNetVolume)}</td>
      <td class="col-gross">${formatArea(totalGrossArea)}</td>
      <td class="col-net">${formatArea(totalNetArea)}</td>
      <td class="col-gross">${formatWeight(totalGrossWeight)}</td>
      <td class="col-net">${formatWeight(totalNetWeight)}</td>
    </tr>
  `;

  const el = document.getElementById("stat-total-groups");
  if (el) el.textContent = formatNumber(sorted.length);

  // Apply any existing search filter
  const searchInput = document.getElementById("container-search-input");
  if (searchInput && searchInput.value) {
    filterContainerRows(searchInput.value);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Container Search (filter table rows by name/pos/code) ──
// ══════════════════════════════════════════════════════════════════════════════
function filterContainerRows(query) {
  const tbody = document.getElementById("stats-table-body");
  if (!tbody) return;

  const terms = query.trim().toLowerCase().split(",").map(t => t.trim()).filter(t => t);
  const headerRows = tbody.querySelectorAll("tr.stats-group-header");

  for (const headerRow of headerRows) {
    const searchText = headerRow.dataset.searchText || "";
    const containerKey = headerRow.dataset.assemblyGroup;

    let visible = true;
    if (terms.length > 0) {
      visible = terms.some(term => searchText.includes(term));
    }

    headerRow.style.display = visible ? "" : "none";

    // Also show/hide children
    const childRows = tbody.querySelectorAll(`tr.stats-child-row[data-assembly-group="${CSS.escape(containerKey)}"]`);
    for (const childRow of childRows) {
      childRow.style.display = visible ? "" : "none";
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Container Checkbox Changed → select in 3D + update V/A/W summary ──
// ══════════════════════════════════════════════════════════════════════════════
window._onContainerCheckboxChanged = function() {
  const checkedBoxes = document.querySelectorAll(".container-checkbox:checked");
  const checkedKeys = new Set();
  const modelMap = {};

  for (const cb of checkedBoxes) {
    const key = cb.dataset.containerKey;
    checkedKeys.add(key);
    const row = cb.closest("tr");
    const modelId = row?.dataset.modelId;
    const objectId = parseInt(row?.dataset.objectId);
    if (modelId && !isNaN(objectId)) {
      if (!modelMap[modelId]) modelMap[modelId] = [];
      modelMap[modelId].push(objectId);

      // Also add children IDs
      const children = getAssemblyChildren(modelId, objectId);
      for (const child of children) {
        if (!modelMap[child.modelId]) modelMap[child.modelId] = [];
        modelMap[child.modelId].push(child.id);
      }
    }
  }

  // Highlight selected rows
  document.querySelectorAll("tr.container-selectable").forEach(row => {
    const key = row.dataset.containerKey;
    row.classList.toggle("container-selected", checkedKeys.has(key));
  });

  // Update V/A/W summary from selected containers
  if (checkedKeys.size > 0) {
    let selWeight = 0, selVolume = 0, selArea = 0;
    for (const cb of checkedBoxes) {
      const row = cb.closest("tr");
      // Parse V/A/W from table cells
      const cells = row.querySelectorAll("td");
      if (cells.length >= 8) {
        selVolume += parseFloat(cells[2].textContent) || 0;
        selArea += parseFloat(cells[4].textContent) || 0;
        selWeight += parseFloat(cells[6].textContent) || 0;
      }
    }

    // Update summary cards with selected containers' totals
    if (document.getElementById("stat-total-gross-volume")) document.getElementById("stat-total-gross-volume").textContent = formatVolume(selVolume);
    if (document.getElementById("stat-total-net-volume")) document.getElementById("stat-total-net-volume").textContent = formatVolume(selVolume);
    if (document.getElementById("stat-total-gross-area")) document.getElementById("stat-total-gross-area").textContent = formatArea(selArea);
    if (document.getElementById("stat-total-net-area")) document.getElementById("stat-total-net-area").textContent = formatArea(selArea);
    if (document.getElementById("stat-total-gross-weight")) document.getElementById("stat-total-gross-weight").textContent = formatWeight(selWeight);
    if (document.getElementById("stat-total-net-weight")) document.getElementById("stat-total-net-weight").textContent = formatWeight(selWeight);
    document.getElementById("stat-total-objects").textContent = formatNumber(checkedKeys.size) + " asm";
  }

  // Sync to 3D viewer: select container + children
  if (viewerRef && Object.keys(modelMap).length > 0) {
    const modelObjectIds = Object.entries(modelMap).map(([modelId, ids]) => ({
      modelId,
      objectRuntimeIds: [...new Set(ids)],
    }));
    viewerRef.setSelection({ modelObjectIds }, "set").catch(e => {
      console.warn("[Statistics] Failed to sync container selection to 3D:", e);
    });
  } else if (viewerRef) {
    viewerRef.setSelection({ modelObjectIds: [] }, "set").catch(() => {});
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// ── Isolate Selected Containers in 3D ──
// Includes fallback methods matching objectExplorer's isolate pattern
// ══════════════════════════════════════════════════════════════════════════════
let containerIsolateActive = false;

async function isolateSelectedContainers() {
  const btn = document.getElementById("btn-container-isolate");

  // Toggle off if already isolating
  if (containerIsolateActive) {
    try {
      await viewerRef.setObjectState(undefined, { visible: "reset" });
      await viewerRef.setObjectState(undefined, { color: "reset" });
      containerIsolateActive = false;
      if (btn) btn.classList.remove("active");
      console.log("[Statistics] Container isolation reset");
    } catch (e) {
      console.warn("[Statistics] Reset failed:", e);
      try { await viewerRef.reset(); } catch (e2) {}
      containerIsolateActive = false;
      if (btn) btn.classList.remove("active");
    }
    return;
  }

  const checkedBoxes = document.querySelectorAll(".container-checkbox:checked");
  if (checkedBoxes.length === 0) {
    console.warn("[Statistics] No containers selected to isolate");
    return;
  }

  const modelMap = {};
  for (const cb of checkedBoxes) {
    const row = cb.closest("tr");
    const modelId = row?.dataset.modelId;
    const objectId = parseInt(row?.dataset.objectId);
    if (modelId && !isNaN(objectId)) {
      if (!modelMap[modelId]) modelMap[modelId] = new Set();
      modelMap[modelId].add(objectId);

      // Include children
      const children = getAssemblyChildren(modelId, objectId);
      for (const child of children) {
        if (!modelMap[child.modelId]) modelMap[child.modelId] = new Set();
        modelMap[child.modelId].add(child.id);
      }
    }
  }

  const modelEntities = Object.entries(modelMap).map(([modelId, ids]) => ({
    modelId,
    entityIds: [...ids],
  }));

  const totalIds = modelEntities.reduce((sum, m) => sum + m.entityIds.length, 0);
  console.log(`[Statistics] Attempting isolate: ${checkedBoxes.length} containers → ${totalIds} entities`);

  if (!viewerRef || modelEntities.length === 0) return;

  try {
    // Primary method: isolateEntities
    await viewerRef.isolateEntities(modelEntities);
    containerIsolateActive = true;
    if (btn) btn.classList.add("active");
    console.log(`[Statistics] ✓ Isolated ${checkedBoxes.length} containers (${totalIds} entities)`);
  } catch (e) {
    console.warn("[Statistics] isolateEntities failed, trying fallback (setObjectState):", e);

    // Fallback: hide all, show selected
    try {
      await viewerRef.setObjectState(undefined, { visible: false });
      await viewerRef.setObjectState(
        {
          modelObjectIds: Object.entries(modelMap).map(([modelId, ids]) => ({
            modelId,
            objectRuntimeIds: [...ids],
          })),
        },
        { visible: true },
      );
      containerIsolateActive = true;
      if (btn) btn.classList.add("active");
      console.log(`[Statistics] ✓ Fallback isolate succeeded: ${totalIds} entities`);
    } catch (e2) {
      console.warn("[Statistics] Fallback isolate also failed:", e2);

      // Fallback 2: try entityIds with setObjectState
      try {
        await viewerRef.setObjectState(undefined, { visible: false });
        await viewerRef.setObjectState(
          { modelObjectIds: modelEntities },
          { visible: true },
        );
        containerIsolateActive = true;
        if (btn) btn.classList.add("active");
        console.log(`[Statistics] ✓ Fallback 2 isolate succeeded`);
      } catch (e3) {
        console.error("[Statistics] All isolate methods failed:", e3);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Sync 3D Viewer Selection → Container Checkboxes (3D → Panel) ──
// ══════════════════════════════════════════════════════════════════════════════
function syncViewerSelectionToContainerCheckboxes(detail) {
  // detail.selectedIds = array of "modelId:objectId" strings from objectExplorer
  const selectedIdsList = detail.selectedIds || [];
  if (!selectedIdsList || selectedIdsList.length === 0) return;

  // Find which containers are related to the selected objects
  const containers = getSavedAssemblyContainers();
  if (!containers || containers.length === 0) return;

  const selectedSet = new Set(selectedIdsList);
  const matchedContainerKeys = new Set();

  for (const container of containers) {
    const containerKey = `${container.modelId}:${container.id}`;

    // Check if the container itself was selected
    if (selectedSet.has(containerKey)) {
      matchedContainerKeys.add(containerKey);
      continue;
    }

    // Check if any child of this container was selected
    const children = getAssemblyChildren(container.modelId, container.id);
    for (const child of children) {
      if (selectedSet.has(`${child.modelId}:${child.id}`)) {
        matchedContainerKeys.add(containerKey);
        break;
      }
    }
  }

  // Update checkboxes
  if (matchedContainerKeys.size > 0) {
    document.querySelectorAll(".container-checkbox").forEach(cb => {
      cb.checked = matchedContainerKeys.has(cb.dataset.containerKey);
    });

    // Highlight rows and scroll to first matched
    document.querySelectorAll("tr.container-selectable").forEach(row => {
      const key = row.dataset.containerKey;
      row.classList.toggle("container-selected", matchedContainerKeys.has(key));
    });

    // Scroll to first matched container
    const firstMatched = document.querySelector("tr.container-selected");
    if (firstMatched) {
      firstMatched.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    // Update V/A/W summary (without triggering 3D selection loop)
    const checkedBoxes = document.querySelectorAll(".container-checkbox:checked");
    let selWeight = 0, selVolume = 0, selArea = 0;
    for (const cb of checkedBoxes) {
      const row = cb.closest("tr");
      const cells = row.querySelectorAll("td");
      if (cells.length >= 8) {
        selVolume += parseFloat(cells[2].textContent) || 0;
        selArea += parseFloat(cells[4].textContent) || 0;
        selWeight += parseFloat(cells[6].textContent) || 0;
      }
    }
    if (document.getElementById("stat-total-gross-volume")) document.getElementById("stat-total-gross-volume").textContent = formatVolume(selVolume);
    if (document.getElementById("stat-total-net-volume")) document.getElementById("stat-total-net-volume").textContent = formatVolume(selVolume);
    if (document.getElementById("stat-total-gross-area")) document.getElementById("stat-total-gross-area").textContent = formatArea(selArea);
    if (document.getElementById("stat-total-net-area")) document.getElementById("stat-total-net-area").textContent = formatArea(selArea);
    if (document.getElementById("stat-total-gross-weight")) document.getElementById("stat-total-gross-weight").textContent = formatWeight(selWeight);
    if (document.getElementById("stat-total-net-weight")) document.getElementById("stat-total-net-weight").textContent = formatWeight(selWeight);
    document.getElementById("stat-total-objects").textContent = formatNumber(matchedContainerKeys.size) + " asm";
  }
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
    case "assemblyContainer": return obj.assemblyName || obj.assembly || "(Không xác định)";
    default: return obj.assemblyDisplayName || obj.assembly;
  }
}

function clearStats() {
  document.getElementById("stat-total-objects").textContent = "0";
  document.getElementById("stat-total-groups").textContent = "0";

  if (document.getElementById("stat-total-gross-volume")) document.getElementById("stat-total-gross-volume").textContent = "0 m³";
  if (document.getElementById("stat-total-net-volume")) document.getElementById("stat-total-net-volume").textContent = "0 m³";
  if (document.getElementById("stat-total-gross-area")) document.getElementById("stat-total-gross-area").textContent = "0 m²";
  if (document.getElementById("stat-total-net-area")) document.getElementById("stat-total-net-area").textContent = "0 m²";
  if (document.getElementById("stat-total-gross-weight")) document.getElementById("stat-total-gross-weight").textContent = "0 kg";
  if (document.getElementById("stat-total-net-weight")) document.getElementById("stat-total-net-weight").textContent = "0 kg";

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

// ── Column Toggle (Tất cả / Gross / Net) ──
function setupColumnToggle() {
  const toggleBar = document.getElementById("table-toggle-bar");
  if (!toggleBar) return;

  const buttons = toggleBar.querySelectorAll(".table-toggle-btn");
  const table = document.getElementById("stats-table");
  if (!table) return;

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      // Update active state
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const mode = btn.dataset.mode;
      table.classList.remove("hide-net", "hide-gross");

      if (mode === "gross") {
        table.classList.add("hide-net");
      } else if (mode === "net") {
        table.classList.add("hide-gross");
      }
      // mode === "all" → no class needed, show everything
    });
  });
}
