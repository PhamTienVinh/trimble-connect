/**
 * excelExport.js — Export IFC object data to Excel (.xlsx)
 *
 * Multi-sheet workbook with:
 * - Tổng hợp: grouped summary by current filter
 * - Chi tiết: all object records with full columns (hierarchical grouping)
 * - Theo Assembly Pos: grouped by ASSEMBLY_NAME > ASSEMBLY_POS (hierarchical)
 * - Theo Assembly Name: grouped by ASSEMBLY_NAME > children
 * - Theo Assembly Code: grouped by ASSEMBLY_CODE > ASSEMBLY_NAME > children
 * - Assembly Hierarchy: full 3-level structure (CODE > NAME > POS > children)
 * - Theo Object Type: grouped by object type
 * - Theo Vật liệu: grouped by material
 */

import * as XLSX from "xlsx-js-style";

// ── Red pastel color styles ──
const border_thin = {
  top:{style:"thin",color:{rgb:"E6B8B7"}},
  bottom:{style:"thin",color:{rgb:"E6B8B7"}},
  left:{style:"thin",color:{rgb:"E6B8B7"}},
  right:{style:"thin",color:{rgb:"E6B8B7"}},
};
const S = {
  // Title: deep red, white bold text
  title:   { font:{bold:true,sz:14,color:{rgb:"FFFFFF"}}, fill:{fgColor:{rgb:"A93226"}}, alignment:{horizontal:"center"}, border:border_thin },
  // Column headers: medium dark red, white bold text
  header:  { font:{bold:true,sz:10,color:{rgb:"FFFFFF"}}, fill:{fgColor:{rgb:"C0392B"}}, alignment:{horizontal:"center"}, border:border_thin },
  // Group level 1 (Code): dark pastel red
  grp1:    { font:{bold:true,sz:10,color:{rgb:"6E2C00"}}, fill:{fgColor:{rgb:"F1948A"}}, border:border_thin },
  // Group level 2 (Name): medium pastel red
  grp2:    { font:{bold:true,sz:10,color:{rgb:"78281F"}}, fill:{fgColor:{rgb:"F5B7B1"}}, border:border_thin },
  // Group level 3 (Pos): light pastel red
  grp3:    { font:{bold:false,sz:10,italic:true,color:{rgb:"943126"}}, fill:{fgColor:{rgb:"FADBD8"}}, border:border_thin },
  // Data rows: white and very light rose alternating
  data:    { font:{sz:10}, fill:{fgColor:{rgb:"FFFFFF"}}, border:border_thin },
  dataAlt: { font:{sz:10}, fill:{fgColor:{rgb:"FBE9E7"}}, border:border_thin },
  // Footer/total: deep red like title
  footer:  { font:{bold:true,sz:10,color:{rgb:"FFFFFF"}}, fill:{fgColor:{rgb:"A93226"}}, border:border_thin },
  // Info subtitle
  info:    { font:{sz:10,italic:true,color:{rgb:"C0392B"}} },
  num:  { numFmt:"#,##0.000000" },
  num4: { numFmt:"#,##0.0000" },
  num2: { numFmt:"#,##0.00" },
};

function applyStyle(ws, row, col, style) {
  const addr = XLSX.utils.encode_cell({r:row,c:col});
  if (!ws[addr]) ws[addr] = {v:"",t:"s"};
  ws[addr].s = {...(ws[addr].s||{}), ...style};
}
function styleRow(ws, row, colCount, style) {
  for (let c=0;c<colCount;c++) applyStyle(ws,row,c,style);
}

/**
 * Export data to Excel file.
 * @param {Array} data - Array of object records
 * @param {string} groupBy - current grouping key
 * @param {boolean} selectedOnly - Whether exporting only selected items
 */
