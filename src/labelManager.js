/**
 * labelManager.js — 3D Label Manager for Trimble Connect Viewer
 *
 * Hiển thị thẻ label (tag) trực tiếp lên từng cấu kiện trên 3D view.
 * Cải tiến toàn diện:
 *   1. Chống crash & lag: Lọc cấu kiện (Dầm & Cột / Khung kết cấu), sắp xếp ưu tiên
 *      theo vai trò kết cấu (Dầm & Cột trước, Bản mã & Bu-lông sau), tải tuần tự mượt (progressive stream)
 *      kèm thanh tiến trình và nút "Dừng tải".
 *   2. Bám dính cấu kiện (Zero Ambiguity): Chân kim dẫn bám đỉnh bề mặt (Leader Stem)
 *      với tâm ghim Bullseye ◉ chạm trực tiếp bề mặt thép; hoặc chế độ bám tâm 3D (Centroid).
 *   3. Phân biệt loại cấu kiện: Tự động tô màu theo loại (Dầm = Xanh, Cột = Lục, Bản mã = Cam)
 *      kèm tiền tố loại rõ ràng ([DẦM] HSS400X400X16, [CỘT] HSS400, [BẢN MÃ] PLT10x120).
 *   4. Tương tác 3D hai chiều: Nhấp bất kỳ nhãn nào trên view 3D (viewer.onIconPicked)
 *      để tự động sáng & chọn cấu kiện trong mô hình và cuộn đến thẻ tương ứng trong checklist!
 */

import {
  getAllObjects,
  getSelectedObjects,
  getSelectedIds,
  getFilteredObjects,
  scanObjects,
} from "./objectExplorer.js";
import { onEvent } from "./main.js";

// ── State ──
let apiRef = null;
let viewerRef = null;
let labelsVisible = false;
let currentLabelField = "smartName";
let labelScope = "all"; // "all" | "selected" | "visible"
let labelCategory = "all"; // "all" | "structural" | "beam" | "column" | "plate" | "fastener" (Mặc định: Tất cả)
let labelLimit = 0; // 0 = Tất cả (Không giới hạn - Hiển thị 100% cấu kiện)
let labeledObjects = []; // { obj, text, subText, position, iconId, isFallback, category }
let activeIconCount = 0;
let isLabelLoadingCancelled = false;
let isLabelLoadingActive = false;
let pendingObjectsToStream = []; // Danh sách cấu kiện còn lại chờ tải thêm trên mô hình siêu lớn

// ── Cấu hình tùy biến nhãn (Mặc định) ──
const DEFAULT_LABEL_CONFIG = {
  bgColor: "#2563EB", // Màu nền mặc định
  textColor: "#FFFFFF", // Màu chữ
  borderColor: "#FFFFFF", // Màu viền
  borderWidth: 1.5, // Độ dày viền (px)
  borderRadius: 8, // Bo góc (px)
  fontSize: 13, // Cỡ chữ (px)
  scale: 1.0, // Độ to nhỏ (tỉ lệ)
  opacity: 0.95, // Độ mờ nền
  zOffset: 0.0, // Độ cao nhô khỏi bề mặt (m) — 0.0 = chân ghim chạm đúng bề mặt cấu kiện
  unitScale: "auto", // "auto" | "mm" | "m"
  badgeMode: "anchorLeader", // "anchorLeader" | "canvasBadge" | "card2Line" | "centroidBadge" | "pinMarker"
  anchorPos: "topSurface", // "topSurface" | "centroid"
  colorByCategory: true, // Tự động tô màu theo loại cấu kiện
  addCategoryPrefix: true, // Thêm tiền tố loại ([DẦM], [CỘT], [BẢN MÃ])
  clickToSelect: true, // Nhấp nhãn trên 3D để sáng cấu kiện
  hasShadow: true, // Bóng đổ 3D
  showIcon: true, // Hiện biểu tượng icon
  fallbackToName: true, // Tự động dùng Tên nếu trường trống
  zoomOnClick: true, // Zoom camera khi nhấp thẻ trong danh sách
};

// Cấu hình hiện hành
let labelConfig = { ...DEFAULT_LABEL_CONFIG };

// ── Phân loại Cấu kiện Kết cấu Thép / BIM Thông Minh ──
export function classifyObjectCategory(obj) {
  if (!obj) return "other";
  const cls = (obj.ifcClass || "").toLowerCase();
  const name = (obj.name || "").toUpperCase();
  const desc = (obj.description || "").toUpperCase();
  const type = (obj.ifcType || obj.typeName || obj.profile || obj.smartName || "").toUpperCase();

  // 1. BU LÔNG & ĐAI ỐC PHẢI XÉT TRƯỚC HẾT (Tránh nhầm đai ốc chân cột thành Cột!)
  if (
    cls.includes("fastener") ||
    cls.includes("bolt") ||
    cls.includes("accessory") ||
    Boolean(obj.ifcFastenerType) ||
    name.startsWith("NUT") ||
    name.startsWith("BOLT") ||
    name.startsWith("WASH") ||
    name.startsWith("ANCHOR") ||
    type.startsWith("NUT") ||
    type.startsWith("BOLT") ||
    type.startsWith("M2") ||
    type.startsWith("M3")
  ) {
    return "fastener";
  }

  // 2. BẢN MÃ & TẤM LIÊN KẾT PHẢI XÉT THỨ HAI (Tránh nhầm bản mã chân cột thành Cột!)
  if (
    cls.includes("plate") ||
    Boolean(obj.ifcPlateType) ||
    name.startsWith("PLT") ||
    name.startsWith("BPL") ||
    name.startsWith("SPLICE") ||
    name.startsWith("GUSSET") ||
    name.startsWith("STIFF") ||
    name.startsWith("SHIM") ||
    name.startsWith("CAP") ||
    type.startsWith("PLT") ||
    type.startsWith("BPL") ||
    type.startsWith("FLAT")
  ) {
    return "plate";
  }

  // 3. DẦM (BEAM)
  if (
    cls.includes("beam") ||
    Boolean(obj.ifcBeamType) ||
    name.startsWith("BEAM") ||
    name.startsWith("GIRDER") ||
    name.startsWith("JOIST") ||
    name.startsWith("RAFTER") ||
    name.startsWith("PURLIN") ||
    name.startsWith("B_") ||
    name.includes("BEAM") ||
    desc.includes("BEAM")
  ) {
    return "beam";
  }

  // 4. CỘT (COLUMN)
  if (
    cls.includes("column") ||
    Boolean(obj.ifcColumnType) ||
    name.startsWith("COL") ||
    name.startsWith("PILLAR") ||
    name.startsWith("POST") ||
    name.startsWith("C_") ||
    name.includes("COLUMN") ||
    desc.includes("COLUMN")
  ) {
    return "column";
  }

  // 5. THANH KẾT CẤU CHÍNH / KHUNG DÀN / GIẰNG (MEMBER)
  if (
    cls.includes("member") ||
    Boolean(obj.ifcMemberType) ||
    cls.includes("truss") ||
    cls.includes("brace") ||
    name.startsWith("BRACE") ||
    name.startsWith("TRUSS") ||
    name.startsWith("STRUT") ||
    name.startsWith("TIE") ||
    name.startsWith("MEMBER") ||
    name.startsWith("M_") ||
    type.startsWith("HSS") ||
    type.startsWith("W") ||
    type.startsWith("IPE") ||
    type.startsWith("HEA") ||
    type.startsWith("HEB")
  ) {
    return "member";
  }

  return "other";
}

// ── Bảng màu sắc nhận diện theo loại cấu kiện ──
export const CATEGORY_COLORS = {
  beam: "#2563EB",     // Xanh dương đậm — Dầm chính/phụ
  column: "#059669",   // Xanh ngọc lục bảo — Cột
  member: "#7C3AED",   // Tím hoàng gia — Thanh kết cấu / Giằng / Khung dàn
  plate: "#D97706",    // Hổ phách / Cam đồng — Bản mã, Stiffener
  fastener: "#DC2626", // Đỏ — Bu-lông, đai ốc
  other: "#475569",    // Xám than chì — Cấu kiện khác
};

// Tiền tố tiếng Việt hiển thị
export const CATEGORY_LABELS_VI = {
  beam: "DẦM",
  column: "CỘT",
  member: "KẾT CẤU",
  plate: "BẢN MÃ",
  fastener: "BU-LÔNG",
  other: "CẤU KIỆN",
};

// Thứ tự ưu tiên cấu kiện (Dầm, Cột, Thanh kết cấu luôn được ưu tiên trước!)
const CATEGORY_PRIORITY = {
  column: 1,
  beam: 2,
  member: 3,
  other: 4,
  plate: 5,
  fastener: 6,
};

