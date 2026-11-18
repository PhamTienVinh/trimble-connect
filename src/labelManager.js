/**
 * labelManager.js — 3D Label Manager for Trimble Connect Viewer
 *
 * Hiển thị thẻ label (tag) trực tiếp lên từng cấu kiện trên 3D view.
 * Người dùng có thể:
 *   - Chọn trường hiển thị: Tên object, Assembly Name, Assembly Pos,
 *     Position Code, Profile, Khối lượng, IFC Class, Vật liệu, v.v.
 *   - Tùy biến toàn diện: Màu nền, màu chữ, viền, cỡ chữ, độ to nhỏ (scale),
 *     bo góc, độ cao nhãn (Z-offset), bóng đổ 3D, icon ký hiệu.
 *   - Tự động nhận diện đơn vị tọa độ (Milimét vs Mét) để đặt nhãn chính xác.
 *   - Nhấp vào thẻ trong danh sách để chọn & tự động zoom camera vào cấu kiện trong 3D.
 */

import {
  getAllObjects,
  getSelectedObjects,
  getSelectedIds,
  getFilteredObjects,
  scanObjects,
} from "./objectExplorer.js";

// ── State ──
let apiRef = null;
let viewerRef = null;
let labelsVisible = false;
let currentLabelField = "name";
let labelScope = "all"; // "all" | "selected" | "visible"
let labelLimit = 500; // 0 = không giới hạn
let labeledObjects = []; // { obj, text, position, iconId, isFallback }
let activeIconCount = 0;

// ── Cấu hình tùy biến nhãn (Mặc định) ──
const DEFAULT_LABEL_CONFIG = {
  bgColor: "#2563EB", // Màu nền
  textColor: "#FFFFFF", // Màu chữ
  borderColor: "#FFFFFF", // Màu viền
  borderWidth: 1.5, // Độ dày viền (px)
  borderRadius: 8, // Bo góc (px)
  fontSize: 13, // Cỡ chữ (px)
  scale: 1.0, // Độ to nhỏ (tỉ lệ)
  opacity: 0.95, // Độ mờ nền
  zOffset: 0.15, // Độ cao nhô lên khỏi đỉnh cấu kiện (m)
  unitScale: "auto", // "auto" | "mm" | "m"
  badgeMode: "canvasBadge", // "canvasBadge" | "pinMarker" | "both"
  hasShadow: true, // Bóng đổ 3D
  showIcon: true, // Hiện biểu tượng icon
  fallbackToName: true, // Tự động dùng Tên nếu trường trống
  zoomOnClick: true, // Zoom camera khi nhấp thẻ trong danh sách
};

// Cấu hình hiện hành
let labelConfig = { ...DEFAULT_LABEL_CONFIG };

// ── Biểu tượng Icon đại diện cho từng loại trường ──
const FIELD_ICONS = {
  name: "🏷️",
  assemblyName: "🏗️",
  assemblyPos: "📍",
  assemblyPosCode: "🔢",
  profile: "📐",
  referenceName: "📎",
  ifcClass: "🧱",
  material: "🪨",
  weight: "⚖️",
  volume: "📦",
  type: "📦",
  revitType: "🏢",
  revitFamily: "🏠",
  description: "📝",
  tag: "🔖",
  group: "📁",
};

// ── Danh sách các trường hiển thị ──
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

/**
 * Trích xuất Bounding Box từ đối tượng trả về của TC Workspace API
 * Hỗ trợ mọi định dạng: item.boundingBox, item.box, item.min, array [minX..maxZ]
 */
function extractBoundingBox(item) {
  if (!item) return null;

  const box = item.boundingBox || item.box || item;
  if (box && box.min && box.max) {
    const minX = Number(box.min.x !== undefined ? box.min.x : box.min[0]);
    const minY = Number(box.min.y !== undefined ? box.min.y : box.min[1]);
    const minZ = Number(box.min.z !== undefined ? box.min.z : box.min[2]);
    const maxX = Number(box.max.x !== undefined ? box.max.x : box.max[0]);
    const maxY = Number(box.max.y !== undefined ? box.max.y : box.max[1]);
    const maxZ = Number(box.max.z !== undefined ? box.max.z : box.max[2]);

    if (!isNaN(minX) && !isNaN(maxX) && !isNaN(minZ) && !isNaN(maxZ)) {
      return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
      };
    }
  }

  if (Array.isArray(item) && item.length >= 6) {
    return {
      min: { x: Number(item[0]), y: Number(item[1]), z: Number(item[2]) },
      max: { x: Number(item[3]), y: Number(item[4]), z: Number(item[5]) },
    };
  }

  if (item.minX !== undefined && item.maxX !== undefined) {
    return {
      min: { x: Number(item.minX), y: Number(item.minY), z: Number(item.minZ) },
      max: { x: Number(item.maxX), y: Number(item.maxY), z: Number(item.maxZ) },
    };
  }

  return null;
}

