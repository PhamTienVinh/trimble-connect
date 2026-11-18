/**
 * labelManager.js — 3D Label Manager for Trimble Connect Viewer
 *
 * Hiển thị thẻ label (tag) trực tiếp lên từng cấu kiện trên 3D view.
 * Người dùng có thể chọn trường hiển thị: Tên object, Assembly Name,
 * Assembly Pos, Position Code, Profile, Khối lượng, IFC Class, Vật liệu, v.v.
 *
 * Sử dụng TC Workspace API:
 *   - viewer.getObjectBoundingBoxes() để lấy tọa độ cấu kiện
 *   - viewer.addIcon() để gắn thẻ label trực tiếp lên đỉnh cấu kiện trong không gian 3D
 *   - viewer.removeIcon() để gỡ thẻ label
 *   - viewer.setSelection() để highlight khi bấm vào thẻ trong danh sách
 */

import {
  getAllObjects,
  getSelectedObjects,
  getSelectedIds,
  getFilteredObjects,
} from "./objectExplorer.js";

// ── State ──
let apiRef = null;
let viewerRef = null;
let labelsVisible = false;
let currentLabelField = "name";
let labelScope = "all"; // "all" | "selected" | "visible"
let labelLimit = 500; // 0 = không giới hạn
let labeledObjects = []; // Mảng các object đã được gắn label { obj, text, position, iconId }
let activeIconIds = []; // Danh sách ID các icon đã tạo để quản lý gỡ bỏ

// ── Prefix ──
const LABEL_PREFIX = "ddc_lbl_";

// ── SVG Icon Badges theo loại trường hiển thị ──
function createSvgIcon(symbol, color = "#3B82F6") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000000" flood-opacity="0.4"/>
    </filter>
    <rect rx="5" width="22" height="22" fill="${color}" filter="url(#shadow)" stroke="#ffffff" stroke-width="1.2" opacity="0.95"/>
    <text x="11" y="15" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="bold" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">${symbol}</text>
  </svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

const ICONS_BY_FIELD = {
  name: createSvgIcon("T", "#3B82F6"), // Blue
  assemblyName: createSvgIcon("A", "#8B5CF6"), // Purple
  assemblyPos: createSvgIcon("P", "#F59E0B"), // Amber
  assemblyPosCode: createSvgIcon("#", "#10B981"), // Emerald
  profile: createSvgIcon("L", "#06B6D4"), // Cyan
  referenceName: createSvgIcon("R", "#EC4899"), // Pink
  ifcClass: createSvgIcon("C", "#6366F1"), // Indigo
  material: createSvgIcon("M", "#78716C"), // Stone
  weight: createSvgIcon("W", "#EF4444"), // Red
  volume: createSvgIcon("V", "#14B8A6"), // Teal
  type: createSvgIcon("O", "#F97316"), // Orange
  revitType: createSvgIcon("R", "#0284C7"), // Sky
  revitFamily: createSvgIcon("F", "#4F46E5"), // Violet
  description: createSvgIcon("D", "#64748B"), // Slate
  tag: createSvgIcon("#", "#059669"), // Green
  group: createSvgIcon("G", "#D97706"), // Amber dark
};

// ── Label Field Options ──
export const LABEL_FIELD_OPTIONS = [
  { value: "name", label: "🏷️ Tên Object" },
  { value: "assemblyName", label: "🏗️ Assembly Name" },
  { value: "assemblyPos", label: "📍 Assembly Pos" },
  { value: "assemblyPosCode", label: "🔢 Position Code" },
  { value: "profile", label: "📐 Profile Name" },
  { value: "referenceName", label: "📎 Reference Name" },
  { value: "ifcClass", label: "🧱 IFC Class" },
  { value: "material", label: "🪨 Vật liệu" },
  { value: "weight", label: "⚖️ Khối lượng (kg)" },
  { value: "volume", label: "📦 Thể tích (m³)" },
  { value: "type", label: "📦 Object Type" },
  { value: "revitType", label: "🏢 Revit Type" },
  { value: "revitFamily", label: "🏠 Revit Family" },
  { value: "description", label: "📝 Mô tả" },
  { value: "tag", label: "🔖 Tag" },
  { value: "group", label: "📁 Group" },
];

