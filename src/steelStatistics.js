/**
 * steelStatistics.js - Feature 2: Volume & Steel Weight Statistics + Excel Export
 * Uses real IFC property data (volume, weight) from parsed PropertySets.
 * Supports grouping by name/assembly/type/group/material, scope toggle,
 * all-object vs steel-only mode, collapsible groups.
 */

import { getIsConnected, showToast } from "./main.js";
import { getAllObjects, getSelectedIds } from "./objectExplorer.js";
import { exportToExcel } from "./excelExport.js";

let statsData = [];
let groupedData = new Map();
let currentSort = { field: "name", asc: true };
let currentGroupBy = "none";
let useSelectedOnly = false;
let steelOnlyMode = true; // true = steel only, false = all objects
let expandedGroups = new Set();
const DEFAULT_DENSITY = 7850; // kg/m³

// ========================
// Steel detection heuristics
// ========================

const STEEL_MATERIAL_KEYWORDS = [
  "steel", "thép", "s355", "s235", "a36", "ss400", "metal",
  "q345", "q235", "sm490", "a572", "a992", "hy80", "cor-ten",
  "stainless", "galvanized", "zinc",
];

const STEEL_CLASS_KEYWORDS = [
  "ifcbeam", "ifccolumn", "ifcplate", "ifcmember",
  "ifcfastener", "ifcmechanicalfastener", "ifcrailing",
  "ifcstairflight", "ifcramp", "ifcdiscreteaccessory",
  "ifcbuildingelementproxy",
];

const STEEL_TYPE_KEYWORDS = [
  "beam", "column", "brace", "plate", "purlin", "rafter",
  "truss", "stiffener", "bolt", "anchor", "girder", "joist",
  "channel", "angle", "tube", "pipe", "h-beam", "i-beam",
  "w-beam", "hss", "shs", "rhs", "chs",
];

function isSteelObject(obj) {
  const mat = (obj.material || "").toLowerCase();
  const type = (obj.type || "").toLowerCase();
  const name = (obj.name || "").toLowerCase();
  const cls = (obj.class || "").toLowerCase();

  // Check material field
  if (STEEL_MATERIAL_KEYWORDS.some((kw) => mat.includes(kw))) return true;

  // Check IFC class
  if (STEEL_CLASS_KEYWORDS.some((kw) => cls.includes(kw))) return true;

  // Heuristic: if material is empty, check type/name
  if (!mat || mat === "unknown" || mat === "") {
    if (STEEL_TYPE_KEYWORDS.some((kw) => type.includes(kw) || name.includes(kw))) return true;
  }

  return false;
}

// ========================
// Compute Statistics
// ========================

function computeStats() {
  const allObjects = getAllObjects();
  const selectedIds = getSelectedIds();
  const density = parseFloat(document.getElementById("steelDensity").value) || DEFAULT_DENSITY;

  // Determine source: all or selected only
  let sourceObjects = allObjects;
  if (useSelectedOnly && selectedIds.size > 0) {
    sourceObjects = allObjects.filter((obj) => selectedIds.has(obj.id));
  }

  // Apply steel filter if in steel-only mode
  let filteredObjects = sourceObjects;
  if (steelOnlyMode) {
    filteredObjects = sourceObjects.filter(isSteelObject);
  }

  statsData = filteredObjects.map((obj) => {
    const volume = obj.volume || 0;
    // Use real IFC weight if available, otherwise compute from volume × density
    const weight = obj.weight > 0 ? obj.weight : volume * density;

    return {
      ...obj,
      volume,
      weight,
    };
  });

  computeGroupedData();
  return statsData;
}

function computeGroupedData() {
  groupedData = new Map();
  if (currentGroupBy === "none") return;

  statsData.forEach((obj) => {
    const key = getGroupKey(obj, currentGroupBy);
    if (!groupedData.has(key)) {
      groupedData.set(key, { items: [], totalVolume: 0, totalWeight: 0, count: 0 });
    }
    const group = groupedData.get(key);
    group.items.push(obj);
    group.totalVolume += obj.volume;
    group.totalWeight += obj.weight;
    group.count++;
  });
}

function getGroupKey(obj, field) {
  switch (field) {
    case "name": return obj.name || "Không có tên";
    case "assembly": return obj.assembly || "Không có Assembly";
    case "type": return obj.type || obj.class || "Không phân loại";
    case "group": return obj.group || "Không có Group";
    case "material": return obj.material || "Không rõ vật liệu";
    default: return "Khác";
  }
}

// ========================
// Update Summary Cards
// ========================

function updateSummaryCards() {
  const totalVolume = statsData.reduce((sum, obj) => sum + obj.volume, 0);
  const totalWeight = statsData.reduce((sum, obj) => sum + obj.weight, 0);
  const totalCount = statsData.length;

  document.getElementById("totalVolume").textContent = formatNumber(totalVolume, 4);
  document.getElementById("totalWeight").textContent = formatNumber(totalWeight, 1);
  document.getElementById("totalCount").textContent = totalCount.toString();

  // Update labels based on mode
  const weightLabel = document.querySelector("#totalWeight + .stat-label, .stat-label");
  const volumeLabel = document.querySelectorAll(".stat-label");

  animateValue("totalVolume", totalVolume, 4);
  animateValue("totalWeight", totalWeight, 1);
}