/**
 * Tự động phát hiện tỉ lệ chuyển đổi đơn vị tọa độ (mm -> m)
 * Trong Trimble Connect 3D Viewer, PointIcon.position bắt buộc tính bằng Mét (meters).
 * Nếu mô hình xuất ra theo milimét (e.g. Tekla mm), tọa độ cần chia 1000.
 */
function determineUnitScaleFactor(bboxes) {
  if (labelConfig.unitScale === "mm") return 0.001;
  if (labelConfig.unitScale === "m") return 1.0;

  if (!bboxes || bboxes.length === 0) return 1.0;

  // Chế độ "auto": Phân tích kích thước trung bình và cực đại của cấu kiện
  let totalSpan = 0;
  let count = 0;
  let maxSpan = 0;

  for (const b of bboxes) {
    if (!b) continue;
    const spanX = Math.abs(b.max.x - b.min.x);
    const spanY = Math.abs(b.max.y - b.min.y);
    const spanZ = Math.abs(b.max.z - b.min.z);
    const span = Math.max(spanX, spanY, spanZ);
    if (span > 0) {
      totalSpan += span;
      count++;
      if (span > maxSpan) maxSpan = span;
    }
  }

  const avgSpan = count > 0 ? totalSpan / count : 0;

  // Nếu kích thước trung bình của các cấu kiện > 25 (hoặc max > 100),
  // chắc chắn 100% mô hình xuất ra đơn vị Milimét (mm). Cần quy đổi mm -> mét (chia 1000).
  if (avgSpan > 25 || maxSpan > 100) {
    console.log(`[LabelManager] Tự động phát hiện đơn vị MILIMÉT (avgSpan=${avgSpan.toFixed(1)}, maxSpan=${maxSpan.toFixed(1)}). Tỉ lệ: chia 1000.`);
    return 0.001;
  }

  console.log(`[LabelManager] Tự động phát hiện đơn vị MÉT (avgSpan=${avgSpan.toFixed(2)}, maxSpan=${maxSpan.toFixed(2)}). Tỉ lệ: 1:1.`);
  return 1.0;
}

/**
 * Chuyển đổi mã màu Hex sang RGBA
 */