// ── Public Getters ──
export function getLabelFieldOptions() {
  return LABEL_FIELD_OPTIONS;
}

export function isLabelsVisible() {
  return labelsVisible;
}

export function getCurrentLabelField() {
  return currentLabelField;
}

export function getLabelScope() {
  return labelScope;
}

export function getLabeledObjects() {
  return labeledObjects;
}

/**
 * Khởi tạo Label Manager
 */
export function initLabelManager(api, viewer) {
  apiRef = api;
  viewerRef = viewer;

  // Lắng nghe khi objects được quét xong từ IFC model
  window.addEventListener("objects-scanned", () => {
    if (labelsVisible) {
      console.log("[LabelManager] Objects re-scanned, refreshing 3D labels...");
      applyLabels();
    }
  });

  // Lắng nghe khi selection trên 3D hoặc panel thay đổi
  window.addEventListener("selection-changed", () => {
    if (labelsVisible && labelScope === "selected") {
      applyLabels();
    }
  });

  // Gắn sự kiện cho các nút điều khiển trên UI
  bindUIControls();

  console.log("[LabelManager] Module initialized successfully");
}

/**
 * Hiển thị thẻ label cho danh sách objects
 * @param {Array} objects - Danh sách đối tượng
 * @param {string} field - Tên trường thuộc tính (e.g. "name", "assemblyPos", "weight")
 */
export async function showLabelsForObjects(objects, field) {
  if (!viewerRef) {
    console.warn("[LabelManager] Viewer reference not ready");
    return;
  }

  if (!objects || objects.length === 0) {
    console.warn("[LabelManager] Không có objects nào được chọn để gắn label");
    await clearLabels();
    updateUIState(0, "Không có cấu kiện nào phù hợp");
    return;
  }

  currentLabelField = field || currentLabelField;

  // Xóa labels cũ trước khi vẽ lại
  await clearLabelsSilent();

  // Giới hạn số lượng cấu kiện để tránh làm lag 3D viewer
  let targetObjects = objects;
  if (labelLimit > 0 && targetObjects.length > labelLimit) {
    targetObjects = targetObjects.slice(0, labelLimit);
    console.log(`[LabelManager] Giới hạn hiển thị ${labelLimit}/${objects.length} cấu kiện`);
  }

  // Nhóm objects theo modelId để query Bounding Box
  const byModel = new Map();
  for (const obj of targetObjects) {
    if (!obj || obj.id === undefined) continue;
    const modelId = obj.modelId;
    if (!byModel.has(modelId)) byModel.set(modelId, []);
    byModel.get(modelId).push(obj);
  }

  const allIcons = [];
  const successfulLabeled = [];
  const iconAsset = ICONS_BY_FIELD[currentLabelField] || createSvgIcon("🏷️");

  // Query bounding boxes theo batch
  for (const [modelId, modelObjects] of byModel) {
    const objectIds = modelObjects.map((o) => o.id);

    try {
      // TC API: getObjectBoundingBoxes(modelId, objectIds)
      const bboxes = await viewerRef.getObjectBoundingBoxes(modelId, objectIds);

      if (!bboxes || bboxes.length === 0) {
        console.warn(`[LabelManager] Không lấy được bounding boxes cho model ${modelId}`);
        continue;
      }

      for (let i = 0; i < modelObjects.length; i++) {
        const obj = modelObjects[i];
        const bbox = bboxes[i];

        if (!bbox || !bbox.min || !bbox.max) continue;

        // Tính tọa độ label: Đặt ở đỉnh trên cùng (top-center) của cấu kiện
        const centerX = (bbox.min.x + bbox.max.x) / 2;
        const centerY = (bbox.min.y + bbox.max.y) / 2;
        const topZ = bbox.max.z + 0.08; // Nhô lên 8cm trên bề mặt cấu kiện

        // Lấy giá trị chuỗi hiển thị
        const labelText = formatLabelValue(obj, currentLabelField);
        if (!labelText) continue; // Bỏ qua nếu giá trị rỗng

        const iconId = `${LABEL_PREFIX}${modelId}_${obj.id}`;

        const pointIcon = {
          id: iconId,
          position: { x: centerX, y: centerY, z: topZ },
          icon: iconAsset,
          label: labelText,
          text: buildTooltipText(obj), // Tooltip khi hover trên 3D view
        };

        allIcons.push(pointIcon);
        activeIconIds.push(iconId);

        successfulLabeled.push({
          obj,
          text: labelText,
          position: pointIcon.position,
          iconId,
        });
      }
    } catch (err) {
      console.error(`[LabelManager] Lỗi khi xử lý model ${modelId}:`, err);
    }
  }

  // Thêm icons vào 3D viewer bằng batching (tối đa 100 icons/lần gọi để ổn định)
  if (allIcons.length > 0) {
    const CHUNK_SIZE = 100;
    let addedCount = 0;

    for (let c = 0; c < allIcons.length; c += CHUNK_SIZE) {
      const chunk = allIcons.slice(c, c + CHUNK_SIZE);
      try {
        await viewerRef.addIcon(chunk);
        addedCount += chunk.length;
      } catch (chunkErr) {
        console.warn(`[LabelManager] Batch addIcon (${c} - ${c + chunk.length}) thất bại, thử add từng cái:`, chunkErr);
        for (const icon of chunk) {
          try {
            await viewerRef.addIcon(icon);
            addedCount++;
          } catch (singleErr) {
            // bỏ qua icon lỗi đơn lẻ
          }
        }
      }
    }

    labelsVisible = addedCount > 0;
    labeledObjects = successfulLabeled;
    console.log(`[LabelManager] ✓ Đã hiển thị ${addedCount} labels 3D thành công (Field: ${currentLabelField})`);
  } else {
    labelsVisible = false;
    labeledObjects = [];
  }

  updateUIState(labeledObjects.length);
  renderPreviewList();
}