// ── Biểu tượng Icon đại diện cho từng loại trường ──
const FIELD_ICONS = {
  smartName: "✨",
  ifcType: "🏢",
  ifcBeamType: "🪵",
  ifcMemberType: "🏗️",
  ifcColumnType: "🏛️",
  ifcPlateType: "📐",
  productName: "📦",
  productObjectType: "🏷️",
  profile: "📏",
  name: "🏷️",
  material: "🪨",
  assemblyName: "🏗️",
  assemblyPos: "📍",
  assemblyPosCode: "🔢",
  referenceName: "📎",
  ifcClass: "🧱",
  weight: "⚖️",
  volume: "📦",
  length: "📏",
  type: "📦",
  modelName: "📁",
  revitType: "🔧",
  revitFamily: "🏠",
  level: "🏢",
  description: "📝",
  tag: "🔖",
  group: "📁",
};

// ── Danh sách các trường hiển thị ──
export const LABEL_FIELD_OPTIONS = [
  { value: "smartName", label: "✨ Tên nhận diện thông minh (Smart Recognition - Đề xuất)" },
  { value: "ifcType", label: "🏢 IFC Type / Tiết diện chung (Beam / Member / Column Type)" },
  { value: "ifcBeamType", label: "🪵 Ifc Beam Type (Dầm)" },
  { value: "ifcMemberType", label: "🏗️ Ifc Member Type (Thanh kết cấu)" },
  { value: "ifcColumnType", label: "🏛️ Ifc Column Type (Cột)" },
  { value: "ifcPlateType", label: "📐 Ifc Plate Type (Bản mã)" },
  { value: "productName", label: "📦 Product Name (Tên cấu kiện từ file IFC)" },
  { value: "productObjectType", label: "🏷️ Product Object Type" },
  { value: "profile", label: "📏 Profile / Tiết diện (HSS, W, IPE...)" },
  { value: "name", label: "🏷️ Tên Object" },
  { value: "material", label: "🪨 Vật liệu (STEEL, Concrete...)" },
  { value: "assemblyName", label: "🏗️ Assembly Name / Mark" },
  { value: "assemblyPos", label: "📍 Assembly Pos / Part Pos" },
  { value: "assemblyPosCode", label: "🔢 Position Code" },
  { value: "referenceName", label: "📎 Reference Name" },
  { value: "ifcClass", label: "🧱 IFC Class" },
  { value: "weight", label: "⚖️ Khối lượng (kg / tấn)" },
  { value: "volume", label: "📦 Thể tích (m³)" },
  { value: "length", label: "📏 Chiều dài (mm)" },
  { value: "type", label: "📦 Object Type" },
  { value: "modelName", label: "📁 File IFC / Model Name" },
  { value: "revitType", label: "🔧 Revit Type" },
  { value: "revitFamily", label: "🏠 Revit Family" },
  { value: "level", label: "🏢 Tầng / Level" },
  { value: "description", label: "📝 Mô tả" },
  { value: "tag", label: "🔖 Tag" },
];

/**
 * Trích xuất Bounding Box từ đối tượng trả về của TC Workspace API
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
 */
function determineUnitScaleFactor(bboxes) {
  if (labelConfig.unitScale === "mm") return 0.001;
  if (labelConfig.unitScale === "m") return 1.0;

  // Chế độ "auto": Phân tích kích thước và tọa độ
  let maxCoord = 0;
  let maxSpan = 0;

  for (const b of bboxes) {
    if (!b) continue;
    const spanX = Math.abs(b.max.x - b.min.x);
    const spanY = Math.abs(b.max.y - b.min.y);
    const spanZ = Math.abs(b.max.z - b.min.z);
    const span = Math.max(spanX, spanY, spanZ);
    if (span > maxSpan) maxSpan = span;

    const c = Math.max(Math.abs(b.max.x), Math.abs(b.max.y), Math.abs(b.max.z));
    if (c > maxCoord) maxCoord = c;
  }

  if (maxSpan > 50 || maxCoord > 500) {
    console.log(`[LabelManager] Tự động phát hiện MILIMÉT (maxCoord=${maxCoord.toFixed(1)}, maxSpan=${maxSpan.toFixed(1)}). Chuyển đổi mm -> mét (chia 1000).`);
    return 0.001;
  }

  console.log(`[LabelManager] Tự động phát hiện MÉT (maxCoord=${maxCoord.toFixed(2)}, maxSpan=${maxSpan.toFixed(2)}). Giữ nguyên 1:1.`);
  return 1.0;
}

/**
 * Chuyển đổi mã màu Hex sang RGBA
 */