function hexToRgba(hex, alpha = 1.0) {
  let cleanHex = hex.replace("#", "");
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split("").map((c) => c + c).join("");
  }
  const num = parseInt(cleanHex, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Tạo icon Ghim 3D dạng Pin Marker sắc nét (Retina 2x PNG)
 */
function createPinMarkerCanvas(color = "#2563EB", textSymbol = "📍") {
  const pixelRatio = 2;
  const w = 48 * pixelRatio;
  const h = 64 * pixelRatio;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  const cx = w / 2;
  const headR = 19 * pixelRatio;
  const cy = 23 * pixelRatio;
  const tipX = cx;
  const tipY = h - 5 * pixelRatio;

  // Drop shadow
  if (labelConfig.hasShadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 5 * pixelRatio;
    ctx.shadowOffsetY = 3 * pixelRatio;
  }

  // Pin outer path
  ctx.beginPath();
  ctx.arc(cx, cy, headR, Math.PI * 0.85, Math.PI * 0.15, false);
  ctx.lineTo(tipX, tipY);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  if (labelConfig.hasShadow) {
    ctx.restore();
  }

  // White border
  ctx.lineWidth = 2.5 * pixelRatio;
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();

  // Inner white circle
  ctx.beginPath();
  ctx.arc(cx, cy, 13 * pixelRatio, 0, Math.PI * 2);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();

  // Symbol inside
  ctx.font = `${Math.round(13 * pixelRatio)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(textSymbol, cx, cy);

  return {
    url: canvas.toDataURL("image/png"),
    width: w,
    height: h,
  };
}

/**
 * Vẽ thẻ nhãn tùy biến lên HTML5 Canvas sắc nét (Retina 2x)
 * Trả về Data URI PNG Base64 để nhúng làm 3D Sprite trong Trimble Connect Viewer
 */
function createLabelBadgeCanvas(text, iconSymbol = "🏷️") {
  const pixelRatio = 2; // Vẽ 2x để nhãn trên 3D không bị mờ
  const effectiveFontSize = Math.round(labelConfig.fontSize * labelConfig.scale * pixelRatio);

  const fontFace = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';

  // Rút gọn text nếu quá dài để tránh nhãn kéo dài vô tận trên 3D view
  const displayStr = text.length > 32 ? text.slice(0, 30) + "…" : text;

  // Dùng canvas tạm để đo chiều rộng text
  const tempCanvas = document.createElement("canvas");
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.font = `bold ${effectiveFontSize}px ${fontFace}`;

  const textMetrics = tempCtx.measureText(displayStr);
  const textWidth = Math.ceil(textMetrics.width);

  const showIcon = labelConfig.showIcon && Boolean(iconSymbol);
  const iconWidth = showIcon ? Math.round(effectiveFontSize * 1.05) : 0;
  const iconSpacing = showIcon ? Math.round(effectiveFontSize * 0.35) : 0;

  const horizPadding = Math.round(10 * labelConfig.scale * pixelRatio);
  const vertPadding = Math.round(6 * labelConfig.scale * pixelRatio);

  const badgeWidth = textWidth + iconWidth + iconSpacing + horizPadding * 2;
  const badgeHeight = effectiveFontSize + vertPadding * 2;

  const shadowMargin = labelConfig.hasShadow ? Math.round(5 * pixelRatio) : 2;
  const canvasWidth = badgeWidth + shadowMargin * 2;
  const canvasHeight = badgeHeight + shadowMargin * 2;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const x = shadowMargin;
  const y = shadowMargin;
  const r = Math.min(
    Math.round(labelConfig.borderRadius * labelConfig.scale * pixelRatio),
    badgeHeight / 2
  );

  // Đổ bóng 3D
  if (labelConfig.hasShadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = Math.round(5 * pixelRatio);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.round(2.5 * pixelRatio);
  }

  // Vẽ hình chữ nhật bo góc làm nền
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + badgeWidth - r, y);
  ctx.quadraticCurveTo(x + badgeWidth, y, x + badgeWidth, y + r);
  ctx.lineTo(x + badgeWidth, y + badgeHeight - r);
  ctx.quadraticCurveTo(x + badgeWidth, y + badgeHeight, x + badgeWidth - r, y + badgeHeight);
  ctx.lineTo(x + r, y + badgeHeight);
  ctx.quadraticCurveTo(x, y + badgeHeight, x, y + badgeHeight - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();

  ctx.fillStyle = hexToRgba(labelConfig.bgColor, labelConfig.opacity);
  ctx.fill();

  if (labelConfig.hasShadow) {
    ctx.restore();
  }

  // Vẽ đường viền
  if (labelConfig.borderWidth > 0) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + badgeWidth - r, y);
    ctx.quadraticCurveTo(x + badgeWidth, y, x + badgeWidth, y + r);
    ctx.lineTo(x + badgeWidth, y + badgeHeight - r);
    ctx.quadraticCurveTo(x + badgeWidth, y + badgeHeight, x + badgeWidth - r, y + badgeHeight);
    ctx.lineTo(x + r, y + badgeHeight);
    ctx.quadraticCurveTo(x, y + badgeHeight, x, y + badgeHeight - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();

    ctx.strokeStyle = labelConfig.borderColor;
    ctx.lineWidth = labelConfig.borderWidth * labelConfig.scale * pixelRatio;
    ctx.stroke();
  }

  // Tọa độ vẽ text & icon
  let drawX = x + horizPadding;
  const baselineY = y + vertPadding + Math.round(effectiveFontSize * 0.82);

  // Vẽ Icon
  if (showIcon) {
    ctx.font = `${Math.round(effectiveFontSize * 0.95)}px ${fontFace}`;
    ctx.fillText(iconSymbol, drawX, baselineY);
    drawX += iconWidth + iconSpacing;
  }

  // Vẽ Nội dung Text
  ctx.font = `bold ${effectiveFontSize}px ${fontFace}`;
  ctx.fillStyle = labelConfig.textColor;
  ctx.fillText(displayStr, drawX, baselineY);

  return {
    url: canvas.toDataURL("image/png"),
    width: canvasWidth,
    height: canvasHeight,
  };
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

  // Lắng nghe tương tác click trực tiếp vào icon trên 3D Viewer
  if (viewerRef && typeof viewerRef.on === "function") {
    try {
      viewerRef.on("viewer.onIconPicked", (data) => {
        console.log("[LabelManager] 3D Icon picked:", data);
        if (data && Array.isArray(data) && data.length > 0) {
          const picked = data[0];
          const pickedId = picked.id !== undefined ? picked.id : picked;
          const found = labeledObjects.find((item) => item.iconId === pickedId);
          if (found && found.obj && viewerRef) {
            viewerRef.setSelection(
              {
                modelObjectIds: [
                  {
                    modelId: found.obj.modelId,
                    objectRuntimeIds: [found.obj.id],
                  },
                ],
              },
              "set"
            );
          }
        }
      });
    } catch (e) {
      // Bỏ qua nếu onIconPicked không hỗ trợ trên phiên bản hiện hành
    }
  }

  // Gắn sự kiện cho các điều khiển UI & bảng tùy biến
  bindUIControls();
  bindCustomizationControls();
  updateLivePreview();

  console.log("[LabelManager] Module initialized successfully");
}

/**
 * Hiển thị thẻ label cho danh sách objects
 */
export async function showLabelsForObjects(objects, field) {
  if (!viewerRef) {
    console.warn("[LabelManager] Viewer reference not ready");
    return;
  }

  // Kiểm tra nếu chưa có objects nào, tự động quét trước
  let targetObjects = objects;
  if (!targetObjects || targetObjects.length === 0) {
    updateUIState(0, "Đang quét cấu kiện từ model 3D...");
    try {
      await scanObjects();
      targetObjects = getAllObjects();
    } catch (e) {
      console.warn("[LabelManager] Quét cấu kiện thất bại:", e);
    }
  }

  if (!targetObjects || targetObjects.length === 0) {
    console.warn("[LabelManager] Không tìm thấy cấu kiện nào trong model");
    await clearLabels();
    updateUIState(0, "Không tìm thấy cấu kiện nào");
    return;
  }

  currentLabelField = field || currentLabelField;

  // Cập nhật trạng thái đang xử lý
  updateUIState(0, "Đang định vị tọa độ cấu kiện...");

  // Xóa labels cũ trước khi vẽ lại
  await clearLabelsSilent();

  // Giới hạn số lượng cấu kiện để tránh làm lag 3D viewer
  if (labelLimit > 0 && targetObjects.length > labelLimit) {
    targetObjects = targetObjects.slice(0, labelLimit);
    console.log(`[LabelManager] Giới hạn hiển thị ${labelLimit} cấu kiện`);
  }

  // Nhóm objects theo modelId
  const byModel = new Map();
  for (const obj of targetObjects) {
    if (!obj || obj.id === undefined) continue;
    const modelId = obj.modelId;
    if (!byModel.has(modelId)) byModel.set(modelId, []);
    byModel.get(modelId).push(obj);
  }

  const allIcons = [];
  const successfulLabeled = [];
  const iconSymbol = FIELD_ICONS[currentLabelField] || "🏷️";
  const canvasCache = new Map();

  let globalIconIdCounter = 1;

  for (const [modelId, modelObjects] of byModel) {
    const objectIds = modelObjects.map((o) => o.id);
    const bboxMap = new Map();
    const collectedBoxes = [];

    // Query bounding boxes theo từng mẩu nhỏ (BATCH 50)
    const CHUNK_QUERY_SIZE = 50;
    for (let i = 0; i < objectIds.length; i += CHUNK_QUERY_SIZE) {
      const batchIds = objectIds.slice(i, i + CHUNK_QUERY_SIZE);
      try {
        const bboxes = await viewerRef.getObjectBoundingBoxes(modelId, batchIds);
        if (bboxes && Array.isArray(bboxes)) {
          for (let k = 0; k < bboxes.length; k++) {
            const rawBox = bboxes[k];
            const parsed = extractBoundingBox(rawBox);
            if (parsed) {
              collectedBoxes.push(parsed);
              if (rawBox && rawBox.id !== undefined && rawBox.id !== null) {
                bboxMap.set(rawBox.id, parsed);
              }
              if (k < batchIds.length) {
                bboxMap.set(batchIds[k], parsed);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[LabelManager] Batch getObjectBoundingBoxes [${i}..] lỗi:`, err);
      }
    }

    // Tự động tính toán hệ số quy đổi đơn vị (mm -> mét)
    const unitScale = determineUnitScaleFactor(collectedBoxes);

    // Kích thước hiển thị icon sprite trên 3D (PointIcon.size)
    const iconSize = Math.max(24, Math.round(54 * Number(labelConfig.scale || 1.0)));

    // Tiến hành gắn nhãn cho từng object
    for (let i = 0; i < modelObjects.length; i++) {
      const obj = modelObjects[i];
      const bbox = bboxMap.get(obj.id);

      if (!bbox) continue; // Không tìm thấy tọa độ

      // Tọa độ đã quy đổi sang mét
      const centerX = ((bbox.min.x + bbox.max.x) / 2) * unitScale;
      const centerY = ((bbox.min.y + bbox.max.y) / 2) * unitScale;
      const topZ = (bbox.max.z * unitScale) + Number(labelConfig.zOffset || 0.15);

      // Lấy giá trị chuỗi hiển thị
      const { text: labelText, isFallback } = getFormattedLabelText(obj, currentLabelField);
      if (!labelText) continue;

      // Sinh URL icon theo chế độ hiển thị
      let iconPathUrl;
      let badgeW = 64;
      let badgeH = 64;
      if (labelConfig.badgeMode === "pinMarker") {
        const pinRes = createPinMarkerCanvas(labelConfig.bgColor, iconSymbol);
        iconPathUrl = pinRes.url;
        badgeW = pinRes.width;
        badgeH = pinRes.height;
      } else {
        // "canvasBadge" hoặc "both"
        let cached = canvasCache.get(labelText);
        if (!cached) {
          cached = createLabelBadgeCanvas(labelText, iconSymbol);
          canvasCache.set(labelText, cached);
        }
        iconPathUrl = cached.url;
        badgeW = cached.width;
        badgeH = cached.height;
      }

      // PointIcon ID BẮT BUỘC là NUMBER trong Trimble Connect API
      const numericId = globalIconIdCounter++;

      const pointIcon = {
        id: numericId, // Phải là Number!
        iconPath: iconPathUrl, // Thuộc tính chuẩn của PointIcon!
        size: iconSize, // Kích thước icon (Number)
        width: Math.round(badgeW / 2),
        height: Math.round(badgeH / 2),
        position: { x: centerX, y: centerY, z: topZ }, // Tọa độ (m)
        // Các thuộc tính phụ trợ tương thích chéo:
        icon: iconPathUrl,
        image: iconPathUrl,
        label: labelText,
        text: buildTooltipText(obj),
      };

      allIcons.push(pointIcon);

      successfulLabeled.push({
        obj,
        text: labelText,
        position: pointIcon.position,
        iconId: numericId,
        isFallback,
      });
    }
  }

  // Thêm icons vào 3D viewer bằng batching (tối đa 50 icons/lần gọi)
  if (allIcons.length > 0) {
    const ADD_CHUNK_SIZE = 50;
    let addedCount = 0;

    for (let c = 0; c < allIcons.length; c += ADD_CHUNK_SIZE) {
      const chunk = allIcons.slice(c, c + ADD_CHUNK_SIZE);
      try {
        await viewerRef.addIcon(chunk);
        addedCount += chunk.length;
      } catch (chunkErr) {
        console.warn(`[LabelManager] Batch addIcon (${c} - ${c + chunk.length}) lỗi, thử add từng icon:`, chunkErr);
        for (const icon of chunk) {
          try {
            await viewerRef.addIcon(icon);
            addedCount++;
          } catch (singleErr) {
            // bỏ qua
          }
        }
      }
    }

    labelsVisible = addedCount > 0;
    labeledObjects = successfulLabeled;
    activeIconCount = addedCount;

    // Xác thực số lượng icons thực tế trên 3D viewer
    try {
      const activeInViewer = await viewerRef.getIcon();
      console.log(`[LabelManager] ✓ Viewer getIcon() xác nhận ${activeInViewer ? activeInViewer.length : 0} icons đang hoạt động.`);
    } catch (e) {
      // bỏ qua
    }

    console.log(`[LabelManager] ✓ Đã gắn ${addedCount} thẻ label 3D (Field: ${currentLabelField})`);
    updateUIState(labeledObjects.length);
  } else {
    labelsVisible = false;
    labeledObjects = [];
    activeIconCount = 0;
    const fieldOpt = LABEL_FIELD_OPTIONS.find((o) => o.value === currentLabelField);
    const fieldName = fieldOpt ? fieldOpt.label : currentLabelField;
    updateUIState(
      0,
      `Không có dữ liệu "${fieldName}". Bật tùy chọn "Dùng Tên nếu trống" hoặc chọn trường khác!`
    );
  }

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
    // Calling removeIcon() with no parameter removes ALL icons in the viewer
    await viewerRef.removeIcon();
  } catch (e) {
    console.warn("[LabelManager] Lỗi removeIcon:", e);
  }

  labelsVisible = false;
  labeledObjects = [];
  activeIconCount = 0;
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
 * Định dạng giá trị hiển thị trên thẻ label kèm cơ chế fallback
 */