/**
 * Xóa toàn bộ thẻ label 3D
 */
export async function clearLabels() {
  await clearLabelsSilent();
  updateUIState(0);
  renderPreviewList();
  console.log("[LabelManager] Đã xóa toàn bộ labels");
}

/**
 * Xóa labels nội bộ không cập nhật lại UI
 */
async function clearLabelsSilent() {
  if (!viewerRef) return;

  try {
    if (activeIconIds.length > 0) {
      for (const iconId of activeIconIds) {
        try {
          await viewerRef.removeIcon({ id: iconId });
        } catch (e) {
          // Bỏ qua lỗi từng icon
        }
      }
    }
  } catch (e) {
    console.warn("[LabelManager] Lỗi removeIcon theo ID, thử remove toàn bộ:", e);
    try {
      await viewerRef.removeIcon();
    } catch (e2) {
      // bỏ qua
    }
  }

  activeIconIds = [];
  labelsVisible = false;
  labeledObjects = [];
}

/**
 * Bật / tắt hiển thị labels
 */
export async function toggleLabels() {
  if (labelsVisible) {
    await clearLabels();
  } else {
    await applyLabels();
  }
}

/**
 * Áp dụng cấu hình và hiển thị labels
 */
export async function applyLabels() {
  let objects = [];

  if (labelScope === "selected") {
    objects = getSelectedObjects();
    if (!objects || objects.length === 0) {
      console.log("[LabelManager] Chưa chọn cấu kiện nào, chuyển sang toàn bộ");
      objects = getAllObjects();
    }
  } else if (labelScope === "visible") {
    objects = getFilteredObjects();
    if (!objects || objects.length === 0) {
      objects = getAllObjects();
    }
  } else {
    // "all"
    objects = getAllObjects();
  }

  await showLabelsForObjects(objects, currentLabelField);
}

/**
 * Định dạng giá trị hiển thị trên thẻ label
 */