function hexToRgba(hex, alpha = 1.0) {
  let cleanHex = (hex || "#2563EB").replace("#", "");
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
 * Tạo icon Ghim 3D dạng Pin Marker sắc nét trong Square Canvas (Retina 2x PNG)
 * Điểm chóp nhọn của ghim đặt chính xác tại (cx, cy) để chạm đúng bề mặt 3D!
 */
function createPinMarkerCanvas(color = "#2563EB", textSymbol = "📍") {
  const pixelRatio = 2;
  const squareSize = 160 * pixelRatio;
  const canvas = document.createElement("canvas");
  canvas.width = squareSize;
  canvas.height = squareSize;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, squareSize, squareSize);

  const cx = squareSize / 2;
  const cy = squareSize / 2; // Điểm ghim chạm đúng tâm 3D!

  const headR = 24 * pixelRatio;
  const headCy = cy - 36 * pixelRatio;
  const tipX = cx;
  const tipY = cy;

  // Drop shadow
  if (labelConfig.hasShadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
    ctx.shadowBlur = 8 * pixelRatio;
    ctx.shadowOffsetY = 3 * pixelRatio;
  }

  // Pin outer path
  ctx.beginPath();
  ctx.arc(cx, headCy, headR, Math.PI * 0.85, Math.PI * 0.15, false);
  ctx.lineTo(tipX, tipY);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  if (labelConfig.hasShadow) {
    ctx.restore();
  }

  // White border
  ctx.lineWidth = 3 * pixelRatio;
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();

  // Inner white circle
  ctx.beginPath();
  ctx.arc(cx, headCy, 16 * pixelRatio, 0, Math.PI * 2);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();

  // Symbol inside
  ctx.font = `${Math.round(16 * pixelRatio)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(textSymbol, cx, headCy);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    squareSize,
  };
}

/**
 * Vẽ thẻ nhãn tùy biến lên HTML5 Canvas sắc nét (Retina 2x)
 * Trả về Data URI PNG Base64 trong Canvas VUÔNG (Square Canvas)
 *
 * ĐẶC BIỆT:
 * Trong Three.js Sprite quad, tâm sprite (0.5, 0.5) nằm tại tọa độ 3D `pointIcon.position`.
 * Bằng cách đặt điểm chân kim Bullseye ◉ tại TÂM CANVAS (cx, cy):
 * -> Chân kim Bullseye ◉ sẽ 100% khóa chặt vào bề mặt cấu kiện, KHÔNG BAO GIỜ BỊ LỆCH
 *    khi xoay hoặc phóng to/thu nhỏ camera 3D!
 * -> Nhãn chữ nằm phía trên chân kim dẫn (Leader Stem) giúp người xem nhận biết rõ ràng
 *    thẻ này đang trỏ thẳng vào cấu kiện nào!
 * -> Canvas VUÔNG tự động co giãn theo kích thước chuỗi ký tự thực tế (squareSize động)
 *    giúp bảo đảm 100% nội dung chữ KHÔNG BAO GIỜ BỊ CẮT XÉN (anti-clipping)!
 */
function createLabelBadgeCanvas(text, iconSymbol = "🏷️", subText = null, category = "other") {
  const pixelRatio = 2; // Vẽ 2x để nhãn trên 3D không bị mờ
  const effectiveFontSize = Math.round(labelConfig.fontSize * labelConfig.scale * pixelRatio);
  const fontFace = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';

  // Xác định màu nền hiệu dụng (nếu bật tô màu theo loại)
  let effectiveBgColor = labelConfig.bgColor;
  if (labelConfig.colorByCategory && CATEGORY_COLORS[category]) {
    effectiveBgColor = CATEGORY_COLORS[category];
  }

  // Xử lý tiền tố phân loại ([DẦM], [CỘT], [BẢN MÃ])
  let displayMain = text || "";
  if (labelConfig.addCategoryPrefix && CATEGORY_LABELS_VI[category]) {
    const prefix = `[${CATEGORY_LABELS_VI[category]}]`;
    if (!displayMain.startsWith(prefix) && !displayMain.startsWith("[")) {
      displayMain = `${prefix} ${displayMain}`;
    }
  }

  // Cho phép chuỗi ký tự hiển thị đầy đủ (lên đến 65 ký tự mà không bị cắt sớm)
  const displayStr = displayMain.length > 65 ? displayMain.slice(0, 62) + "…" : displayMain;
  const displaySubStr = subText && subText.length > 55 ? subText.slice(0, 52) + "…" : subText;

  // Dùng canvas tạm để đo chiều rộng text
  const tempCanvas = document.createElement("canvas");
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.font = `bold ${effectiveFontSize}px ${fontFace}`;

  let contentWidth = Math.ceil(tempCtx.measureText(displayStr).width);

  const is2Line = Boolean(displaySubStr) && labelConfig.badgeMode === "card2Line";
  const subFontSize = Math.round(effectiveFontSize * 0.78);

  if (is2Line) {
    tempCtx.font = `normal ${subFontSize}px ${fontFace}`;
    const subWidth = Math.ceil(tempCtx.measureText(displaySubStr).width);
    contentWidth = Math.max(contentWidth, subWidth);
  }

  const showIcon = labelConfig.showIcon && Boolean(iconSymbol);
  const iconWidth = showIcon ? Math.round(effectiveFontSize * 1.1) : 0;
  const iconSpacing = showIcon ? Math.round(effectiveFontSize * 0.4) : 0;

  const horizPadding = Math.round(14 * labelConfig.scale * pixelRatio);
  const vertPadding = Math.round(8 * labelConfig.scale * pixelRatio);

  const badgeWidth = Math.max(contentWidth + iconWidth + iconSpacing + horizPadding * 2, 76 * pixelRatio);
  const badgeHeight = is2Line
    ? Math.round(effectiveFontSize + subFontSize + vertPadding * 2 + 4 * pixelRatio)
    : Math.round(effectiveFontSize + vertPadding * 2);

  const mode = labelConfig.badgeMode;

  // Chiều cao phần chân kim dẫn / chóp tam giác
  const stemHeight = mode === "anchorLeader"
    ? Math.round(24 * labelConfig.scale * pixelRatio)
    : (mode === "centroidBadge" ? 0 : Math.round(9 * labelConfig.scale * pixelRatio));

  // Biên an toàn xung quanh (để đổ bóng và nét viền dày không bao giờ bị chạm mép canvas)
  const marginH = Math.round(28 * pixelRatio);
  const marginV = Math.round(22 * pixelRatio);

  const neededW = badgeWidth + marginH * 2;
  const neededH = (badgeHeight + stemHeight) * 2 + marginV * 2;

  // Canvas VUÔNG (Square Canvas) tự động mở rộng theo kích thước text thực tế!
  // Đảm bảo tâm neo (cx, cy) nằm ở chính giữa quad Three.js (0.5, 0.5)
  // và nhãn chữ (bx, by) luôn cách mép an toàn, KHÔNG BAO GIỜ BỊ CẮT XÉN (CLIPPING)!
  const squareSize = Math.max(256, Math.ceil(Math.max(neededW, neededH)));
  const canvas = document.createElement("canvas");
  canvas.width = squareSize;
  canvas.height = squareSize;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, squareSize, squareSize);

  const cx = squareSize / 2;
  const cy = squareSize / 2; // Điểm neo chuẩn tại tâm 3D!

  if (mode === "centroidBadge") {
    // ══════════════════════════════════════════════════════════
    // CHẾ ĐỘ 1: BÁM TÂM 3D CẤU KIỆN (CENTROID)
    // Thẻ nằm ngay giữa tâm 3D của cấu kiện (trong lòng dầm/cột)
    // ══════════════════════════════════════════════════════════
    const bx = Math.round(cx - badgeWidth / 2);
    const by = Math.round(cy - badgeHeight / 2);
    const r = Math.min(Math.round(labelConfig.borderRadius * labelConfig.scale * pixelRatio), badgeHeight / 2);

    // Đổ bóng
    if (labelConfig.hasShadow) {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
      ctx.shadowBlur = Math.round(8 * pixelRatio);
      ctx.shadowOffsetY = Math.round(3 * pixelRatio);
    }

    // Vẽ hình chữ nhật bo góc
    drawRoundedRect(ctx, bx, by, badgeWidth, badgeHeight, r);
    ctx.fillStyle = hexToRgba(effectiveBgColor, labelConfig.opacity);
    ctx.fill();

    if (labelConfig.hasShadow) ctx.restore();

    // Viền
    if (labelConfig.borderWidth > 0) {
      drawRoundedRect(ctx, bx, by, badgeWidth, badgeHeight, r);
      ctx.strokeStyle = labelConfig.borderColor;
      ctx.lineWidth = labelConfig.borderWidth * labelConfig.scale * pixelRatio;
      ctx.stroke();
    }

    // Vẽ chữ
    renderBadgeText(ctx, bx, by, badgeWidth, badgeHeight, displayStr, displaySubStr, iconSymbol, showIcon, iconWidth, iconSpacing, horizPadding, vertPadding, effectiveFontSize, subFontSize, is2Line, fontFace);

  } else if (mode === "anchorLeader") {
    // ══════════════════════════════════════════════════════════
    // CHẾ ĐỘ 2: CHÂN KIM DẪN BÁM ĐỈNH BỀ MẶT (BIM LEADER STEM)
    // - Điểm Bullseye ◉ nằm tại (cx, cy) chạm đúng bề mặt kim loại!
    // - Cột chân kim dẫn (Leader Stem) vươn lên nối vào thẻ nhãn!
    // ══════════════════════════════════════════════════════════
    const stemHeight = Math.round(24 * labelConfig.scale * pixelRatio);
    const by = Math.round(cy - stemHeight - badgeHeight);
    const bx = Math.round(cx - badgeWidth / 2);
    const r = Math.min(Math.round(labelConfig.borderRadius * labelConfig.scale * pixelRatio), badgeHeight / 2);

    // 1. Vẽ điểm neo Bullseye ◉ tại (cx, cy) chạm trực tiếp bề mặt
    const dotOuterR = Math.round(5.5 * pixelRatio);
    const dotMidR = Math.round(4.0 * pixelRatio);
    const dotInnerR = Math.round(2.0 * pixelRatio);

    // Đổ bóng cho chân kim & bullseye
    if (labelConfig.hasShadow) {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
      ctx.shadowBlur = Math.round(6 * pixelRatio);
      ctx.shadowOffsetY = Math.round(2 * pixelRatio);
    }

    // Đường kim dẫn (Leader Stem)
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, by + badgeHeight);
    ctx.lineWidth = Math.round(3.5 * pixelRatio);
    ctx.strokeStyle = "#FFFFFF";
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, by + badgeHeight);
    ctx.lineWidth = Math.round(2.0 * pixelRatio);
    ctx.strokeStyle = effectiveBgColor;
    ctx.stroke();

    // Vòng ngoài Bullseye (Trắng)
    ctx.beginPath();
    ctx.arc(cx, cy, dotOuterR, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();

    // Vòng giữa (Màu thẻ)
    ctx.beginPath();
    ctx.arc(cx, cy, dotMidR, 0, Math.PI * 2);
    ctx.fillStyle = effectiveBgColor;
    ctx.fill();

    // Điểm tâm trắng
    ctx.beginPath();
    ctx.arc(cx, cy, dotInnerR, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();

    // 2. Vẽ thân thẻ nhãn phía trên
    drawRoundedRect(ctx, bx, by, badgeWidth, badgeHeight, r);
    ctx.fillStyle = hexToRgba(effectiveBgColor, labelConfig.opacity);
    ctx.fill();

    if (labelConfig.hasShadow) ctx.restore();

    // Viền thẻ
    if (labelConfig.borderWidth > 0) {
      drawRoundedRect(ctx, bx, by, badgeWidth, badgeHeight, r);
      ctx.strokeStyle = labelConfig.borderColor;
      ctx.lineWidth = labelConfig.borderWidth * labelConfig.scale * pixelRatio;
      ctx.stroke();
    }

    // Vẽ chữ
    renderBadgeText(ctx, bx, by, badgeWidth, badgeHeight, displayStr, displaySubStr, iconSymbol, showIcon, iconWidth, iconSpacing, horizPadding, vertPadding, effectiveFontSize, subFontSize, is2Line, fontFace);

  } else {
    // ══════════════════════════════════════════════════════════
    // CHẾ ĐỘ 3: THẺ CHỮ CÓ ĐUÔI TAM GIÁC (PILL BADGE / CARD 2-LINE)
    // Đuôi tam giác nhọn chạm chính xác vào (cx, cy)
    // ══════════════════════════════════════════════════════════
    const tailHeight = Math.round(9 * labelConfig.scale * pixelRatio);
    const by = Math.round(cy - tailHeight - badgeHeight);
    const bx = Math.round(cx - badgeWidth / 2);
    const r = Math.min(Math.round(labelConfig.borderRadius * labelConfig.scale * pixelRatio), badgeHeight / 2);
    const tailHalfW = Math.round(8 * labelConfig.scale * pixelRatio);

    if (labelConfig.hasShadow) {
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
      ctx.shadowBlur = Math.round(8 * pixelRatio);
      ctx.shadowOffsetY = Math.round(3 * pixelRatio);
    }

    // Vẽ hình chữ nhật bo góc kèm đuôi kim chỉ xuống đỉnh cấu kiện
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + badgeWidth - r, by);
    ctx.quadraticCurveTo(bx + badgeWidth, by, bx + badgeWidth, by + r);
    ctx.lineTo(bx + badgeWidth, by + badgeHeight - r);
    ctx.quadraticCurveTo(bx + badgeWidth, by + badgeHeight, bx + badgeWidth - r, by + badgeHeight);

    // Đuôi tam giác chỉ xuống (chóp nhọn chạm đúng cy)
    ctx.lineTo(cx + tailHalfW, by + badgeHeight);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx - tailHalfW, by + badgeHeight);

    ctx.lineTo(bx + r, by + badgeHeight);
    ctx.quadraticCurveTo(bx, by + badgeHeight, bx, by + badgeHeight - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();

    ctx.fillStyle = hexToRgba(effectiveBgColor, labelConfig.opacity);
    ctx.fill();

    if (labelConfig.hasShadow) ctx.restore();

    // Viền
    if (labelConfig.borderWidth > 0) {
      ctx.beginPath();
      ctx.moveTo(bx + r, by);
      ctx.lineTo(bx + badgeWidth - r, by);
      ctx.quadraticCurveTo(bx + badgeWidth, by, bx + badgeWidth, by + r);
      ctx.lineTo(bx + badgeWidth, by + badgeHeight - r);
      ctx.quadraticCurveTo(bx + badgeWidth, by + badgeHeight, bx + badgeWidth - r, by + badgeHeight);

      ctx.lineTo(cx + tailHalfW, by + badgeHeight);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - tailHalfW, by + badgeHeight);

      ctx.lineTo(bx + r, by + badgeHeight);
      ctx.quadraticCurveTo(bx, by + badgeHeight, bx, by + badgeHeight - r);
      ctx.lineTo(bx, by + r);
      ctx.quadraticCurveTo(bx, by, bx + r, by);
      ctx.closePath();

      ctx.strokeStyle = labelConfig.borderColor;
      ctx.lineWidth = labelConfig.borderWidth * labelConfig.scale * pixelRatio;
      ctx.stroke();
    }

    // Vẽ chữ
    renderBadgeText(ctx, bx, by, badgeWidth, badgeHeight, displayStr, displaySubStr, iconSymbol, showIcon, iconWidth, iconSpacing, horizPadding, vertPadding, effectiveFontSize, subFontSize, is2Line, fontFace);
  }

  return {
    dataUrl: canvas.toDataURL("image/png"),
    squareSize,
  };
}

/**
 * Vẽ hình chữ nhật bo góc
 */
function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Vẽ chữ và biểu tượng lên thẻ
 */
function renderBadgeText(ctx, bx, by, badgeWidth, badgeHeight, displayStr, displaySubStr, iconSymbol, showIcon, iconWidth, iconSpacing, horizPadding, vertPadding, effectiveFontSize, subFontSize, is2Line, fontFace) {
  let drawX = bx + horizPadding;

  if (is2Line) {
    const line1Y = by + vertPadding + Math.round(effectiveFontSize * 0.82);
    const line2Y = line1Y + Math.round(subFontSize * 1.25);

    if (showIcon) {
      ctx.font = `${Math.round(effectiveFontSize * 1.05)}px ${fontFace}`;
      ctx.fillText(iconSymbol, drawX, line1Y + Math.round(subFontSize * 0.35));
      drawX += iconWidth + iconSpacing;
    }

    ctx.font = `bold ${effectiveFontSize}px ${fontFace}`;
    ctx.fillStyle = labelConfig.textColor;
    ctx.fillText(displayStr, drawX, line1Y);

    ctx.font = `normal ${subFontSize}px ${fontFace}`;
    ctx.fillStyle = hexToRgba(labelConfig.textColor, 0.88);
    ctx.fillText(displaySubStr, drawX, line2Y);
  } else {
    const baselineY = by + vertPadding + Math.round(effectiveFontSize * 0.82);

    if (showIcon) {
      ctx.font = `${Math.round(effectiveFontSize * 0.95)}px ${fontFace}`;
      ctx.fillText(iconSymbol, drawX, baselineY);
      drawX += iconWidth + iconSpacing;
    }

    ctx.font = `bold ${effectiveFontSize}px ${fontFace}`;
    ctx.fillStyle = labelConfig.textColor;
    ctx.fillText(displayStr, drawX, baselineY);
  }
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

  // Lắng nghe sự kiện người dùng nhấp vào PointIcon trên 3D view (Trimble Connect API)
  onEvent("viewer.onIconPicked", (data) => {
    handleIconPicked(data);
  });

  // Gắn sự kiện cho các điều khiển UI & bảng tùy biến
  bindUIControls();
  bindCustomizationControls();
  updateLivePreview();

  console.log("[LabelManager] Module initialized successfully");
}

/**
 * Xử lý khi người dùng nhấp vào một thẻ label trên 3D View
 * -> Tự động highlight sáng cấu kiện trong mô hình và chọn trong danh sách checklist!
 */
function handleIconPicked(data) {
  if (!labelConfig.clickToSelect) return;
  if (!data) return;

  console.log("[LabelManager] viewer.onIconPicked event:", data);

  const pickedList = Array.isArray(data)
    ? data
    : Array.isArray(data.data)
    ? data.data
    : [data];

  for (const item of pickedList) {
    const rawId = item && item.id !== undefined ? item.id : item;
    const numericId = Number(rawId);
    if (isNaN(numericId)) continue;

    const match = labeledObjects.find((lo) => lo.iconId === numericId);
    if (match && match.obj && viewerRef) {
      const obj = match.obj;
      console.log(`[LabelManager] ✓ Picked 3D Label #${numericId} -> [${match.category}] ${obj.name} (ID: ${obj.id})`);

      // 1. Highlight sáng cấu kiện trên 3D View
      viewerRef.setSelection(
        {
          modelObjectIds: [
            {
              modelId: obj.modelId,
              objectRuntimeIds: [obj.id],
            },
          ],
        },
        "set"
      );

      // 2. Highlight thẻ tương ứng trong checklist ở thanh bên và cuộn tới đó
      highlightPreviewItem(obj.id);

      // 3. Cập nhật thông báo trạng thái
      const catLabel = CATEGORY_LABELS_VI[match.category] || "CẤU KIỆN";
      const statusText = document.getElementById("label-status-text");
      if (statusText) {
        statusText.textContent = `🎯 Đã chọn [${catLabel}]: ${match.text} (ID: ${obj.id})`;
      }
      break;
    }
  }
}