function getFormattedLabelText(obj, field) {
  if (!obj) return { text: null, isFallback: false };

  let val = null;

  switch (field) {
    case "weight": {
      const w = obj.weight || obj.netWeight || obj.grossWeight || 0;
      if (w > 0) {
        val = w >= 1000 ? `${(w / 1000).toFixed(2)} t` : `${w.toFixed(1)} kg`;
      }
      break;
    }
    case "volume": {
      const v = obj.volume || obj.netVolume || obj.grossVolume || 0;
      if (v > 0) val = `${v.toFixed(3)} m³`;
      break;
    }
    case "area": {
      const a = obj.area || obj.grossArea || obj.netArea || 0;
      if (a > 0) val = `${a.toFixed(2)} m²`;
      break;
    }
    case "length": {
      const l = obj.length || 0;
      if (l > 0) val = `${Math.round(l * 1000)} mm`;
      break;
    }
    case "assemblyName": {
      const v = obj.assemblyName || obj.assembly;
      if (v && v !== "(Không xác định)") val = String(v);
      break;
    }
    case "assemblyPos": {
      const v = obj.assemblyPos;
      if (v && v !== "(Không xác định)") val = String(v);
      break;
    }
    case "assemblyPosCode": {
      const v = obj.assemblyPosCode;
      if (v && v !== "(Không xác định)") val = String(v);
      break;
    }
    default: {
      const v = obj[field];
      if (v !== undefined && v !== null && v !== "" && v !== "(Không xác định)") {
        val = String(v);
      }
      break;
    }
  }

  // Nếu có giá trị thực
  if (val) {
    return { text: val, isFallback: false };
  }

  // Cơ chế Fallback: Nếu trường trống và bật fallbackToName
  if (labelConfig.fallbackToName) {
    const fallbackVal = obj.name || (obj.ifcClass ? `${obj.ifcClass} #${obj.id}` : `Object #${obj.id}`);
    return { text: fallbackVal, isFallback: true };
  }

  return { text: null, isFallback: false };
}