export function exportToExcel(data, groupBy, selectedOnly) {
  if (!data || data.length === 0) {
    console.warn("[ExcelExport] No data to export");
    return;
  }

  const wb = XLSX.utils.book_new();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString("vi-VN");

  // ── Sheet 1: Summary (Grouped by current filter) ──
  const groups = {};
  for (const obj of data) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = { count: 0, netVolume: 0, grossVolume: 0, netWeight: 0, grossWeight: 0, grossArea: 0, netArea: 0 };
    }
    groups[key].count++;
    groups[key].netVolume += obj.netVolume || obj.volume || 0;
    groups[key].grossVolume += obj.grossVolume || obj.volume || 0;
    groups[key].netWeight += obj.netWeight || obj.weight || 0;
    groups[key].grossWeight += obj.grossWeight || obj.weight || 0;
    groups[key].grossArea += obj.grossArea || obj.area || 0;
    groups[key].netArea += obj.netArea || 0;
  }

  const summaryHeader = [
    ["BÁO CÁO THỐNG KÊ ĐỐI TƯỢNG IFC"],
    [`Ngày xuất: ${dateStr} ${timeStr}`],
    [`Chế độ: ${selectedOnly ? "Đã chọn" : "Toàn bộ dự án"}`],
    [`Nhóm theo: ${getGroupLabel(groupBy)}`],
    [`Tổng số đối tượng: ${data.length}`],
    [],
    [getGroupLabel(groupBy), "Số lượng", "Thể tích Gross (m³)", "Thể tích Net (m³)", "DT bề mặt Gross (m²)", "DT Net (m²)", "Khối lượng Gross (kg)", "Khối lượng Net (kg)"],
  ];

  let totalNetVolume = 0, totalGrossVolume = 0;
  let totalNetWeight = 0, totalGrossWeight = 0;
  let totalGrossArea = 0, totalNetArea = 0;
  const summaryRows = [];

  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    totalNetVolume += g.netVolume;
    totalGrossVolume += g.grossVolume;
    totalNetWeight += g.netWeight;
    totalGrossWeight += g.grossWeight;
    totalGrossArea += g.grossArea;
    totalNetArea += g.netArea;
    summaryRows.push([
      key, 
      g.count, 
      r(g.grossVolume, 6), 
      r(g.netVolume, 6), 
      r(g.grossArea, 4), 
      r(g.netArea, 4), 
      r(g.grossWeight, 2), 
      r(g.netWeight, 2)
    ]);
  }
  summaryRows.push([]);
  summaryRows.push([
    "TỔNG CỘNG", 
    data.length, 
    r(totalGrossVolume, 6), 
    r(totalNetVolume, 6), 
    r(totalGrossArea, 4), 
    r(totalNetArea, 4), 
    r(totalGrossWeight, 2), 
    r(totalNetWeight, 2)
  ]);

  const wsSummary = XLSX.utils.aoa_to_sheet([...summaryHeader, ...summaryRows]);
  wsSummary["!cols"] = [
    { wch: 35 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 22 }
  ];
  wsSummary["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
  // Apply styling
  styleRow(wsSummary, 0, 8, S.title); // Title
  for (let i=1;i<5;i++) styleRow(wsSummary, i, 8, S.info); // Info rows
  styleRow(wsSummary, 6, 8, S.header); // Column headers
  const dataStart = 7;
  for (let i=0; i<summaryRows.length; i++) {
    const rowIdx = dataStart + i;
    if (summaryRows[i].length === 0) continue;
    if (summaryRows[i][0] === "TỔNG CỘNG") { styleRow(wsSummary, rowIdx, 8, S.footer); }
    else { styleRow(wsSummary, rowIdx, 8, i % 2 === 0 ? S.data : S.dataAlt); }
  }
  XLSX.utils.book_append_sheet(wb, wsSummary, "Tổng hợp");

  // ── Sheet 2: Detail (full columns) ──
  const detailHeader = [
    ["CHI TIẾT ĐỐI TƯỢNG IFC"],
    [`Ngày xuất: ${dateStr} | ${selectedOnly ? "Đã chọn" : "Toàn bộ"} | ${data.length} đối tượng`],
    [],
    [
      "STT", "Tên", "Profile", "Reference", "IFC Class", "Object Type",
      "Assembly Pos", "Assembly Name", "Assembly Code",
      "Group", "Vật liệu",
      "Thể tích Gross (m³)", "Thể tích Net (m³)", "DT bề mặt Gross (m²)", "DT Net (m²)", "Khối lượng Gross (kg)", "Khối lượng Net (kg)",
      "Bolt Standard", "Bolt Size", "Bolt Length", "Bolt Grade",
      "Bolt Count", "Nut Type", "Nut Count", "Washer Type", "Washer Count",
    ],
  ];

  // Sort data
  const sortedData = [...data].sort((a, b) => {
    const codeA = (a.assemblyPosCode || "zzz").toLowerCase();
    const codeB = (b.assemblyPosCode || "zzz").toLowerCase();
    if (codeA !== codeB) return codeA.localeCompare(codeB);
    const nameA = (a.assemblyName || "zzz").toLowerCase();
    const nameB = (b.assemblyName || "zzz").toLowerCase();
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    const posA = (a.assemblyPos || "zzz").toLowerCase();
    const posB = (b.assemblyPos || "zzz").toLowerCase();
    if (posA !== posB) return posA.localeCompare(posB);
    return (a.name || "").localeCompare(b.name || "");
  });

  const detailRows = [];
  let currentCode = null;
  let currentAsmName = null;
  let currentPos = null;
  let stt = 0;
  const mergeRows = []; // Track group header row indices for merging

  for (const obj of sortedData) {
    const code = obj.assemblyPosCode || "(Không có Assembly Code)";
    const asmName = obj.assemblyName || "(Không có Assembly Name)";
    const pos = obj.assemblyPos || "(Không có Assembly Pos)";

    // Level 1: Code
    if (code !== currentCode) {
      currentCode = code;
      currentAsmName = null;
      currentPos = null;
      detailRows.push([]);
      const headerRowIdx = detailHeader.length + detailRows.length;
      detailRows.push([`▶ ASSEMBLY CODE: ${code}`, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
      mergeRows.push(headerRowIdx);
    }

    // Level 2: Name
    if (asmName !== currentAsmName) {
      currentAsmName = asmName;
      currentPos = null;
      const headerRowIdx = detailHeader.length + detailRows.length;
      detailRows.push([`   ▸ ASSEMBLY NAME: ${asmName}`, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
      mergeRows.push(headerRowIdx);
    }

    // Level 3: Pos
    if (pos !== currentPos) {
      currentPos = pos;
      const headerRowIdx = detailHeader.length + detailRows.length;
      detailRows.push([`      ▹ ASSEMBLY POS: ${pos}`, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]);
      mergeRows.push(headerRowIdx);
    }

    stt++;
    detailRows.push([
      stt,
      obj.name || "",
      obj.profile || "",
      obj.referenceName || "",
      obj.ifcClass || "",
      obj.type || "",
      obj.assemblyPos || "",
      obj.assemblyName || "",
      obj.assemblyPosCode || "",
      obj.group || "",
      obj.material || "",
      r(obj.grossVolume || obj.volume || 0, 6),
      r(obj.netVolume || obj.volume || 0, 6),
      r(obj.grossArea || obj.area || 0, 4),
      r(obj.netArea || 0, 4),
      r(obj.grossWeight || obj.weight || 0, 2),
      r(obj.netWeight || obj.weight || 0, 2),
      obj.boltStandard || obj.boltFullName || "",
      obj.boltSize || "",
      obj.boltLength || "",
      obj.boltGrade || "",
      obj.boltCount || "",
      obj.nutType || "",
      obj.nutCount || "",
      obj.washerType || "",
      obj.washerCount || "",
    ]);
  }

  detailRows.push([]);
  detailRows.push([
    "", "TỔNG CỘNG", "", "", "", "", "", "", "", "", "",
    r(totalGrossVolume, 6), r(totalNetVolume, 6), r(totalGrossArea, 4), r(totalNetArea, 4), r(totalGrossWeight, 2), r(totalNetWeight, 2),
    "", "", "", "", "", "", "", "", "",
  ]);

  const wsDetail = XLSX.utils.aoa_to_sheet([...detailHeader, ...detailRows]);
  wsDetail["!cols"] = [
    { wch: 6 }, { wch: 28 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 22 },
    { wch: 18 }, { wch: 22 }, { wch: 18 },
    { wch: 18 }, { wch: 15 },
    { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 22 },
    { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 10 }, { wch: 15 }, { wch: 10 }, { wch: 15 }, { wch: 10 },
  ];

  const colCount = 25;
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: colCount } }];
  for (const rowIdx of mergeRows) {
    merges.push({ s: { r: rowIdx, c: 0 }, e: { r: rowIdx, c: colCount } });
  }
  wsDetail["!merges"] = merges;
  const CC = colCount + 1;
  styleRow(wsDetail, 0, CC, S.title);
  styleRow(wsDetail, 1, CC, S.info);
  styleRow(wsDetail, 3, CC, S.header);
  for (const rowIdx of mergeRows) {
    styleRow(wsDetail, rowIdx, CC, S.grp1);
  }
  const totalRowIdx = detailHeader.length + detailRows.length - 1;
  styleRow(wsDetail, totalRowIdx, CC, S.footer);
  XLSX.utils.book_append_sheet(wb, wsDetail, "Chi tiết");

  // ── Sheet 3-7: Grouped sheets for each category ──
  const groupSheets = [
    { key: "assemblyPos", label: "Assembly Pos", sheetName: "Theo Assembly Pos" },
    { key: "assemblyName", label: "Assembly Name", sheetName: "Theo Assembly Name" },
    { key: "assemblyPosCode", label: "Assembly Code", sheetName: "Theo Assembly Code" },
    { key: "objectType", label: "Object Type", sheetName: "Theo Object Type" },
    { key: "profile", label: "Profile", sheetName: "Theo Profile" },
    { key: "referenceName", label: "Reference Name", sheetName: "Theo Reference" },
    { key: "ifcClass", label: "IFC Class", sheetName: "Theo IFC Class" },
    { key: "name", label: "Tên", sheetName: "Theo Tên" },
    { key: "group", label: "Group", sheetName: "Theo Group" },
    { key: "material", label: "Vật liệu", sheetName: "Theo Vật liệu" },
  ];

  for (const gs of groupSheets) {
    if (gs.key === groupBy) continue;
    try {
      const ws = createGroupSheet(data, gs.key, gs.label);
      XLSX.utils.book_append_sheet(wb, ws, gs.sheetName);
    } catch (e) {
      console.warn(`[ExcelExport] Failed to create sheet "${gs.sheetName}":`, e);
    }
  }

  // ── Assembly Hierarchy sheet — full 3-level structure ──
  try {
    const hierRows = [
      ["ASSEMBLY HIERARCHY — CẤU TRÚC PHÂN CẤP ĐẦY ĐỦ"],
      [`Ngày xuất: ${dateStr} | ${data.length} đối tượng`],
      [],
      ["Assembly Code", "Assembly Name", "Assembly Pos", "Tên", "Profile", "IFC Class", "Thể tích Gross (m³)", "Thể tích Net (m³)", "DT bề mặt Gross (m²)", "DT Net (m²)", "Khối lượng Gross (kg)", "Khối lượng Net (kg)"],
    ];

    const codeMap = {};
    for (const obj of data) {
      const code = obj.assemblyPosCode || "(Không có Code)";
      const name = obj.assemblyName || obj.assembly || "(Không có Name)";
      const pos = obj.assemblyPos || "(Không có Pos)";
      if (!codeMap[code]) codeMap[code] = {};
      if (!codeMap[code][name]) codeMap[code][name] = {};
      if (!codeMap[code][name][pos]) codeMap[code][name][pos] = [];
      codeMap[code][name][pos].push(obj);
    }

    let grandNetVol = 0, grandGrossVol = 0;
    let grandNetWt = 0, grandGrossWt = 0;
    let grandArea = 0, grandNetArea = 0;

    for (const codeKey of Object.keys(codeMap).sort()) {
      const nameMap = codeMap[codeKey];
      let codeNetVol = 0, codeGrossVol = 0;
      let codeNetWt = 0, codeGrossWt = 0;
      let codeArea = 0, codeNetArea = 0;
      let codeCount = 0;

      for (const nMap of Object.values(nameMap)) {
        for (const items of Object.values(nMap)) {
          for (const o of items) {
            codeNetVol += o.netVolume || o.volume || 0;
            codeGrossVol += o.grossVolume || o.volume || 0;
            codeNetWt += o.netWeight || o.weight || 0;
            codeGrossWt += o.grossWeight || o.weight || 0;
            codeArea += o.grossArea || o.area || 0;
            codeNetArea += o.netArea || 0;
            codeCount++;
          }
        }
      }
      grandNetVol += codeNetVol;
      grandGrossVol += codeGrossVol;
      grandNetWt += codeNetWt;
      grandGrossWt += codeGrossWt;
      grandArea += codeArea;
      grandNetArea += codeNetArea;

      hierRows.push([`▶ ${codeKey} (${codeCount})`, "", "", "", "", "", r(codeGrossVol, 6), r(codeNetVol, 6), r(codeArea, 4), r(codeNetArea, 4), r(codeGrossWt, 2), r(codeNetWt, 2)]);

      for (const nameKey of Object.keys(nameMap).sort()) {
        const posMap = nameMap[nameKey];
        let nameNetVol = 0, nameGrossVol = 0;
        let nameNetWt = 0, nameGrossWt = 0;
        let nameArea = 0, nameNetArea = 0;
        let nameCount = 0;
        for (const items of Object.values(posMap)) {
          for (const o of items) {
            nameNetVol += o.netVolume || o.volume || 0;
            nameGrossVol += o.grossVolume || o.volume || 0;
            nameNetWt += o.netWeight || o.weight || 0;
            nameGrossWt += o.grossWeight || o.weight || 0;
            nameArea += o.grossArea || o.area || 0;
            nameNetArea += o.netArea || 0;
            nameCount++;
          }
        }

        hierRows.push(["", `▸ ${nameKey} (${nameCount})`, "", "", "", "", r(nameGrossVol, 6), r(nameNetVol, 6), r(nameArea, 4), r(nameNetArea, 4), r(nameGrossWt, 2), r(nameNetWt, 2)]);

        for (const posKey of Object.keys(posMap).sort()) {
          const items = posMap[posKey];
          const posNetVol = items.reduce((s, o) => s + (o.netVolume || o.volume || 0), 0);
          const posGrossVol = items.reduce((s, o) => s + (o.grossVolume || o.volume || 0), 0);
          const posNetWt = items.reduce((s, o) => s + (o.netWeight || o.weight || 0), 0);
          const posGrossWt = items.reduce((s, o) => s + (o.grossWeight || o.weight || 0), 0);
          const posArea = items.reduce((s, o) => s + (o.grossArea || o.area || 0), 0);
          const posNetArea = items.reduce((s, o) => s + (o.netArea || 0), 0);

          hierRows.push(["", "", `▹ ${posKey} (${items.length})`, "", "", "", r(posGrossVol, 6), r(posNetVol, 6), r(posArea, 4), r(posNetArea, 4), r(posGrossWt, 2), r(posNetWt, 2)]);

          const sorted = items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
          for (const child of sorted) {
            hierRows.push([
              "", "", "",
              child.name || "",
              child.profile || "",
              child.ifcClass || "",
              r(child.grossVolume || child.volume || 0, 6),
              r(child.netVolume || child.volume || 0, 6),
              r(child.grossArea || child.area || 0, 4),
              r(child.netArea || 0, 4),
              r(child.grossWeight || child.weight || 0, 2),
              r(child.netWeight || child.weight || 0, 2),
            ]);
          }
        }
      }
      hierRows.push([]);
    }

    hierRows.push(["TỔNG CỘNG", "", `${data.length} objects`, "", "", "", r(grandGrossVol, 6), r(grandNetVol, 6), r(grandArea, 4), r(grandNetArea, 4), r(grandGrossWt, 2), r(grandNetWt, 2)]);

    const wsHier = XLSX.utils.aoa_to_sheet(hierRows);
    wsHier["!cols"] = [
      { wch: 25 }, { wch: 30 }, { wch: 25 }, { wch: 28 }, { wch: 18 }, { wch: 22 },
      { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 22 },
    ];
    wsHier["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }];
    styleRow(wsHier, 0, 12, S.title);
    styleRow(wsHier, 1, 12, S.info);
    styleRow(wsHier, 3, 12, S.header);
    let altIdx = 0;
    for (let i = 4; i < hierRows.length; i++) {
      const row = hierRows[i];
      if (!row || row.length === 0) continue;
      const v0 = String(row[0] || "");
      const v1 = String(row[1] || "");
      const v2 = String(row[2] || "");
      if (v0 === "TỔNG CỘNG") styleRow(wsHier, i, 12, S.footer);
      else if (v0.startsWith("▶")) styleRow(wsHier, i, 12, S.grp1);
      else if (v1.startsWith("▸")) styleRow(wsHier, i, 12, S.grp2);
      else if (v2.startsWith("▹")) styleRow(wsHier, i, 12, S.grp3);
      else { styleRow(wsHier, i, 12, altIdx % 2 === 0 ? S.data : S.dataAlt); altIdx++; }
    }
    XLSX.utils.book_append_sheet(wb, wsHier, "Assembly Hierarchy");
  } catch (e) {
    console.warn("[ExcelExport] Failed to create Assembly Hierarchy sheet:", e);
  }

  // ── Download ──
  const filename = `DDC_Statistics_${dateStr}${selectedOnly ? "_selected" : ""}.xlsx`;
  XLSX.writeFile(wb, filename);
  console.log(`[ExcelExport] Exported ${data.length} records to ${filename}`);
}

function createGroupSheet(data, groupBy, label) {
  const groups = {};
  const groupChildren = {};
  for (const obj of data) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) {
      groups[key] = { count: 0, netVolume: 0, grossVolume: 0, netWeight: 0, grossWeight: 0, grossArea: 0, netArea: 0 };
      groupChildren[key] = [];
    }
    groups[key].count++;
    groups[key].netVolume += obj.netVolume || obj.volume || 0;
    groups[key].grossVolume += obj.grossVolume || obj.volume || 0;
    groups[key].netWeight += obj.netWeight || obj.weight || 0;
    groups[key].grossWeight += obj.grossWeight || obj.weight || 0;
    groups[key].grossArea += obj.grossArea || obj.area || 0;
    groups[key].netArea += obj.netArea || 0;
    groupChildren[key].push(obj);
  }

  const isAssemblyGroup = ["assemblyPos", "assemblyName", "assemblyPosCode"].includes(groupBy);

  if (isAssemblyGroup) {
    const rows = [
      [`THỐNG KÊ THEO ${label.toUpperCase()} — CHI TIẾT CHILDREN (HIERARCHICAL)`],
      [],
    ];

    let totalNetVol = 0, totalGrossVol = 0;
    let totalNetWt = 0, totalGrossWt = 0;
    let totalArea = 0, totalNetArea = 0;

    if (groupBy === "assemblyPos") {
      rows.push(["Assembly Name", "Assembly Pos", "Tên", "Profile", "IFC Class", "Thể tích Gross (m³)", "Thể tích Net (m³)", "DT bề mặt Gross (m²)", "DT Net (m²)", "Khối lượng Gross (kg)", "Khối lượng Net (kg)"]);

      const nameGroups = {};
      for (const obj of data) {
        const asmName = obj.assemblyName || obj.assembly || "(Không xác định)";
        const asmPos = obj.assemblyPos || "(Không xác định)";
        if (!nameGroups[asmName]) nameGroups[asmName] = {};
        if (!nameGroups[asmName][asmPos]) nameGroups[asmName][asmPos] = [];
        nameGroups[asmName][asmPos].push(obj);
      }

      for (const namKey of Object.keys(nameGroups).sort()) {
        const posGroups = nameGroups[namKey];
        let nameNetVol = 0, nameGrossVol = 0;
        let nameNetWt = 0, nameGrossWt = 0;
        let nameArea = 0, nameNetArea = 0;
        let nameCount = 0;
        for (const items of Object.values(posGroups)) {
          for (const o of items) {
            nameNetVol += o.netVolume || o.volume || 0;
            nameGrossVol += o.grossVolume || o.volume || 0;
            nameNetWt += o.netWeight || o.weight || 0;
            nameGrossWt += o.grossWeight || o.weight || 0;
            nameArea += o.grossArea || o.area || 0;
            nameNetArea += o.netArea || 0;
            nameCount++;
          }
        }
        totalNetVol += nameNetVol;
        totalGrossVol += nameGrossVol;
        totalNetWt += nameNetWt;
        totalGrossWt += nameGrossWt;
        totalArea += nameArea;
        totalNetArea += nameNetArea;

        rows.push([`▶ ${namKey} (${nameCount} items)`, "", "", "", "", r(nameGrossVol, 6), r(nameNetVol, 6), r(nameArea, 4), r(nameNetArea, 4), r(nameGrossWt, 2), r(nameNetWt, 2)]);

        for (const posKey of Object.keys(posGroups).sort()) {
          const items = posGroups[posKey];
          const posNetVol = items.reduce((s, o) => s + (o.netVolume || o.volume || 0), 0);
          const posGrossVol = items.reduce((s, o) => s + (o.grossVolume || o.volume || 0), 0);
          const posNetWt = items.reduce((s, o) => s + (o.netWeight || o.weight || 0), 0);
          const posGrossWt = items.reduce((s, o) => s + (o.grossWeight || o.weight || 0), 0);
          const posArea = items.reduce((s, o) => s + (o.grossArea || o.area || 0), 0);
          const posNetArea = items.reduce((s, o) => s + (o.netArea || 0), 0);

          rows.push(["", `▸ ${posKey} (${items.length})`, "", "", "", r(posGrossVol, 6), r(posNetVol, 6), r(posArea, 4), r(posNetArea, 4), r(posGrossWt, 2), r(posNetWt, 2)]);

          const sorted = items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
          for (const child of sorted) {
            rows.push(["", "", child.name || "", child.profile || "", child.ifcClass || "",
              r(child.grossVolume || child.volume || 0, 6), r(child.netVolume || child.volume || 0, 6), r(child.grossArea || child.area || 0, 4), r(child.netArea || 0, 4), r(child.grossWeight || child.weight || 0, 2), r(child.netWeight || child.weight || 0, 2)]);
          }
        }
        rows.push([]);
      }

      rows.push(["TỔNG CỘNG", `${data.length} objects`, "", "", "", r(totalGrossVol, 6), r(totalNetVol, 6), r(totalArea, 4), r(totalNetArea, 4), r(totalGrossWt, 2), r(totalNetWt, 2)]);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 30 }, { wch: 25 }, { wch: 28 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 22 }];
      ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }];
      styleRow(ws, 0, 11, S.title); styleRow(ws, 2, 11, S.header);
      { let alt = 0;
        for (let i = 3; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          const v0 = String(row[0] || ""); const v1 = String(row[1] || "");
          if (v0 === "TỔNG CỘNG") styleRow(ws, i, 11, S.footer);
          else if (v0.startsWith("▶")) styleRow(ws, i, 11, S.grp1);
          else if (v1.startsWith("▸")) styleRow(ws, i, 11, S.grp2);
          else { styleRow(ws, i, 11, alt % 2 === 0 ? S.data : S.dataAlt); alt++; }
        }
      }
      return ws;

    } else if (groupBy === "assemblyPosCode") {
      rows.push(["Assembly Code", "Assembly Name", "Tên", "Profile", "IFC Class", "Thể tích Gross (m³)", "Thể tích Net (m³)", "DT bề mặt Gross (m²)", "DT Net (m²)", "Khối lượng Gross (kg)", "Khối lượng Net (kg)"]);

      const codeGroups = {};
      for (const obj of data) {
        const code = obj.assemblyPosCode || "(Không xác định)";
        const asmName = obj.assemblyName || obj.assembly || "(Không xác định)";
        if (!codeGroups[code]) codeGroups[code] = {};
        if (!codeGroups[code][asmName]) codeGroups[code][asmName] = [];
        codeGroups[code][asmName].push(obj);
      }

      for (const codeKey of Object.keys(codeGroups).sort()) {
        const nameGroups = codeGroups[codeKey];
        let codeNetVol = 0, codeGrossVol = 0;
        let codeNetWt = 0, codeGrossWt = 0;
        let cArea = 0, cNetArea = 0;
        let codeCount = 0;
        for (const items of Object.values(nameGroups)) {
          for (const o of items) {
            codeNetVol += o.netVolume || o.volume || 0;
            codeGrossVol += o.grossVolume || o.volume || 0;
            codeNetWt += o.netWeight || o.weight || 0;
            codeGrossWt += o.grossWeight || o.weight || 0;
            cArea += o.grossArea || o.area || 0;
            cNetArea += o.netArea || 0;
            codeCount++;
          }
        }
        totalNetVol += codeNetVol;
        totalGrossVol += codeGrossVol;
        totalNetWt += codeNetWt;
        totalGrossWt += codeGrossWt;
        totalArea += cArea;
        totalNetArea += cNetArea;

        rows.push([`▶ ${codeKey} (${codeCount} items)`, "", "", "", "", r(codeGrossVol, 6), r(codeNetVol, 6), r(cArea, 4), r(cNetArea, 4), r(codeGrossWt, 2), r(codeNetWt, 2)]);

        for (const namKey of Object.keys(nameGroups).sort()) {
          const items = nameGroups[namKey];
          const nNetVol = items.reduce((s, o) => s + (o.netVolume || o.volume || 0), 0);
          const nGrossVol = items.reduce((s, o) => s + (o.grossVolume || o.volume || 0), 0);
          const nNetWt = items.reduce((s, o) => s + (o.netWeight || o.weight || 0), 0);
          const nGrossWt = items.reduce((s, o) => s + (o.grossWeight || o.weight || 0), 0);
          const nArea = items.reduce((s, o) => s + (o.grossArea || o.area || 0), 0);
          const nNetArea = items.reduce((s, o) => s + (o.netArea || 0), 0);

          rows.push(["", `▸ ${namKey} (${items.length})`, "", "", "", r(nGrossVol, 6), r(nNetVol, 6), r(nArea, 4), r(nNetArea, 4), r(nGrossWt, 2), r(nNetWt, 2)]);

          const sorted = items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
          for (const child of sorted) {
            rows.push(["", "", child.name || "", child.profile || "", child.ifcClass || "",
              r(child.grossVolume || child.volume || 0, 6), r(child.netVolume || child.volume || 0, 6), r(child.grossArea || child.area || 0, 4), r(child.netArea || 0, 4), r(child.grossWeight || child.weight || 0, 2), r(child.netWeight || child.weight || 0, 2)]);
          }
        }
        rows.push([]);
      }

      rows.push(["TỔNG CỘNG", `${data.length} objects`, "", "", "", r(totalGrossVol, 6), r(totalNetVol, 6), r(totalArea, 4), r(totalNetArea, 4), r(totalGrossWt, 2), r(totalNetWt, 2)]);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 25 }, { wch: 30 }, { wch: 28 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 22 }];
      ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }];
      styleRow(ws, 0, 11, S.title); styleRow(ws, 2, 11, S.header);
      { let alt = 0;
        for (let i = 3; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          const v0 = String(row[0] || ""); const v1 = String(row[1] || "");
          if (v0 === "TỔNG CỘNG") styleRow(ws, i, 11, S.footer);
          else if (v0.startsWith("▶")) styleRow(ws, i, 11, S.grp1);
          else if (v1.startsWith("▸")) styleRow(ws, i, 11, S.grp2);
          else { styleRow(ws, i, 11, alt % 2 === 0 ? S.data : S.dataAlt); alt++; }
        }
      }
      return ws;

    } else {
      // assemblyName — flat with children detail
      rows.push([label, "Tên", "Profile", "IFC Class", "Assembly Pos", "Assembly Code", "Thể tích Gross (m³)", "Thể tích Net (m³)", "DT bề mặt Gross (m²)", "DT Net (m²)", "Khối lượng Gross (kg)", "Khối lượng Net (kg)"]);

      const sortedKeys = Object.keys(groups).sort();
      for (const key of sortedKeys) {
        const g = groups[key];
        totalNetVol += g.netVolume;
        totalGrossVol += g.grossVolume;
        totalNetWt += g.netWeight;
        totalGrossWt += g.grossWeight;
        totalArea += g.grossArea;
        totalNetArea += g.netArea;

        rows.push([
          `▶ ${key} (${g.count} items)`, "", "", "", "", "",
          r(g.grossVolume, 6), r(g.netVolume, 6), r(g.grossArea, 4), r(g.netArea || 0, 4), r(g.grossWeight, 2), r(g.netWeight, 2),
        ]);

        const children = groupChildren[key].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        for (const child of children) {
          rows.push([
            "",
            child.name || "",
            child.profile || "",
            child.ifcClass || "",
            child.assemblyPos || "",
            child.assemblyPosCode || "",
            r(child.grossVolume || child.volume || 0, 6),
            r(child.netVolume || child.volume || 0, 6),
            r(child.grossArea || child.area || 0, 4),
            r(child.netArea || 0, 4),
            r(child.grossWeight || child.weight || 0, 2),
            r(child.netWeight || child.weight || 0, 2),
          ]);
        }
        rows.push([]);
      }

      rows.push(["TỔNG CỘNG", `${data.length} objects`, "", "", "", "", r(totalGrossVol, 6), r(totalNetVol, 6), r(totalArea, 4), r(totalNetArea, 4), r(totalGrossWt, 2), r(totalNetWt, 2)]);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 35 }, { wch: 28 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 22 }];
      ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }];
      styleRow(ws, 0, 12, S.title); styleRow(ws, 2, 12, S.header);
      { let alt = 0;
        for (let i = 3; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          const v0 = String(row[0] || "");
          if (v0 === "TỔNG CỘNG") styleRow(ws, i, 12, S.footer);
          else if (v0.startsWith("▶")) styleRow(ws, i, 12, S.grp1);
          else { styleRow(ws, i, 12, alt % 2 === 0 ? S.data : S.dataAlt); alt++; }
        }
      }
      return ws;
    }
  }

  // Standard summary view for non-assembly groupings
  const rows = [
    [`THỐNG KÊ THEO ${label.toUpperCase()}`],
    [],
    [label, "Số lượng", "Thể tích Gross (m³)", "Thể tích Net (m³)", "DT bề mặt Gross (m²)", "DT Net (m²)", "Khối lượng Gross (kg)", "Khối lượng Net (kg)"],
  ];

  let totalNetVol = 0, totalGrossVol = 0;
  let totalNetWt = 0, totalGrossWt = 0;
  let totalArea = 0, totalNetArea = 0;

  for (const key of Object.keys(groups).sort()) {
    const g = groups[key];
    totalNetVol += g.netVolume;
    totalGrossVol += g.grossVolume;
    totalNetWt += g.netWeight;
    totalGrossWt += g.grossWeight;
    totalArea += g.grossArea;
    totalNetArea += g.netArea || 0;
    rows.push([key, g.count, r(g.grossVolume, 6), r(g.netVolume, 6), r(g.grossArea, 4), r(g.netArea || 0, 4), r(g.grossWeight, 2), r(g.netWeight, 2)]);
  }

  rows.push([]);
  rows.push(["TỔNG CỘNG", data.length, r(totalGrossVol, 6), r(totalNetVol, 6), r(totalArea, 4), r(totalNetArea, 4), r(totalGrossWt, 2), r(totalNetWt, 2)]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 35 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 22 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
  styleRow(ws, 0, 8, S.title); styleRow(ws, 2, 8, S.header);
  { let alt = 0;
    for (let i = 3; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const v0 = String(row[0] || "");
      if (v0 === "TỔNG CỘNG") styleRow(ws, i, 8, S.footer);
      else { styleRow(ws, i, 8, alt % 2 === 0 ? S.data : S.dataAlt); alt++; }
    }
  }
  return ws;
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

// ── Group label for display ──
function getGroupLabel(groupBy) {
  switch (groupBy) {
    case "assemblyName": return "Assembly Name";
    case "assemblyPos": return "Assembly Pos";
    case "assemblyPosCode": return "Assembly Code";
    case "name": return "Tên";
    case "group": return "Group";
    case "objectType": return "Object Type";
    case "material": return "Vật liệu";
    case "profile": return "Profile Name";
    case "referenceName": return "Reference Name";
    case "ifcClass": return "IFC Class";
    default: return groupBy;
  }
}

function r(n, d) {
  return Number(Number(n || 0).toFixed(d));
}
