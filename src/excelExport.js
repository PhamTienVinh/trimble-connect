/**
 * excelExport.js - Excel Export Utility using SheetJS (xlsx)
 * Creates formatted .xlsx file with statistics data.
 * Supports dynamic grouping based on user selection.
 * Includes Group and Material columns.
 */

import * as XLSX from "xlsx";

/**
 * Export statistics data to an Excel file
 * @param {Array} data - Array of objects with name, assembly, type, group, material, volume, weight
 * @param {Object} meta - Metadata: density, totalVolume, totalWeight, projectName, exportDate, groupByField, groupedData, steelOnly
 * @returns {boolean} success
 */
export function exportToExcel(data, meta) {
  try {
    const wb = XLSX.utils.book_new();
    const steelLabel = meta.steelOnly ? "THÉP" : "CẤU KIỆN";

    // ========================
    // Sheet 1: Detailed Data
    // ========================

    const headerRows = [
      [`BẢNG THỐNG KÊ KHỐI LƯỢNG ${steelLabel}`],
      [""],
      ["Dự án:", meta.projectName || "Trimble Connect Project"],
      ["Ngày xuất:", meta.exportDate || new Date().toLocaleDateString("vi-VN")],
      [
        "Khối lượng riêng (kg/m³):",
        `${meta.density || 7850}`,
      ],
      [""],
      ["STT", "Tên cấu kiện", "Assembly", "Loại", "Group", "Vật liệu", "Thể tích (m³)", "Khối lượng (kg)"],
    ];

    const dataRows = data.map((obj, index) => [
      index + 1,
      obj.name,
      obj.assembly || "",
      obj.type || "",
      obj.group || "",
      obj.material || "",
      parseFloat(obj.volume.toFixed(6)),
      parseFloat(obj.weight.toFixed(2)),
    ]);

    const totalVolume = data.reduce((s, o) => s + o.volume, 0);
    const totalWeight = data.reduce((s, o) => s + o.weight, 0);

    const summaryRows = [
      [],
      [
        "",
        "TỔNG CỘNG",
        "",
        `${data.length} cấu kiện`,
        "",
        "",
        parseFloat(totalVolume.toFixed(6)),
        parseFloat(totalWeight.toFixed(2)),
      ],
    ];

    const allRows = [...headerRows, ...dataRows, ...summaryRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    ws["!cols"] = [
      { wch: 5 },   // STT
      { wch: 28 },  // Tên cấu kiện
      { wch: 18 },  // Assembly
      { wch: 14 },  // Loại
      { wch: 18 },  // Group
      { wch: 16 },  // Vật liệu
      { wch: 16 },  // Thể tích
      { wch: 16 },  // Khối lượng
    ];

    ws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Chi tiết");

    // ========================
    // Sheet 2: Summary by Assembly
    // ========================

    const assemblyMap = new Map();
    data.forEach((obj) => {
      const key = obj.assembly || "Không có Assembly";
      if (!assemblyMap.has(key)) {
        assemblyMap.set(key, { count: 0, volume: 0, weight: 0 });
      }
      const entry = assemblyMap.get(key);
      entry.count++;
      entry.volume += obj.volume;
      entry.weight += obj.weight;
    });

    const summaryHeader = [
      ["TỔNG HỢP THEO ASSEMBLY"],
      [""],
      ["STT", "Assembly", "Số lượng", "Tổng thể tích (m³)", "Tổng khối lượng (kg)"],
    ];

    const summaryData = [];
    let idx = 1;
    for (const [assembly, stats] of assemblyMap.entries()) {
      summaryData.push([
        idx++,
        assembly,
        stats.count,
        parseFloat(stats.volume.toFixed(6)),
        parseFloat(stats.weight.toFixed(2)),
      ]);
    }

    const summaryTotal = [
      [],
      [
        "",
        "TỔNG CỘNG",
        data.length,
        parseFloat(totalVolume.toFixed(6)),
        parseFloat(totalWeight.toFixed(2)),
      ],
    ];

    const ws2 = XLSX.utils.aoa_to_sheet([
      ...summaryHeader,
      ...summaryData,
      ...summaryTotal,
    ]);

    ws2["!cols"] = [
      { wch: 5 },
      { wch: 25 },
      { wch: 12 },
      { wch: 20 },
      { wch: 20 },
    ];

    ws2["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    ];

    XLSX.utils.book_append_sheet(wb, ws2, "TH Assembly");

    // ========================
    // Sheet 3: Summary by Type
    // ========================

    const typeMap = new Map();
    data.forEach((obj) => {
      const key = obj.type || "Không phân loại";
      if (!typeMap.has(key)) {
        typeMap.set(key, { count: 0, volume: 0, weight: 0 });
      }
      const entry = typeMap.get(key);
      entry.count++;
      entry.volume += obj.volume;
      entry.weight += obj.weight;
    });

    const typeHeader = [
      ["TỔNG HỢP THEO LOẠI CẤU KIỆN"],
      [""],
      ["STT", "Loại cấu kiện", "Số lượng", "Tổng thể tích (m³)", "Tổng khối lượng (kg)"],
    ];

    const typeData = [];
    let typeIdx = 1;
    for (const [type, stats] of typeMap.entries()) {
      typeData.push([
        typeIdx++,
        type,
        stats.count,
        parseFloat(stats.volume.toFixed(6)),
        parseFloat(stats.weight.toFixed(2)),
      ]);
    }

    const typeTotal = [
      [],
      [
        "",
        "TỔNG CỘNG",
        data.length,
        parseFloat(totalVolume.toFixed(6)),
        parseFloat(totalWeight.toFixed(2)),
      ],
    ];

    const ws3 = XLSX.utils.aoa_to_sheet([...typeHeader, ...typeData, ...typeTotal]);
    ws3["!cols"] = ws2["!cols"];
    ws3["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    ];

    XLSX.utils.book_append_sheet(wb, ws3, "TH Loại");

    // ========================
    // Sheet 4: Summary by Group
    // ========================

    const groupMap = new Map();
    data.forEach((obj) => {
      const key = obj.group || "Không có Group";
      if (!groupMap.has(key)) {
        groupMap.set(key, { count: 0, volume: 0, weight: 0 });
      }
      const entry = groupMap.get(key);
      entry.count++;
      entry.volume += obj.volume;
      entry.weight += obj.weight;
    });

    const groupHeader = [
      ["TỔNG HỢP THEO GROUP"],
      [""],
      ["STT", "Group", "Số lượng", "Tổng thể tích (m³)", "Tổng khối lượng (kg)"],
    ];

    const groupData = [];
    let groupIdx = 1;
    for (const [group, stats] of groupMap.entries()) {
      groupData.push([
        groupIdx++,
        group,
        stats.count,
        parseFloat(stats.volume.toFixed(6)),
        parseFloat(stats.weight.toFixed(2)),
      ]);
    }

    const groupTotal = [
      [],
      [
        "",
        "TỔNG CỘNG",
        data.length,
        parseFloat(totalVolume.toFixed(6)),
        parseFloat(totalWeight.toFixed(2)),
      ],
    ];

    const ws4 = XLSX.utils.aoa_to_sheet([...groupHeader, ...groupData, ...groupTotal]);
    ws4["!cols"] = ws2["!cols"];
    ws4["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    ];

    XLSX.utils.book_append_sheet(wb, ws4, "TH Group");

    // ========================
    // Sheet 5: Summary by Material
    // ========================

    const materialMap = new Map();
    data.forEach((obj) => {
      const key = obj.material || "Không rõ vật liệu";
      if (!materialMap.has(key)) {
        materialMap.set(key, { count: 0, volume: 0, weight: 0 });
      }
      const entry = materialMap.get(key);
      entry.count++;
      entry.volume += obj.volume;
      entry.weight += obj.weight;
    });

    const materialHeader = [
      ["TỔNG HỢP THEO VẬT LIỆU"],
      [""],
      ["STT", "Vật liệu", "Số lượng", "Tổng thể tích (m³)", "Tổng khối lượng (kg)"],
    ];

    const materialData = [];
    let matIdx = 1;
    for (const [material, stats] of materialMap.entries()) {
      materialData.push([
        matIdx++,
        material,
        stats.count,
        parseFloat(stats.volume.toFixed(6)),
        parseFloat(stats.weight.toFixed(2)),
      ]);
    }

    const materialTotal = [
      [],
      [
        "",
        "TỔNG CỘNG",
        data.length,
        parseFloat(totalVolume.toFixed(6)),
        parseFloat(totalWeight.toFixed(2)),
      ],
    ];

    const ws5 = XLSX.utils.aoa_to_sheet([...materialHeader, ...materialData, ...materialTotal]);
    ws5["!cols"] = ws2["!cols"];
    ws5["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    ];

    XLSX.utils.book_append_sheet(wb, ws5, "TH Vật liệu");

    // ========================
    // Sheet 6: Dynamic Group By (if user chose a specific group)
    // ========================

    if (meta.groupByField && meta.groupByField !== "none" && meta.groupedData) {
      const groupLabels = {
        name: "Tên cấu kiện",
        assembly: "Assembly",
        type: "Loại",
        group: "Group",
        material: "Vật liệu",
      };
      const groupLabel = groupLabels[meta.groupByField] || meta.groupByField;

      const dynHeader = [
        [`TỔNG HỢP THEO ${groupLabel.toUpperCase()}`],
        [""],
        ["STT", groupLabel, "Số lượng", "Tổng thể tích (m³)", "Tổng khối lượng (kg)"],
      ];

      const dynRows = [];
      let gIdx = 1;
      for (const [groupName, stats] of meta.groupedData.entries()) {
        dynRows.push([
          gIdx++,
          groupName,
          stats.count,
          parseFloat(stats.totalVolume.toFixed(6)),
          parseFloat(stats.totalWeight.toFixed(2)),
        ]);
      }

      const dynTotal = [
        [],
        [
          "",
          "TỔNG CỘNG",
          data.length,
          parseFloat(totalVolume.toFixed(6)),
          parseFloat(totalWeight.toFixed(2)),
        ],
      ];

      const ws6 = XLSX.utils.aoa_to_sheet([...dynHeader, ...dynRows, ...dynTotal]);
      ws6["!cols"] = ws2["!cols"];
      ws6["!merges"] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
      ];

      XLSX.utils.book_append_sheet(wb, ws6, `Nhóm ${groupLabel}`);
    }

    // ========================
    // Download
    // ========================

    const modeLabel = meta.steelOnly ? "Thep" : "CauKien";
    const fileName = `Thong_Ke_${modeLabel}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fileName);

    return true;
  } catch (error) {
    console.error("Excel export error:", error);
    return false;
  }
}