/**
 * Tạo tooltip chi tiết khi hover chuột lên thẻ label
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
 * Cập nhật ô xem trước Live Preview của nhãn
 */
function updateLivePreview() {
  const sampleBadge = document.getElementById("label-preview-badge-sample");
  const sampleIcon = document.getElementById("preview-sample-icon");
  const sampleText = document.getElementById("preview-sample-text");

  if (!sampleBadge) return;

  const fieldOpt = LABEL_FIELD_OPTIONS.find((o) => o.value === currentLabelField);
  const iconSymbol = FIELD_ICONS[currentLabelField] || "🏷️";
  const sampleLabelText = fieldOpt ? `Mẫu: ${fieldOpt.label.split(" ")[1] || "Cấu kiện"}` : "Mẫu Nhãn Cấu Kiện";

  if (sampleIcon) {
    sampleIcon.textContent = iconSymbol;
    sampleIcon.style.display = labelConfig.showIcon ? "inline" : "none";
  }

  if (sampleText) {
    sampleText.textContent = sampleLabelText;
  }

  sampleBadge.style.backgroundColor = hexToRgba(labelConfig.bgColor, labelConfig.opacity);
  sampleBadge.style.color = labelConfig.textColor;
  sampleBadge.style.fontSize = `${labelConfig.fontSize * labelConfig.scale}px`;
  sampleBadge.style.borderRadius = `${labelConfig.borderRadius * labelConfig.scale}px`;

  if (labelConfig.borderWidth > 0) {
    sampleBadge.style.border = `${labelConfig.borderWidth * labelConfig.scale}px solid ${labelConfig.borderColor}`;
  } else {
    sampleBadge.style.border = "none";
  }

  if (labelConfig.hasShadow) {
    sampleBadge.style.boxShadow = "0 4px 12px rgba(0,0,0,0.45)";
  } else {
    sampleBadge.style.boxShadow = "none";
  }
}