/**
 * Làm nổi bật thẻ tương ứng trong checklist
 */
function highlightPreviewItem(objectId) {
  const container = document.getElementById("label-preview-list");
  if (!container) return;

  container.querySelectorAll(".label-preview-item").forEach((el) => {
    el.classList.remove("active-selected");
  });

  const targetEl = container.querySelector(`.label-preview-item[data-object-id="${objectId}"]`);
  if (targetEl) {
    targetEl.classList.add("active-selected");
    targetEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

/**
 * Hiển thị thẻ label cho danh sách objects
 */
export async function showLabelsForObjects(objects, field) {
  if (!viewerRef) {
    console.warn("[LabelManager] Viewer reference not ready");
    return;
  }

  // Đặt lại cờ dừng tải
  isLabelLoadingCancelled = false;
  isLabelLoadingActive = true;
  showStopButton(true);

  // Quét cấu kiện nếu chưa có
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
    showStopButton(false);
    isLabelLoadingActive = false;
    return;
  }

  currentLabelField = field || currentLabelField;

  // 1. Lọc theo Scope (Phạm vi)
  if (labelScope === "selected") {
    targetObjects = getSelectedObjects();
    if (!targetObjects || targetObjects.length === 0) {
      targetObjects = getAllObjects();
    }
  } else if (labelScope === "visible") {
    targetObjects = getFilteredObjects();
    if (!targetObjects || targetObjects.length === 0) {
      targetObjects = getAllObjects();
    }
  }

  // 2. Lọc theo Loại Cấu Kiện (Category Filter)
  if (labelCategory === "structural") {
    // Khung kết cấu chính: Dầm, Cột, Thanh kết cấu (Member), Giằng
    targetObjects = targetObjects.filter((o) => {
      const cat = classifyObjectCategory(o);
      return cat === "beam" || cat === "column" || cat === "member";
    });
  } else if (labelCategory === "beam") {
    targetObjects = targetObjects.filter((o) => {
      return classifyObjectCategory(o) === "beam" || Boolean(o.ifcBeamType);
    });
  } else if (labelCategory === "column") {
    targetObjects = targetObjects.filter((o) => {
      return classifyObjectCategory(o) === "column" || Boolean(o.ifcColumnType);
    });
  } else if (labelCategory === "plate") {
    targetObjects = targetObjects.filter((o) => {
      return classifyObjectCategory(o) === "plate" || Boolean(o.ifcPlateType);
    });
  } else if (labelCategory === "fastener") {
    targetObjects = targetObjects.filter((o) => {
      return classifyObjectCategory(o) === "fastener" || Boolean(o.ifcFastenerType);
    });
  }
  // MẶC ĐỊNH ("all"): GIỮ NGUYÊN 100% CẤU KIỆN, KHÔNG BỎ QUA BẤT KỲ CẤU KIỆN NÀO!

  // 3. Sắp xếp ưu tiên theo Vai trò Kết cấu (Structural Priority)
  // ĐẢM BẢO: Dầm & Cột luôn được render đầu tiên trên toàn bộ chiều cao (từ tầng dưới lên đỉnh)
  targetObjects.sort((a, b) => {
    const catA = classifyObjectCategory(a);
    const catB = classifyObjectCategory(b);
    const prioA = CATEGORY_PRIORITY[catA] || 99;
    const prioB = CATEGORY_PRIORITY[catB] || 99;
    if (prioA !== prioB) return prioA - prioB;

    // Cấu kiện lớn/nặng hơn được ưu tiên trước
    const volA = a.volume || a.weight || 0;
    const volB = b.volume || b.weight || 0;
    return volB - volA;
  });

  const totalMatchingObjects = targetObjects.length;

  // 4. Giới hạn số lượng & Bảo vệ WebGL chống sập trên mô hình siêu lớn (ví dụ 50,000 cấu kiện)
  const SAFE_WEBGL_MAX = 3000;
  if (labelLimit > 0 && targetObjects.length > labelLimit) {
    pendingObjectsToStream = [];
    targetObjects = targetObjects.slice(0, labelLimit);
    console.log(`[LabelManager] Áp dụng giới hạn: ${labelLimit} / ${totalMatchingObjects} cấu kiện`);
  } else if (labelLimit === 0 && targetObjects.length > SAFE_WEBGL_MAX) {
    // Tự động bật WebGL Safe Guard: Giới hạn an toàn 3,000 cấu kiện kết cấu quan trọng nhất
    pendingObjectsToStream = targetObjects.slice(SAFE_WEBGL_MAX);
    targetObjects = targetObjects.slice(0, SAFE_WEBGL_MAX);
    console.log(`[LabelManager] 🛡️ Kích hoạt WebGL Safe Guard: Hiển thị trước ${SAFE_WEBGL_MAX} cấu kiện kết cấu ưu tiên cao nhất trong tổng số ${totalMatchingObjects} cấu kiện.`);
  } else {
    pendingObjectsToStream = [];
  }

  // Xóa labels cũ trước khi vẽ lại
  await clearLabelsSilent();

  updateUIState(0, `Đang định vị tọa độ ${targetObjects.length} cấu kiện...`);
  showProgressBar(true, 0);

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
    if (isLabelLoadingCancelled) break;

    const objectIds = modelObjects.map((o) => o.id);
    const bboxMap = new Map();
    const posMap = new Map();
    const collectedBoxes = [];

    // Query bounding boxes theo batch lớn (200 ids) với concurrency 4 để tăng tốc gấp 10 lần
    const CHUNK_QUERY_SIZE = 200;
    const BBOX_CONCURRENCY = 4;
    for (let i = 0; i < objectIds.length; i += CHUNK_QUERY_SIZE * BBOX_CONCURRENCY) {
      if (isLabelLoadingCancelled) break;
      const promises = [];
      for (let c = 0; c < BBOX_CONCURRENCY; c++) {
        const start = i + c * CHUNK_QUERY_SIZE;
        if (start >= objectIds.length) break;
        const batchIds = objectIds.slice(start, start + CHUNK_QUERY_SIZE);
        promises.push(
          viewerRef.getObjectBoundingBoxes(modelId, batchIds).catch((err) => {
            console.warn(`[LabelManager] Batch getObjectBoundingBoxes [${start}..] lỗi:`, err);
            return null;
          })
        );
      }
      const results = await Promise.all(promises);
      for (const bboxes of results) {
        if (bboxes && Array.isArray(bboxes)) {
          for (const rawBox of bboxes) {
            const parsed = extractBoundingBox(rawBox);
            if (parsed && rawBox && rawBox.id !== undefined && rawBox.id !== null) {
              collectedBoxes.push(parsed);
              bboxMap.set(rawBox.id, parsed);
              bboxMap.set(Number(rawBox.id), parsed);
            }
          }
        }
      }
      const processed = Math.min(i + CHUNK_QUERY_SIZE * BBOX_CONCURRENCY, objectIds.length);
      const pct = Math.round((processed / objectIds.length) * 100);
      updateUIState(0, `Đang định vị 3D: ${processed.toLocaleString()} / ${objectIds.length.toLocaleString()} cấu kiện (${pct}%)...`);
      await new Promise((r) => setTimeout(r, 0));
    }

    // Fallback getObjectPositions nếu cấu kiện chưa có bounding box (chỉ query số lượng hợp lý)
    const missingIds = objectIds.filter(
      (id) => !bboxMap.has(id) && !bboxMap.has(Number(id))
    );
    if (missingIds.length > 0 && missingIds.length < 2000 && typeof viewerRef.getObjectPositions === "function" && !isLabelLoadingCancelled) {
      for (let m = 0; m < missingIds.length; m += 200) {
        if (isLabelLoadingCancelled) break;
        const subMissing = missingIds.slice(m, m + 200);
        try {
          const positions = await viewerRef.getObjectPositions(modelId, subMissing);
          if (positions && Array.isArray(positions)) {
            for (const p of positions) {
              if (p && p.position && p.id !== undefined) {
                posMap.set(p.id, p.position);
                posMap.set(Number(p.id), p.position);
              }
            }
          }
        } catch (posErr) {}
      }
    }

    // Tự động tính toán hệ số quy đổi đơn vị (mm -> mét)
    const unitScale = determineUnitScaleFactor(collectedBoxes);

    // Kích thước chuẩn hiển thị icon sprite trên 3D (PointIcon.size)
    const baseQuadSize = Math.max(38, Math.round(92 * Number(labelConfig.scale || 1.0)));

    // Chuẩn bị PointIcon cho từng object
    for (let i = 0; i < modelObjects.length; i++) {
      if (isLabelLoadingCancelled) break;
      const obj = modelObjects[i];
      const bbox = bboxMap.get(obj.id) || bboxMap.get(Number(obj.id));
      const posFallback = posMap.get(obj.id) || posMap.get(Number(obj.id));

      if (!bbox && !posFallback) continue; // Không tìm thấy tọa độ

      const category = classifyObjectCategory(obj);

      // Tọa độ tính toán (mét)
      let centerX, centerY, targetZ;

      if (labelConfig.anchorPos === "centroid") {
        // Chế độ bám tâm 3D cấu kiện
        if (bbox) {
          centerX = ((bbox.min.x + bbox.max.x) / 2) * unitScale;
          centerY = ((bbox.min.y + bbox.max.y) / 2) * unitScale;
          targetZ = ((bbox.min.z + bbox.max.z) / 2) * unitScale;
        } else {
          centerX = posFallback.x * unitScale;
          centerY = posFallback.y * unitScale;
          targetZ = posFallback.z * unitScale;
        }
      } else {
        // Chế độ bám đỉnh cấu kiện (Top Surface + Chân kim)
        if (bbox) {
          centerX = ((bbox.min.x + bbox.max.x) / 2) * unitScale;
          centerY = ((bbox.min.y + bbox.max.y) / 2) * unitScale;
          targetZ = (bbox.max.z * unitScale) + Number(labelConfig.zOffset || 0.0);
        } else {
          centerX = posFallback.x * unitScale;
          centerY = posFallback.y * unitScale;
          targetZ = (posFallback.z * unitScale) + Number(labelConfig.zOffset || 0.0);
        }
      }

      // Lấy chuỗi hiển thị
      const { text: labelText, subText, isFallback } = getFormattedLabelText(obj, currentLabelField);
      if (!labelText) continue;

      // Sinh URL icon (Dùng cache để tiết kiệm RAM & Texture WebGL)
      const effectiveColor = (labelConfig.colorByCategory && CATEGORY_COLORS[category])
        ? CATEGORY_COLORS[category]
        : labelConfig.bgColor;

      const cacheKey = `${labelText}__${subText || ""}__${labelConfig.badgeMode}__${effectiveColor}__${labelConfig.scale}__${category}`;
      let badgeData = canvasCache.get(cacheKey);

      if (!badgeData) {
        if (labelConfig.badgeMode === "pinMarker") {
          badgeData = createPinMarkerCanvas(effectiveColor, iconSymbol);
        } else {
          badgeData = createLabelBadgeCanvas(labelText, iconSymbol, subText, category);
        }
        canvasCache.set(cacheKey, badgeData);
      }

      // PointIcon ID BẮT BUỘC là NUMBER trong Trimble Connect API
      const numericId = globalIconIdCounter++;

      // Kích thước sprite quad tỉ lệ theo squareSize để giữ nguyên cỡ chữ & không bao giờ bị cắt xén
      const iconSize = Math.max(38, Math.round(baseQuadSize * (badgeData.squareSize / 256)));

      const pointIcon = {
        id: numericId,
        iconPath: badgeData.dataUrl,
        size: iconSize,
        position: { x: centerX, y: centerY, z: targetZ },
        icon: badgeData.dataUrl,
        image: badgeData.dataUrl,
        label: labelText,
        text: buildTooltipText(obj),
      };

      allIcons.push(pointIcon);

      successfulLabeled.push({
        obj,
        text: labelText,
        subText,
        position: pointIcon.position,
        iconId: numericId,
        isFallback,
        category,
      });
    }
  }

  // ══════════════════════════════════════════════════════════
  // TẢI TUẦN TỰ AN TOÀN (PROGRESSIVE STREAMING LOADER)
  // Đưa icons vào viewer theo từng mẩu (40 icons/khung hình)
  // và nhường quyền điều khiển cho trình duyệt (yield 16ms)
  // -> Ngăn chặn 100% tình trạng văng tab (out-of-memory) và lag đơ!
  // ══════════════════════════════════════════════════════════
  if (allIcons.length > 0 && !isLabelLoadingCancelled) {
    const ADD_CHUNK_SIZE = 40;
    let addedCount = 0;

    for (let c = 0; c < allIcons.length; c += ADD_CHUNK_SIZE) {
      if (isLabelLoadingCancelled) {
        console.log(`[LabelManager] Người dùng đã dừng tải tại ${addedCount} nhãn.`);
        break;
      }

      const chunk = allIcons.slice(c, c + ADD_CHUNK_SIZE);
      try {
        await viewerRef.addIcon(chunk);
        addedCount += chunk.length;
      } catch (chunkErr) {
        for (const icon of chunk) {
          if (isLabelLoadingCancelled) break;
          try {
            await viewerRef.addIcon(icon);
            addedCount++;
          } catch (singleErr) {}
        }
      }

      // Cập nhật thanh tiến trình
      const pct = Math.round((addedCount / allIcons.length) * 100);
      showProgressBar(true, pct);
      updateUIState(addedCount, `Đang tải: ${addedCount.toLocaleString()} / ${allIcons.length.toLocaleString()} nhãn (${pct}%)...`, totalMatchingObjects);

      // Nhường quyền cho browser event loop để UI mượt mà 60fps và Three.js render frame
      await new Promise((r) => setTimeout(r, 16));
    }

    labelsVisible = addedCount > 0;
    labeledObjects = successfulLabeled.slice(0, addedCount);
    activeIconCount = addedCount;

    console.log(`[LabelManager] ✓ Hoàn tất gắn ${addedCount} thẻ label 3D (Field: ${currentLabelField})`);
    updateUIState(labeledObjects.length, null, totalMatchingObjects);
    renderPreviewList();
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

  showProgressBar(false);
  showStopButton(false);
  isLabelLoadingActive = false;
  renderPreviewList();
}

/**
 * Hiển thị / Ẩn thanh tiến trình tải nhãn
 */
function showProgressBar(show, percent = 0) {
  const container = document.getElementById("label-progress-container");
  const fill = document.getElementById("label-progress-fill");
  if (!container || !fill) return;

  if (show) {
    container.style.display = "block";
    fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  } else {
    container.style.display = "none";
    fill.style.width = "0%";
  }
}

/**
 * Hiển thị / Ẩn nút Dừng tải
 */
function showStopButton(show) {
  const stopBtn = document.getElementById("btn-stop-labels");
  const showBtn = document.getElementById("btn-show-labels");
  if (stopBtn) stopBtn.style.display = show ? "inline-flex" : "none";
  if (showBtn) showBtn.style.display = show ? "none" : "inline-flex";
}

/**
 * Dừng quá trình tải nhãn
 */
export function stopLabelLoading() {
  if (isLabelLoadingActive) {
    isLabelLoadingCancelled = true;
    console.log("[LabelManager] Yêu cầu dừng tải nhãn được kích hoạt.");
    showStopButton(false);
  }
}

/**
 * Xóa toàn bộ thẻ label 3D
 */
export async function clearLabels() {
  isLabelLoadingCancelled = true;
  await clearLabelsSilent();
  updateUIState(0);
  renderPreviewList();
  showProgressBar(false);
  showStopButton(false);
  console.log("[LabelManager] Đã xóa toàn bộ labels");
}

/**
 * Xóa labels nội bộ không cập nhật lại UI
 */
async function clearLabelsSilent() {
  if (!viewerRef) return;

  try {
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
    objects = getAllObjects();
  }

  await showLabelsForObjects(objects, currentLabelField);
}

/**
 * Định dạng giá trị hiển thị trên thẻ label kèm cơ chế fallback thông minh
 */
function getFormattedLabelText(obj, field) {
  if (!obj) return { text: null, subText: null, isFallback: false };

  let val = null;
  let sub = null;

  switch (field) {
    case "smartName": {
      val = obj.smartName || obj.ifcBeamType || obj.ifcMemberType || obj.ifcColumnType || obj.ifcPlateType || obj.ifcFastenerType || obj.ifcType || obj.profile || obj.fullName || obj.name;
      sub = obj.material || obj.assemblyPos || obj.ifcClass || "";
      break;
    }
    case "ifcBeamType": {
      val = obj.ifcBeamType || (obj.ifcClass && obj.ifcClass.toLowerCase().includes("beam") ? obj.ifcType || obj.profile : null);
      sub = obj.material || obj.name || "";
      break;
    }
    case "ifcMemberType": {
      val = obj.ifcMemberType || (obj.ifcClass && obj.ifcClass.toLowerCase().includes("member") ? obj.ifcType || obj.profile : null);
      sub = obj.material || obj.name || "";
      break;
    }
    case "ifcColumnType": {
      val = obj.ifcColumnType || (obj.ifcClass && obj.ifcClass.toLowerCase().includes("column") ? obj.ifcType || obj.profile : null);
      sub = obj.material || obj.name || "";
      break;
    }
    case "ifcPlateType": {
      val = obj.ifcPlateType || (obj.ifcClass && obj.ifcClass.toLowerCase().includes("plate") ? obj.ifcType || obj.profile : null);
      sub = obj.material || obj.name || "";
      break;
    }
    case "productName": {
      val = obj.productName || obj.name;
      sub = obj.ifcType || obj.profile || obj.material || "";
      break;
    }
    case "productObjectType": {
      val = obj.productObjectType || obj.type || obj.ifcClass;
      sub = obj.name || obj.ifcType || "";
      break;
    }
    case "ifcType": {
      val = obj.ifcType || obj.ifcBeamType || obj.ifcMemberType || obj.ifcColumnType || obj.ifcPlateType || obj.typeName || obj.profile;
      sub = obj.material || obj.name || "";
      break;
    }
    case "profile": {
      val = obj.profile || obj.ifcType || obj.ifcBeamType || obj.ifcMemberType;
      sub = obj.material || obj.name || "";
      break;
    }
    case "name": {
      val = obj.name || obj.productName;
      sub = obj.ifcType || obj.profile || obj.material || "";
      break;
    }
    case "material": {
      val = obj.material;
      sub = obj.ifcType || obj.name || obj.profile || "";
      break;
    }
    case "modelName": {
      val = obj.modelName || obj.fileName;
      sub = obj.name || obj.ifcType || "";
      break;
    }
    case "weight": {
      const w = obj.weight || obj.netWeight || obj.grossWeight || 0;
      if (w > 0) {
        val = w >= 1000 ? `${(w / 1000).toFixed(2)} tấn` : `${w.toFixed(1)} kg`;
      }
      sub = obj.name || obj.ifcType || "";
      break;
    }
    case "volume": {
      const v = obj.volume || obj.netVolume || obj.grossVolume || 0;
      if (v > 0) val = `${v.toFixed(3)} m³`;
      sub = obj.name || obj.ifcType || "";
      break;
    }
    case "area": {
      const a = obj.area || obj.grossArea || obj.netArea || 0;
      if (a > 0) val = `${a.toFixed(2)} m²`;
      sub = obj.name || obj.ifcType || "";
      break;
    }
    case "length": {
      const l = obj.length || 0;
      if (l > 0) val = `${Math.round(l * 1000)} mm`;
      sub = obj.name || obj.ifcType || "";
      break;
    }
    case "assemblyName": {
      const v = obj.assemblyName || obj.assembly;
      if (v && v !== "(Không xác định)") val = String(v);
      sub = obj.assemblyPos || obj.name || "";
      break;
    }
    case "assemblyPos": {
      const v = obj.assemblyPos;
      if (v && v !== "(Không xác định)") val = String(v);
      sub = obj.assemblyName || obj.name || "";
      break;
    }
    case "assemblyPosCode": {
      const v = obj.assemblyPosCode;
      if (v && v !== "(Không xác định)") val = String(v);
      sub = obj.assemblyName || obj.name || "";
      break;
    }
    default: {
      let v = obj[field];
      if (v === undefined || v === null || v === "" || v === "(Không xác định)") {
        if (obj.rawProperties) {
          v = obj.rawProperties[field];
          if (v === undefined) {
            const fieldLower = field.toLowerCase();
            for (const [k, valProp] of Object.entries(obj.rawProperties)) {
              if (k.toLowerCase() === fieldLower || k.toLowerCase().endsWith(`.${fieldLower}`)) {
                v = valProp;
                break;
              }
            }
          }
        }
      }
      if (v !== undefined && v !== null && v !== "" && v !== "(Không xác định)") {
        val = String(v);
      }
      sub = obj.name || obj.ifcType || "";
      break;
    }
  }

  // Nếu có giá trị thực
  if (val && String(val).trim() && val !== "(Không xác định)") {
    return {
      text: String(val).trim(),
      subText: sub && String(sub).trim() && sub !== "(Không xác định)" ? String(sub).trim() : null,
      isFallback: false,
    };
  }

  // Cơ chế Fallback: Nếu trường trống và bật fallbackToName
  if (labelConfig.fallbackToName) {
    const fallbackVal =
      obj.smartName ||
      obj.ifcBeamType ||
      obj.ifcMemberType ||
      obj.ifcColumnType ||
      obj.ifcPlateType ||
      obj.ifcType ||
      obj.name ||
      obj.productName ||
      obj.profile ||
      obj.assemblyPos ||
      (obj.ifcClass ? `${obj.ifcClass} #${obj.id}` : `Object #${obj.id}`);
    const fallbackSub = obj.material || obj.profile || obj.ifcClass || "";
    return {
      text: String(fallbackVal).trim(),
      subText: fallbackSub && String(fallbackSub).trim() ? String(fallbackSub).trim() : null,
      isFallback: true,
    };
  }

  return { text: null, subText: null, isFallback: false };
}

/**
 * Tạo tooltip chi tiết khi hover chuột lên thẻ label
 */
function buildTooltipText(obj) {
  const parts = [];
  if (obj.name) parts.push(`Tên: ${obj.name}`);
  if (obj.ifcType) parts.push(`Type: ${obj.ifcType}`);
  if (obj.profile) parts.push(`Profile: ${obj.profile}`);
  if (obj.material) parts.push(`Vật liệu: ${obj.material}`);
  if (obj.assemblyName) parts.push(`Assembly: ${obj.assemblyName}`);
  if (obj.assemblyPos) parts.push(`Pos: ${obj.assemblyPos}`);
  if (obj.ifcClass) parts.push(`IFC: ${obj.ifcClass}`);
  if (obj.modelName) parts.push(`File: ${obj.modelName}`);

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

  const iconSymbol = FIELD_ICONS[currentLabelField] || "🏷️";
  let sampleMain = "BEAM [HSS400X400X16]";
  let sampleSub = "STEEL/A572-GR.50";

  switch (currentLabelField) {
    case "smartName":
      sampleMain = "BEAM [HSS400X400X16]";
      sampleSub = "STEEL/A572-GR.50";
      break;
    case "ifcType":
      sampleMain = "HSS400X400X16";
      sampleSub = "STEEL/A572-GR.50";
      break;
    case "profile":
      sampleMain = "HSS400X400X16";
      sampleSub = "STEEL/A572-GR.50";
      break;
    case "material":
      sampleMain = "STEEL/A572-GR.50";
      sampleSub = "HSS400X400X16";
      break;
    case "name":
      sampleMain = "BEAM #105";
      sampleSub = "HSS400X400X16";
      break;
    case "assemblyName":
      sampleMain = "B101";
      sampleSub = "ASSEMBLY_B101";
      break;
    case "weight":
      sampleMain = "1.45 tấn";
      sampleSub = "BEAM [HSS400]";
      break;
    default: {
      const fieldOpt = LABEL_FIELD_OPTIONS.find((o) => o.value === currentLabelField);
      sampleMain = fieldOpt ? `Mẫu: ${fieldOpt.label.split(" ")[1] || "Cấu kiện"}` : "Mẫu Nhãn Cấu Kiện";
      break;
    }
  }

  if (labelConfig.addCategoryPrefix) {
    sampleMain = `[DẦM] ${sampleMain}`;
  }

  if (sampleIcon) {
    sampleIcon.textContent = iconSymbol;
    sampleIcon.style.display = labelConfig.showIcon ? "inline" : "none";
  }

  if (sampleText) {
    if (labelConfig.badgeMode === "card2Line") {
      sampleText.innerHTML = `<span style="font-weight:bold;">${escapeHtml(sampleMain)}</span><br><span style="font-size:0.8em;opacity:0.85;">${escapeHtml(sampleSub)}</span>`;
    } else {
      sampleText.textContent = sampleMain;
    }
  }

  const effectiveColor = labelConfig.colorByCategory ? CATEGORY_COLORS.beam : labelConfig.bgColor;

  sampleBadge.style.backgroundColor = hexToRgba(effectiveColor, labelConfig.opacity);
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
      labelConfig.zOffset = parseFloat(e.target.value) || 0.0;
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
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Anchor Pos Select
  const anchorPosSelect = document.getElementById("cfg-anchor-pos");
  if (anchorPosSelect) {
    anchorPosSelect.addEventListener("change", (e) => {
      labelConfig.anchorPos = e.target.value;
      debounceAutoApply();
    });
  }

  // Checkbox Color by Category
  const colorByCatChk = document.getElementById("cfg-color-by-category");
  if (colorByCatChk) {
    colorByCatChk.addEventListener("change", (e) => {
      labelConfig.colorByCategory = e.target.checked;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Checkbox Category Prefix
  const catPrefixChk = document.getElementById("cfg-category-prefix");
  if (catPrefixChk) {
    catPrefixChk.addEventListener("change", (e) => {
      labelConfig.addCategoryPrefix = e.target.checked;
      updateLivePreview();
      debounceAutoApply();
    });
  }

  // Checkbox Click to Select
  const clickToSelectChk = document.getElementById("cfg-click-to-select");
  if (clickToSelectChk) {
    clickToSelectChk.addEventListener("change", (e) => {
      labelConfig.clickToSelect = e.target.checked;
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
      if (anchorPosSelect) anchorPosSelect.value = labelConfig.anchorPos;
      if (colorByCatChk) colorByCatChk.checked = labelConfig.colorByCategory;
      if (catPrefixChk) catPrefixChk.checked = labelConfig.addCategoryPrefix;
      if (clickToSelectChk) clickToSelectChk.checked = labelConfig.clickToSelect;
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

  // Nút Dừng Tải
  const stopBtn = document.getElementById("btn-stop-labels");
  if (stopBtn) {
    stopBtn.addEventListener("click", () => stopLabelLoading());
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

  // Dropdown chọn phạm vi áp dụng (all, selected, visible)
  const scopeSelect = document.getElementById("label-scope-select");
  if (scopeSelect) {
    scopeSelect.addEventListener("change", (e) => {
      labelScope = e.target.value;
      if (labelsVisible) {
        applyLabels();
      }
    });
  }

  // Dropdown chọn loại cấu kiện (Category Filter)
  const categorySelect = document.getElementById("label-category-select");
  if (categorySelect) {
    categorySelect.addEventListener("change", (e) => {
      labelCategory = e.target.value;
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
function updateUIState(count = 0, customMessage = null, totalAvailable = 0) {
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
    if (statusText) {
      if (labelLimit > 0 && totalAvailable > labelLimit) {
        statusText.textContent = `Đang hiển thị ${count} / ${totalAvailable} (${fieldTitle}). Chọn "Toàn bộ" ở mục Tối đa để hiện 100%!`;
      } else {
        statusText.textContent = `Đang hiển thị trên 3D: ${fieldTitle} (${count} cấu kiện)`;
      }
    }
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

  if (pendingObjectsToStream.length > 0) {
    html += `
      <div class="webgl-safe-banner" style="background: rgba(37, 99, 235, 0.16); border: 1px solid #3B82F6; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap: 8px;">
          <div>
            <div style="font-weight: 600; color: #60A5FA; font-size: 12px;">🛡️ Tự động bảo vệ WebGL (Mô hình lớn)</div>
            <div style="color: #CBD5E1; font-size: 11px; margin-top: 2px;">
              Đang hiển thị <strong>${labeledObjects.length.toLocaleString()}</strong> cấu kiện kết cấu chính. Còn lại <strong>${pendingObjectsToStream.length.toLocaleString()}</strong> cấu kiện phụ.
            </div>
          </div>
          <button id="btn-load-more-labels" style="background:#2563EB; color:#fff; border:none; padding:6px 12px; border-radius:6px; font-weight:600; font-size:11px; cursor:pointer; white-space:nowrap;">
            ➕ Tải thêm +1,000
          </button>
        </div>
      </div>
    `;
  }

  labeledObjects.slice(0, 200).forEach((item, idx) => {
    const obj = item.obj;
    const name = obj.fullName || obj.name || (obj.ifcType ? `${obj.ifcType}` : `Object #${obj.id}`);
    const val = item.text;
    const sub = item.subText;
    const modelId = obj.modelId;
    const id = obj.id;
    const category = item.category || classifyObjectCategory(obj);
    const catColor = (labelConfig.colorByCategory && CATEGORY_COLORS[category])
      ? CATEGORY_COLORS[category]
      : labelConfig.bgColor;
    const catLabel = CATEGORY_LABELS_VI[category] || "CẤU KIỆN";

    const fallbackBadge = item.isFallback
      ? '<span class="label-fallback-indicator" title="Giá trị tự động thay thế bằng Tên/Type cấu kiện do trường được chọn bị trống">Tên</span>'
      : "";

    html += `
      <div class="label-preview-item" data-model-id="${modelId}" data-object-id="${id}" title="Nhấp để định vị &amp; chọn cấu kiện này trong 3D View">
        <span class="label-preview-num">${idx + 1}</span>
        <div class="label-preview-info">
          <div class="label-preview-title">
            <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${catColor}; margin-right:4px;"></span>
            ${escapeHtml(name)}
          </div>
          <div class="label-preview-sub">ID: ${id} | [${catLabel}] ${escapeHtml(obj.ifcClass || "IFC")}${sub ? " | " + escapeHtml(sub) : ""}</div>
        </div>
        <div class="label-preview-right">
          ${fallbackBadge}
          <span class="label-preview-tag" style="background:${hexToRgba(catColor, 0.22)}; color:${catColor}; border-color:${catColor}; font-weight:700;">${escapeHtml(val)}</span>
        </div>
      </div>
    `;
  });

  if (labeledObjects.length > 200) {
    html += `<div class="label-preview-more">...và ${labeledObjects.length - 200} cấu kiện khác</div>`;
  }

  container.innerHTML = html;

  // Gắn sự kiện click vào từng item để highlight / select VÀ zoom camera vào cấu kiện trong 3D
  container.querySelectorAll(".label-preview-item").forEach((el) => {
    el.addEventListener("click", async () => {
      const modelId = el.getAttribute("data-model-id");
      const objectId = parseInt(el.getAttribute("data-object-id"), 10);

      if (viewerRef && modelId && !isNaN(objectId)) {
        try {
          highlightPreviewItem(objectId);

          // Highlight cấu kiện trên 3D
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
            } catch (camErr) {}
          }
        } catch (e) {
          console.warn("[LabelManager] Set selection/camera failed:", e);
        }
      }
    });
  });

  // Gắn sự kiện nút Tải thêm +1,000 nhãn
  const loadMoreBtn = document.getElementById("btn-load-more-labels");
  if (loadMoreBtn) {
    loadMoreBtn.onclick = () => {
      loadMoreLabels(1000);
    };
  }
}

/**
 * Tải thêm nhãn cho các cấu kiện còn lại (theo từng mẩu 1,000 cấu kiện)
 * Dành cho mô hình siêu lớn (ví dụ 50,000 cấu kiện) để không bao giờ bị văng WebGL
 */
async function loadMoreLabels(batchCount = 1000) {
  if (!viewerRef || pendingObjectsToStream.length === 0 || isLabelLoadingActive) return;

  const nextBatch = pendingObjectsToStream.splice(0, batchCount);
  console.log(`[LabelManager] Tải thêm ${nextBatch.length} cấu kiện (còn lại: ${pendingObjectsToStream.length})...`);

  showProgressBar(true, 0);
  showStopButton(true);
  isLabelLoadingCancelled = false;
  isLabelLoadingActive = true;

  try {
    const byModel = new Map();
    for (const obj of nextBatch) {
      if (!obj || obj.id === undefined) continue;
      const modelId = obj.modelId;
      if (!byModel.has(modelId)) byModel.set(modelId, []);
      byModel.get(modelId).push(obj);
    }

    const additionalIcons = [];
    const successfulAdditional = [];
    const iconSymbol = FIELD_ICONS[currentLabelField] || "🏷️";
    const canvasCache = new Map();

    for (const [modelId, modelObjects] of byModel) {
      if (isLabelLoadingCancelled) break;
      const objectIds = modelObjects.map((o) => o.id);
      const bboxMap = new Map();
      const collectedBoxes = [];

      const CHUNK_QUERY_SIZE = 200;
      const BBOX_CONCURRENCY = 4;
      for (let i = 0; i < objectIds.length; i += CHUNK_QUERY_SIZE * BBOX_CONCURRENCY) {
        if (isLabelLoadingCancelled) break;
        const promises = [];
        for (let c = 0; c < BBOX_CONCURRENCY; c++) {
          const start = i + c * CHUNK_QUERY_SIZE;
          if (start >= objectIds.length) break;
          const batchIds = objectIds.slice(start, start + CHUNK_QUERY_SIZE);
          promises.push(
            viewerRef.getObjectBoundingBoxes(modelId, batchIds).catch(() => null)
          );
        }
        const results = await Promise.all(promises);
        for (const bboxes of results) {
          if (bboxes && Array.isArray(bboxes)) {
            for (const rawBox of bboxes) {
              const parsed = extractBoundingBox(rawBox);
              if (parsed && rawBox && rawBox.id !== undefined && rawBox.id !== null) {
                collectedBoxes.push(parsed);
                bboxMap.set(rawBox.id, parsed);
                bboxMap.set(Number(rawBox.id), parsed);
              }
            }
          }
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      const unitScale = determineUnitScaleFactor(collectedBoxes);
      const baseQuadSize = Math.max(38, Math.round(92 * Number(labelConfig.scale || 1.0)));

      for (let i = 0; i < modelObjects.length; i++) {
        if (isLabelLoadingCancelled) break;
        const obj = modelObjects[i];
        const bbox = bboxMap.get(obj.id) || bboxMap.get(Number(obj.id));
        if (!bbox) continue;

        const category = classifyObjectCategory(obj);
        const centerX = ((bbox.min.x + bbox.max.x) / 2) * unitScale;
        const centerY = ((bbox.min.y + bbox.max.y) / 2) * unitScale;
        const targetZ = labelConfig.anchorPos === "centroid"
          ? (((bbox.min.z + bbox.max.z) / 2) * unitScale)
          : ((bbox.max.z * unitScale) + Number(labelConfig.zOffset || 0.0));

        const { text: labelText, subText, isFallback } = getFormattedLabelText(obj, currentLabelField);
        if (!labelText) continue;

        const effectiveColor = (labelConfig.colorByCategory && CATEGORY_COLORS[category])
          ? CATEGORY_COLORS[category]
          : labelConfig.bgColor;

        const cacheKey = `${labelText}__${subText || ""}__${labelConfig.badgeMode}__${effectiveColor}__${labelConfig.scale}__${category}`;
        let badgeData = canvasCache.get(cacheKey);
        if (!badgeData) {
          if (labelConfig.badgeMode === "pinMarker") {
            badgeData = createPinMarkerCanvas(effectiveColor, iconSymbol);
          } else {
            badgeData = createLabelBadgeCanvas(labelText, iconSymbol, subText, category);
          }
          canvasCache.set(cacheKey, badgeData);
        }

        const numericId = globalIconIdCounter++;
        const iconSize = Math.max(38, Math.round(baseQuadSize * (badgeData.squareSize / 256)));

        const pointIcon = {
          id: numericId,
          iconPath: badgeData.dataUrl,
          size: iconSize,
          position: { x: centerX, y: centerY, z: targetZ },
          icon: badgeData.dataUrl,
          image: badgeData.dataUrl,
          label: labelText,
          text: buildTooltipText(obj),
        };

        additionalIcons.push(pointIcon);
        successfulAdditional.push({
          obj,
          text: labelText,
          subText,
          position: pointIcon.position,
          iconId: numericId,
          isFallback,
          category,
        });
      }
    }

    const ADD_CHUNK_SIZE = 40;
    for (let c = 0; c < additionalIcons.length; c += ADD_CHUNK_SIZE) {
      if (isLabelLoadingCancelled) break;
      const chunk = additionalIcons.slice(c, c + ADD_CHUNK_SIZE);
      try {
        await viewerRef.addIcon(chunk);
      } catch (err) {
        for (const icon of chunk) {
          try { await viewerRef.addIcon(icon); } catch (e) {}
        }
      }
      await new Promise((r) => setTimeout(r, 16));
    }

    labeledObjects.push(...successfulAdditional);
    activeIconCount = labeledObjects.length;
    updateUIState(labeledObjects.length, null, labeledObjects.length + pendingObjectsToStream.length);
    renderPreviewList();
  } catch (err) {
    console.error("[LabelManager] Lỗi khi tải thêm nhãn:", err);
  } finally {
    isLabelLoadingActive = false;
    showProgressBar(false);
    showStopButton(false);
  }
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