function animateValue(elementId, targetValue, decimals) {
  const el = document.getElementById(elementId);
  const duration = 600;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const currentValue = targetValue * eased;
    el.textContent = formatNumber(currentValue, decimals);
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

// ========================
// Render Stats Table
// ========================

function renderStatsTable() {
  const tbody = document.getElementById("statsTableBody");

  if (statsData.length === 0) {
    const modeText = steelOnlyMode ? " thép" : "";
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">Không tìm thấy cấu kiện${modeText} nào${useSelectedOnly ? " trong đối tượng đã chọn" : " trong model"}</td>
      </tr>
    `;
    return;
  }

  if (currentGroupBy !== "none" && groupedData.size > 0) {
    renderGroupedTable(tbody);
  } else {
    renderFlatTable(tbody);
  }
}

function renderFlatTable(tbody) {
  const sorted = [...statsData].sort((a, b) => {
    let valA = a[currentSort.field];
    let valB = b[currentSort.field];
    if (typeof valA === "string") {
      valA = valA.toLowerCase();
      valB = (valB || "").toLowerCase();
      return currentSort.asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return currentSort.asc ? valA - valB : valB - valA;
  });

  tbody.innerHTML = sorted
    .map(
      (obj) => `
    <tr data-id="${obj.id}">
      <td>${escapeHtml(obj.name)}</td>
      <td>${escapeHtml(obj.assembly || "—")}</td>
      <td>${escapeHtml(obj.type || obj.class || "—")}</td>
      <td>${escapeHtml(obj.group || "—")}</td>
      <td class="number-cell">${formatNumber(obj.volume, 4)}</td>
      <td class="number-cell">${formatNumber(obj.weight, 1)}</td>
    </tr>
  `
    )
    .join("");
}

function renderGroupedTable(tbody) {
  let html = "";

  const sortedGroups = [...groupedData.entries()].sort((a, b) => {
    if (currentSort.field === "volume") {
      return currentSort.asc
        ? a[1].totalVolume - b[1].totalVolume
        : b[1].totalVolume - a[1].totalVolume;
    }
    if (currentSort.field === "weight") {
      return currentSort.asc
        ? a[1].totalWeight - b[1].totalWeight
        : b[1].totalWeight - a[1].totalWeight;
    }
    return currentSort.asc ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0]);
  });

  for (const [groupName, group] of sortedGroups) {
    const isExpanded = expandedGroups.has(groupName);
    const chevron = isExpanded ? "▼" : "▶";

    html += `
      <tr class="group-header-row" data-group="${escapeHtml(groupName)}">
        <td colspan="4">
          <span class="group-toggle">${chevron}</span>
          <strong>${escapeHtml(groupName)}</strong>
          <span class="group-count">${group.count} cấu kiện</span>
        </td>
        <td class="number-cell group-total">${formatNumber(group.totalVolume, 4)}</td>
        <td class="number-cell group-total">${formatNumber(group.totalWeight, 1)}</td>
      </tr>
    `;

    if (isExpanded) {
      const sortedItems = [...group.items].sort((a, b) => {
        let valA = a[currentSort.field];
        let valB = b[currentSort.field];
        if (typeof valA === "string") {
          valA = valA.toLowerCase();
          valB = (valB || "").toLowerCase();
          return currentSort.asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return currentSort.asc ? valA - valB : valB - valA;
      });

      for (const obj of sortedItems) {
        html += `
          <tr class="group-child-row" data-id="${obj.id}">
            <td class="indent-cell">${escapeHtml(obj.name)}</td>
            <td>${escapeHtml(obj.assembly || "—")}</td>
            <td>${escapeHtml(obj.type || obj.class || "—")}</td>
            <td>${escapeHtml(obj.group || "—")}</td>
            <td class="number-cell">${formatNumber(obj.volume, 4)}</td>
            <td class="number-cell">${formatNumber(obj.weight, 1)}</td>
          </tr>
        `;
      }
    }
  }

  tbody.innerHTML = html;

  tbody.querySelectorAll(".group-header-row").forEach((row) => {
    row.addEventListener("click", () => {
      const groupName = row.dataset.group;
      if (expandedGroups.has(groupName)) {
        expandedGroups.delete(groupName);
      } else {
        expandedGroups.add(groupName);
      }
      renderStatsTable();
    });
  });
}

function getGroupByLabel(field) {
  const labels = {
    name: "Tên cấu kiện",
    assembly: "Assembly",
    type: "Loại",
    group: "Group",
    material: "Vật liệu",
  };
  return labels[field] || field;
}

// ========================
// Sort
// ========================

function setupSorting() {
  document.querySelectorAll(".stats-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (currentSort.field === field) {
        currentSort.asc = !currentSort.asc;
      } else {
        currentSort.field = field;
        currentSort.asc = true;
      }

      document.querySelectorAll(".sort-icon").forEach((icon) => {
        icon.textContent = "↕";
        icon.style.opacity = "0.4";
      });

      const icon = th.querySelector(".sort-icon");
      if (icon) {
        icon.textContent = currentSort.asc ? "↑" : "↓";
        icon.style.opacity = "1";
      }

      renderStatsTable();
    });
  });
}

// ========================
// Load Stats
// ========================

async function loadStatistics() {
  const overlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");

  overlay.classList.remove("hidden");
  loadingText.textContent = "Đang quét dữ liệu IFC model...";
  await new Promise((r) => setTimeout(r, 500));

  const modeText = steelOnlyMode ? "cấu kiện thép" : "tất cả cấu kiện";
  loadingText.textContent = `Đang phân tích ${modeText}...`;
  await new Promise((r) => setTimeout(r, 300));

  computeStats();

  loadingText.textContent = "Đang tính toán thể tích & khối lượng...";
  await new Promise((r) => setTimeout(r, 200));

  updateSummaryCards();
  renderStatsTable();

  overlay.classList.add("hidden");
  const scopeText = useSelectedOnly ? " (đối tượng đã chọn)" : "";
  const modeLabel = steelOnlyMode ? " thép" : "";
  showToast(`Tìm thấy ${statsData.length} cấu kiện${modeLabel}${scopeText}`, "success");
}

// ========================
// Export Excel
// ========================

function handleExportExcel() {
  if (statsData.length === 0) {
    showToast("Chưa có dữ liệu để xuất. Nhấn 'Tải lại' trước.", "error");
    return;
  }

  const density = parseFloat(document.getElementById("steelDensity").value) || DEFAULT_DENSITY;

  const success = exportToExcel(statsData, {
    density,
    totalVolume: statsData.reduce((s, o) => s + o.volume, 0),
    totalWeight: statsData.reduce((s, o) => s + o.weight, 0),
    projectName: "Trimble Connect Project",
    exportDate: new Date().toLocaleDateString("vi-VN"),
    groupByField: currentGroupBy,
    groupedData: currentGroupBy !== "none" ? groupedData : null,
    steelOnly: steelOnlyMode,
  });

  if (success) {
    showToast("Đã xuất file Excel thành công!", "success");
  }
}

// ========================
// Density, GroupBy, Scope, Mode
// ========================

function setupDensityInput() {
  const input = document.getElementById("steelDensity");
  input.addEventListener("change", () => {
    if (statsData.length > 0) {
      computeStats();
      updateSummaryCards();
      renderStatsTable();
      showToast(`Đã cập nhật khối lượng riêng: ${input.value} kg/m³`);
    }
  });
}

function setupGroupBy() {
  const select = document.getElementById("groupBySelect");
  select.addEventListener("change", () => {
    currentGroupBy = select.value;
    expandedGroups.clear();
    if (statsData.length > 0) {
      computeGroupedData();
      renderStatsTable();
      showToast(
        currentGroupBy === "none"
          ? "Hiển thị không nhóm"
          : `Nhóm theo: ${getGroupByLabel(currentGroupBy)}`
      );
    }
  });
}

function setupScopeToggle() {
  const checkbox = document.getElementById("scopeCheckbox");
  const label = document.getElementById("scopeLabel");

  checkbox.addEventListener("change", () => {
    useSelectedOnly = checkbox.checked;
    label.textContent = useSelectedOnly ? "Đối tượng đã chọn" : "Toàn bộ dự án";

    if (useSelectedOnly) {
      const selectedIds = getSelectedIds();
      if (selectedIds.size === 0) {
        showToast("Chưa chọn đối tượng nào ở tab Tìm kiếm", "error");
        checkbox.checked = false;
        useSelectedOnly = false;
        label.textContent = "Toàn bộ dự án";
        return;
      }
    }

    loadStatistics();
  });
}

function setupModeToggle() {
  const checkbox = document.getElementById("modeCheckbox");
  const label = document.getElementById("modeLabel");

  if (!checkbox || !label) return;

  checkbox.addEventListener("change", () => {
    steelOnlyMode = !checkbox.checked;
    label.textContent = steelOnlyMode ? "Chỉ cấu kiện thép" : "Tất cả cấu kiện";
    loadStatistics();
  });
}

// ========================
// Helpers
// ========================

function formatNumber(value, decimals = 2) {
  return value.toLocaleString("vi-VN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ========================
// Module Init
// ========================

export function initSteelStatistics() {
  setupSorting();
  setupDensityInput();
  setupGroupBy();
  setupScopeToggle();
  setupModeToggle();

  document.getElementById("refreshStatsBtn").addEventListener("click", loadStatistics);
  document.getElementById("exportExcelBtn").addEventListener("click", handleExportExcel);
}