/**
 * Gắn sự kiện bảng tùy biến màu sắc, kích thước
 */
function bindCustomizationControls() {
  // Accordion toggle
  const accordionHeader = document.getElementById("label-custom-header");
  const accordionBody = document.getElementById("label-custom-body");
  const accordionIcon = document.getElementById("label-custom-toggle-icon");

  if (accordionHeader && accordionBody) {
    accordionHeader.addEventListener("click", () => {
      const isExpanded = accordionBody.classList.toggle("open");
      if (accordionIcon) {
        accordionIcon.textContent = isExpanded ? "▲" : "▼";
      }
    });
  }

  // Color Presets
  const presetContainer = document.getElementById("color-presets");
  if (presetContainer) {
    presetContainer.querySelectorAll(".color-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        presetContainer.querySelectorAll(".color-dot").forEach((d) => d.classList.remove("active"));
        dot.classList.add("active");

        const color = dot.dataset.color;
        const textColor = dot.dataset.text || "#FFFFFF";

        labelConfig.bgColor = color;
        labelConfig.textColor = textColor;

        const bgInput = document.getElementById("cfg-bg-color");
        const bgHex = document.getElementById("cfg-bg-color-hex");
        const textInput = document.getElementById("cfg-text-color");
        const textHex = document.getElementById("cfg-text-color-hex");

        if (bgInput) bgInput.value = color;
        if (bgHex) bgHex.textContent = color;
        if (textInput) textInput.value = textColor;
        if (textHex) textHex.textContent = textColor;

        updateLivePreview();
        debounceAutoApply();
      });
    });
  }

  // Background Color
  const bgInput = document.getElementById("cfg-bg-color");
  const bgHex = document.getElementById("cfg-bg-color-hex");
  if (bgInput) {
    bgInput.addEventListener("input", (e) => {
      labelConfig.bgColor = e.target.value;
      if (bgHex) bgHex.textContent = e.target.value;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Text Color
  const textInput = document.getElementById("cfg-text-color");
  const textHex = document.getElementById("cfg-text-color-hex");
  if (textInput) {
    textInput.addEventListener("input", (e) => {
      labelConfig.textColor = e.target.value;
      if (textHex) textHex.textContent = e.target.value;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Border Color
  const borderInput = document.getElementById("cfg-border-color");
  const borderHex = document.getElementById("cfg-border-color-hex");
  if (borderInput) {
    borderInput.addEventListener("input", (e) => {
      labelConfig.borderColor = e.target.value;
      if (borderHex) borderHex.textContent = e.target.value;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Border Width
  const borderWidthSelect = document.getElementById("cfg-border-width");
  if (borderWidthSelect) {
    borderWidthSelect.addEventListener("change", (e) => {
      labelConfig.borderWidth = parseFloat(e.target.value) || 0;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Font Size Slider
  const fontSizeSlider = document.getElementById("cfg-font-size");
  const fontSizeVal = document.getElementById("cfg-font-size-val");
  if (fontSizeSlider) {
    fontSizeSlider.addEventListener("input", (e) => {
      labelConfig.fontSize = parseInt(e.target.value, 10);
      if (fontSizeVal) fontSizeVal.textContent = `${labelConfig.fontSize}px`;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Scale Slider
  const scaleSlider = document.getElementById("cfg-scale");
  const scaleVal = document.getElementById("cfg-scale-val");
  if (scaleSlider) {
    scaleSlider.addEventListener("input", (e) => {
      labelConfig.scale = parseFloat(e.target.value) || 1.0;
      if (scaleVal) scaleVal.textContent = `${labelConfig.scale.toFixed(1)}x`;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Z-Offset Select
  const zOffsetSelect = document.getElementById("cfg-z-offset");
  if (zOffsetSelect) {
    zOffsetSelect.addEventListener("change", (e) => {
      labelConfig.zOffset = parseFloat(e.target.value) || 0.15;
      debounceAutoApply();
    });
  }

  // Border Radius Select
  const radiusSelect = document.getElementById("cfg-border-radius");
  if (radiusSelect) {
    radiusSelect.addEventListener("change", (e) => {
      labelConfig.borderRadius = parseInt(e.target.value, 10) || 0;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Unit Scale Select
  const unitScaleSelect = document.getElementById("cfg-unit-scale");
  if (unitScaleSelect) {
    unitScaleSelect.addEventListener("change", (e) => {
      labelConfig.unitScale = e.target.value;
      debounceAutoApply();
    });
  }

  // Badge Mode Select
  const badgeModeSelect = document.getElementById("cfg-badge-mode");
  if (badgeModeSelect) {
    badgeModeSelect.addEventListener("change", (e) => {
      labelConfig.badgeMode = e.target.value;
      debounceAutoApply();
    });
  }

  // Checkbox Show Icon
  const showIconChk = document.getElementById("cfg-show-icon");
  if (showIconChk) {
    showIconChk.addEventListener("change", (e) => {
      labelConfig.showIcon = e.target.checked;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Checkbox Shadow
  const shadowChk = document.getElementById("cfg-has-shadow");
  if (shadowChk) {
    shadowChk.addEventListener("change", (e) => {
      labelConfig.hasShadow = e.target.checked;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Checkbox Fallback to Name
  const fallbackChk = document.getElementById("cfg-fallback-name");
  if (fallbackChk) {
    fallbackChk.addEventListener("change", (e) => {
      labelConfig.fallbackToName = e.target.checked;
      debounceAutoApply();
    });
  }

  // Checkbox Zoom on Click
  const zoomOnClickChk = document.getElementById("cfg-zoom-on-click");
  if (zoomOnClickChk) {
    zoomOnClickChk.addEventListener("change", (e) => {
      labelConfig.zoomOnClick = e.target.checked;
    });
  }

  // Reset to Defaults
  const resetBtn = document.getElementById("btn-reset-label-style");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      labelConfig = { ...DEFAULT_LABEL_CONFIG };

      if (bgInput) bgInput.value = labelConfig.bgColor;
      if (bgHex) bgHex.textContent = labelConfig.bgColor;
      if (textInput) textInput.value = labelConfig.textColor;
      if (textHex) textHex.textContent = labelConfig.textColor;
      if (borderInput) borderInput.value = labelConfig.borderColor;
      if (borderHex) borderHex.textContent = labelConfig.borderColor;
      if (borderWidthSelect) borderWidthSelect.value = String(labelConfig.borderWidth);
      if (fontSizeSlider) fontSizeSlider.value = String(labelConfig.fontSize);
      if (fontSizeVal) fontSizeVal.textContent = `${labelConfig.fontSize}px`;
      if (scaleSlider) scaleSlider.value = String(labelConfig.scale);
      if (scaleVal) scaleVal.textContent = `${labelConfig.scale.toFixed(1)}x`;
      if (zOffsetSelect) zOffsetSelect.value = String(labelConfig.zOffset);
      if (radiusSelect) radiusSelect.value = String(labelConfig.borderRadius);
      if (unitScaleSelect) unitScaleSelect.value = labelConfig.unitScale;
      if (badgeModeSelect) badgeModeSelect.value = labelConfig.badgeMode;
      if (showIconChk) showIconChk.checked = labelConfig.showIcon;
      if (shadowChk) shadowChk.checked = labelConfig.hasShadow;
      if (fallbackChk) fallbackChk.checked = labelConfig.fallbackToName;
      if (zoomOnClickChk) zoomOnClickChk.checked = labelConfig.zoomOnClick;

      updateLivePreview();
      debounceAutoApply();
    });
  }
}

// Hỗ trợ tự động cập nhật nhãn trên 3D sau khi kéo slider/đổi màu (debounce 400ms)
let autoApplyTimeout = null;
function debounceAutoApply() {
  if (!labelsVisible) return;
  clearTimeout(autoApplyTimeout);
  autoApplyTimeout = setTimeout(() => {
    applyLabels();
  }, 400);
}

/**
 * Gắn sự kiện UI chính (Buttons & Selects)
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
      updateLivePreview();
      if (labelsVisible) {
        applyLabels();
      }
    });
  }

  // Dropdown chọn phạm vi áp dụng
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
 * Hiển thị danh sách checklist các thẻ label đang hiển thị kèm click để select & zoom camera trong 3D
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

  let html = "";
  labeledObjects.slice(0, 150).forEach((item, idx) => {
    const obj = item.obj;
    const name = obj.name || `Object #${obj.id}`;
    const val = item.text;
    const modelId = obj.modelId;
    const id = obj.id;
    const fallbackBadge = item.isFallback
      ? '<span class="label-fallback-indicator" title="Giá trị tự động thay thế bằng Tên cấu kiện do trường được chọn bị trống">Tên</span>'
      : "";

    html += `
      <div class="label-preview-item" data-model-id="${modelId}" data-object-id="${id}" title="Nhấp để định vị &amp; chọn cấu kiện này trong 3D View">
        <span class="label-preview-num">${idx + 1}</span>
        <div class="label-preview-info">
          <div class="label-preview-title">${escapeHtml(name)}</div>
          <div class="label-preview-sub">ID: ${id} | ${escapeHtml(obj.ifcClass || "IFC")}</div>
        </div>
        <div class="label-preview-right">
          ${fallbackBadge}
          <span class="label-preview-tag" style="background:${hexToRgba(labelConfig.bgColor, 0.25)}; color:${labelConfig.textColor}; border-color:${labelConfig.bgColor};">${escapeHtml(val)}</span>
        </div>
      </div>
    `;
  });

  if (labeledObjects.length > 150) {
    html += `<div class="label-preview-more">...và ${labeledObjects.length - 150} cấu kiện khác</div>`;
  }

  container.innerHTML = html;

  // Gắn sự kiện click vào từng item để highlight / select VÀ zoom camera vào cấu kiện trong 3D
  container.querySelectorAll(".label-preview-item").forEach((el) => {
    el.addEventListener("click", async () => {
      const modelId = el.getAttribute("data-model-id");
      const objectId = parseInt(el.getAttribute("data-object-id"), 10);

      if (viewerRef && modelId && !isNaN(objectId)) {
        try {
          // Highlight cấu kiện
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

          // Nếu bật tính năng zoom: Tự động đưa camera tới cấu kiện
          if (labelConfig.zoomOnClick) {
            try {
              await viewerRef.setCamera({
                modelObjectIds: [
                  {
                    modelId,
                    objectRuntimeIds: [objectId],
                  },
                ],
              });
            } catch (camErr) {
              // bỏ qua nếu setCamera theo selector không hỗ trợ
            }
          }
        } catch (e) {
          console.warn("[LabelManager] Set selection/camera failed:", e);
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