function formatLabelValue(obj, field) {
  if (!obj) return null;

  switch (field) {
    case "weight": {
      const w = obj.weight || obj.netWeight || obj.grossWeight || 0;
      if (w <= 0) return null;
      if (w >= 1000) return `${(w / 1000).toFixed(2)} t`;
      return `${w.toFixed(1)} kg`;
    }
    case "volume": {
      const v = obj.volume || obj.netVolume || obj.grossVolume || 0;
      if (v <= 0) return null;
      return `${v.toFixed(3)} m³`;
    }
    case "area": {
      const a = obj.area || obj.grossArea || obj.netArea || 0;
      if (a <= 0) return null;
      return `${a.toFixed(2)} m²`;
    }
    case "length": {
      const l = obj.length || 0;
      if (l <= 0) return null;
      return `${Math.round(l * 1000)} mm`;
    }
    case "assemblyName": {
      const val = obj.assemblyName || obj.assembly;
      if (!val || val === "(Không xác định)") return null;
      return String(val);
    }
    case "assemblyPos": {
      const val = obj.assemblyPos;
      if (!val || val === "(Không xác định)") return null;
      return String(val);
    }
    case "assemblyPosCode": {
      const val = obj.assemblyPosCode;
      if (!val || val === "(Không xác định)") return null;
      return String(val);
    }
    default: {
      const val = obj[field];
      if (!val || val === "" || val === "(Không xác định)") return null;
      return String(val);
    }
  }
}

/**
 * Tạo tooltip mô tả chi tiết khi hover vào thẻ label
 */
function buildTooltipText(obj) {
  const parts = [];
  if (obj.name) parts.push(`Tên: ${obj.name}`);
  if (obj.assemblyName) parts.push(`Assembly: ${obj.assemblyName}`);
  if (obj.assemblyPos) parts.push(`Pos: ${obj.assemblyPos}`);
  if (obj.profile) parts.push(`Profile: ${obj.profile}`);
  if (obj.ifcClass) parts.push(`IFC: ${obj.ifcClass}`);
  if (obj.material) parts.push(`Vật liệu: ${obj.material}`);

  const w = obj.weight || obj.netWeight || 0;
  if (w > 0) {
    parts.push(`KL: ${w >= 1000 ? (w / 1000).toFixed(2) + " t" : w.toFixed(1) + " kg"}`);
  }

  return parts.join(" | ");
}

/**
 * Gắn sự kiện UI
 */
function bindUIControls() {
  // Nút Hiện Labels
  const showBtn = document.getElementById("btn-show-labels");
  if (showBtn) {
    showBtn.addEventListener("click", () => applyLabels());
  }

  // Nút Xóa Labels
  const clearBtn = document.getElementById("btn-clear-labels");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => clearLabels());
  }

  // Nút Ẩn/Hiện Labels
  const toggleBtn = document.getElementById("btn-toggle-labels");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => toggleLabels());
  }

  // Nút Refresh
  const refreshBtn = document.getElementById("btn-refresh-labels");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => applyLabels());
  }

  // Dropdown chọn loại thuộc tính hiển thị
  const fieldSelect = document.getElementById("label-field-select");
  if (fieldSelect) {
    fieldSelect.addEventListener("change", (e) => {
      currentLabelField = e.target.value;
      if (labelsVisible) {
        applyLabels();
      }
    });
  }

  // Dropdown chọn phạm vi áp dụng (tất cả, đã chọn, filtered)
  const scopeSelect = document.getElementById("label-scope-select");
  if (scopeSelect) {
    scopeSelect.addEventListener("change", (e) => {
      labelScope = e.target.value;
      if (labelsVisible) {
        applyLabels();
      }
    });
  }

  // Dropdown giới hạn số lượng labels
  const limitSelect = document.getElementById("label-limit-select");
  if (limitSelect) {
    limitSelect.addEventListener("change", (e) => {
      labelLimit = parseInt(e.target.value, 10) || 0;
      if (labelsVisible) {
        applyLabels();
      }
    });
  }
}

/**
 * Cập nhật thanh trạng thái giao diện
 */
function updateUIState(count = 0, customMessage = null) {
  const statusIcon = document.getElementById("label-status-icon");
  const statusText = document.getElementById("label-status-text");
  const statsRow = document.getElementById("label-stats-row");
  const countDisplay = document.getElementById("label-count-display");
  const fieldDisplay = document.getElementById("label-field-display");
  const toggleBtn = document.getElementById("btn-toggle-labels");
  const guideEl = document.getElementById("label-guide");
  const previewContainer = document.getElementById("label-preview-container");

  const fieldOption = LABEL_FIELD_OPTIONS.find((o) => o.value === currentLabelField);
  const fieldTitle = fieldOption ? fieldOption.label : currentLabelField;

  if (labelsVisible && count > 0) {
    if (statusIcon) statusIcon.textContent = "🟢";
    if (statusText) statusText.textContent = `Đang hiển thị trên 3D: ${fieldTitle}`;
    if (statsRow) statsRow.style.display = "flex";
    if (countDisplay) countDisplay.textContent = `${count} labels`;
    if (fieldDisplay) fieldDisplay.textContent = fieldTitle;

    if (toggleBtn) {
      toggleBtn.classList.add("active");
      toggleBtn.innerHTML = "<span>👁️</span> Ẩn Labels";
    }

    if (guideEl) guideEl.style.display = "none";
    if (previewContainer) previewContainer.style.display = "flex";
  } else {
    if (statusIcon) statusIcon.textContent = "⭕";
    if (statusText) statusText.textContent = customMessage || "Chưa hiển thị labels";
    if (statsRow) statsRow.style.display = "none";

    if (toggleBtn) {
      toggleBtn.classList.remove("active");
      toggleBtn.innerHTML = "<span>👁️</span> Hiện Labels";
    }

    if (guideEl) guideEl.style.display = "block";
    if (previewContainer) previewContainer.style.display = "none";
  }
}

/**
 * Hiển thị danh sách checklist các thẻ label đang hiển thị kèm click để select/focus trong 3D
 */
function renderPreviewList() {
  const container = document.getElementById("label-preview-list");
  const countBadge = document.getElementById("label-preview-count");
  if (!container) return;

  if (countBadge) {
    countBadge.textContent = `${labeledObjects.length}`;
  }

  if (labeledObjects.length === 0) {
    container.innerHTML = '<div class="label-preview-empty">Không có thẻ nào đang hiển thị</div>';
    return;
  }

  // Render danh sách checklist thẻ
  let html = "";
  labeledObjects.slice(0, 150).forEach((item, idx) => {
    const obj = item.obj;
    const name = obj.name || `Object #${obj.id}`;
    const val = item.text;
    const modelId = obj.modelId;
    const id = obj.id;

    html += `
      <div class="label-preview-item" data-model-id="${modelId}" data-object-id="${id}" title="Nhấp để chọn cấu kiện này trong 3D View">
        <span class="label-preview-num">${idx + 1}</span>
        <div class="label-preview-info">
          <div class="label-preview-title">${escapeHtml(name)}</div>
          <div class="label-preview-sub">ID: ${id} | ${escapeHtml(obj.ifcClass || "IFC")}</div>
        </div>
        <span class="label-preview-tag">${escapeHtml(val)}</span>
      </div>
    `;
  });

  if (labeledObjects.length > 150) {
    html += `<div class="label-preview-more">...và ${labeledObjects.length - 150} cấu kiện khác</div>`;
  }

  container.innerHTML = html;

  // Gắn sự kiện click vào từng item để highlight / select đối tượng trong 3D
  container.querySelectorAll(".label-preview-item").forEach((el) => {
    el.addEventListener("click", async () => {
      const modelId = el.getAttribute("data-model-id");
      const objectId = parseInt(el.getAttribute("data-object-id"), 10);

      if (viewerRef && modelId && !isNaN(objectId)) {
        try {
          await viewerRef.setSelection(
            {
              modelObjectIds: [
                {
                  modelId,
                  objectRuntimeIds: [objectId],
                },
              ],
            },
            "set"
          );
        } catch (e) {
          console.warn("[LabelManager] Set selection failed:", e);
        }
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
