/**
 * objectExplorer.js - Feature 1: Search, Filter & Highlight IFC Objects
 * Uses TC Workspace API to fetch objects from loaded models.
 * Listens for model state changes via the event system in main.js.
 */

import { getViewer, getIsConnected, showToast, onEvent } from "./main.js";

let allObjects = [];
let selectedIds = new Set();
let debounceTimer = null;
let isFetching = false;

// ========================
// Main: Fetch All Objects
// ========================

async function fetchAllObjects() {
  if (isFetching) return allObjects;
  isFetching = true;

  if (!getIsConnected() || !getViewer()) {
    console.warn("⚠️ Not connected to TC or viewer not available");
    isFetching = false;
    return allObjects;
  }

  const viewer = getViewer();

  try {
    showToast("Đang quét model IFC...");

    // Step 1: Get all loaded models
    let models = [];
    try {
      models = await viewer.getModels("loaded");
      console.log(`📦 Found ${models.length} loaded models`);
      models.forEach((m, i) => {
        console.log(`  [${i}] id="${m.id}" name="${m.name}" type="${m.type}" state="${m.state}"`);
      });
    } catch (e) {
      console.error("❌ getModels() failed:", e);
      showToast("Lỗi khi lấy danh sách model", "error");
      isFetching = false;
      return allObjects;
    }

    if (models.length === 0) {
      showToast("Không tìm thấy model nào đã tải.", "error");
      isFetching = false;
      return allObjects;
    }

    allObjects = [];

    // Step 2: Try getObjects() — no params = all objects
    let gotObjects = false;
    try {
      console.log("🔍 [Strategy 1] getObjects() with no params...");
      const result = await viewer.getObjects();
      if (result && result.length > 0) {
        for (const modelObjs of result) {
          if (!modelObjs.objects || modelObjs.objects.length === 0) continue;
          console.log(`  ✅ Model ${modelObjs.modelId}: ${modelObjs.objects.length} objects`);
          await processModelObjects(viewer, modelObjs.modelId, modelObjs.objects);
          gotObjects = true;
        }
      } else {
        console.log("  → returned empty");
      }
    } catch (e) {
      console.warn("  → failed:", e.message);
    }

    // Step 3: Try per-model with model.id
    if (!gotObjects) {
      for (const model of models) {
        try {
          console.log(`🔍 [Strategy 2] getObjects({modelId: "${model.id}"})...`);
          const result = await viewer.getObjects({
            modelObjectIds: [{ modelId: model.id }],
          });
          if (result && result.length > 0) {
            for (const modelObjs of result) {
              if (!modelObjs.objects || modelObjs.objects.length === 0) continue;
              console.log(`  ✅ ${modelObjs.objects.length} objects`);
              await processModelObjects(viewer, modelObjs.modelId, modelObjs.objects);
              gotObjects = true;
            }
          }
        } catch (e) {
          console.warn(`  → failed:`, e.message);
        }
      }
    }

    // Step 4: Try hierarchy approach — Spatial(1), Containment(3), Group(5)
    if (allObjects.length === 0) {
      for (const model of models) {
        for (const hType of [1, 3, 5]) {
          const hName = { 1: "Spatial", 3: "Containment", 5: "Group" }[hType];
          for (const rootId of [0, 1]) {
            if (allObjects.length > 0) break;
            try {
              console.log(`🔍 [Strategy 3] getHierarchyChildren(model="${model.id}", root=${rootId}, type=${hName})...`);
              const children = await viewer.getHierarchyChildren(model.id, [rootId], hType, true);
              if (children && children.length > 0) {
                console.log(`  ✅ ${children.length} entities`);
                const runtimeIds = children.map((c) => c.id);
                const nameMap = new Map(children.map((c) => [c.id, c.name || ""]));
                await fetchPropertiesAndCreate(viewer, model.id, runtimeIds, nameMap);
              }
            } catch (e) {
              console.warn(`  → failed:`, e.message);
            }
          }
        }
      }
    }

    console.log(`\n===== RESULT: ${allObjects.length} IFC objects loaded =====\n`);

    if (allObjects.length === 0) {
      showToast("Không tìm thấy cấu kiện nào trong model.", "error");
    }
  } catch (error) {
    console.error("❌ Fatal error:", error);
    showToast("Lỗi: " + error.message, "error");
  }

  isFetching = false;
  return allObjects;
}

// ========================
// Process objects from getObjects() result
// ========================

async function processModelObjects(viewer, modelId, objects) {
  const sample = objects[0];
  const hasProps = sample.properties && sample.properties.length > 0;

  if (hasProps) {
    console.log(`    Parsing ${objects.length} objects with existing properties...`);
    for (const obj of objects) {
      allObjects.push(makeEntry(obj, modelId, parseProps(obj)));
    }
  } else {
    console.log(`    Fetching properties for ${objects.length} objects in batches...`);
    const ids = objects.map((o) => o.id);
    const nameMap = new Map();
    objects.forEach((o) => {
      nameMap.set(o.id, o.product?.name || o.class || "");
    });
    await fetchPropertiesAndCreate(viewer, modelId, ids, nameMap);
  }
}

// ========================
// Fetch properties in batches
// ========================

async function fetchPropertiesAndCreate(viewer, modelId, runtimeIds, nameMap) {
  const BATCH = 50;
  for (let i = 0; i < runtimeIds.length; i += BATCH) {
    const batch = runtimeIds.slice(i, i + BATCH);
    try {
      const propsArr = await viewer.getObjectProperties(modelId, batch);
      for (const obj of propsArr) {
        const parsed = parseProps(obj);
        if (!parsed.name && nameMap) parsed.name = nameMap.get(obj.id) || "";
        allObjects.push(makeEntry(obj, modelId, parsed));
      }
    } catch (e) {
      console.warn(`    Batch ${i}-${i + batch.length} failed:`, e.message);
      // Create stub entries
      for (const rid of batch) {
        allObjects.push({
          id: rid, modelId, class: "",
          name: (nameMap && nameMap.get(rid)) || "Object #" + rid,
          description: "", objectType: "",
          assembly: "", type: "", group: "", material: "",
          volume: 0, weight: 0, area: 0, length: 0,
          allProperties: [],
        });
      }
    }
  }
}

// ========================
// Create entry from ObjectProperties
// ========================

function makeEntry(obj, modelId, parsed) {
  return {
    id: obj.id,
    modelId,
    class: obj.class || "",
    name: parsed.name || obj.product?.name || obj.class || "Unnamed",
    description: obj.product?.description || "",
    objectType: obj.product?.objectType || "",
    assembly: parsed.assembly || "",
    type: parsed.type || obj.product?.objectType || obj.class || "",
    group: parsed.group || "",
    material: parsed.material || "",
    volume: parsed.volume || 0,
    weight: parsed.weight || 0,
    area: parsed.area || 0,
    length: parsed.length || 0,
    allProperties: obj.properties || [],
  };
}

// ========================
// Parse IFC PropertySets
// ========================

function parseProps(obj) {
  const r = { name: "", assembly: "", type: "", group: "", material: "", volume: 0, weight: 0, area: 0, length: 0 };

  if (obj.product) {
    r.name = obj.product.name || "";
    r.type = obj.product.objectType || "";
  }

  if (!obj.properties) return r;

  for (const pset of obj.properties) {
    if (!pset.properties) continue;
    const psn = (pset.name || "").toLowerCase();

    for (const p of pset.properties) {
      const pn = (p.name || "").toLowerCase();
      const pv = p.value;
      if (pv == null || pv === "") continue;

      // Name
      if (!r.name && (pn === "name" || pn === "designation" || pn === "tag" || pn === "mark")) {
        r.name = String(pv);
      }
      // Assembly
      if (!r.assembly && (pn === "assembly" || pn.includes("assembly"))) {
        r.assembly = String(pv);
      }
      // Type
      if (!r.type && (pn === "objecttype" || pn === "type" || pn === "typename")) {
        r.type = String(pv);
      }
      // Group
      if (!r.group && (pn === "group" || pn === "groupname" || pn === "category" || pn === "storey" || pn === "level" || pn === "building")) {
        r.group = String(pv);
      }
      // Material
      if (!r.material && (pn === "material" || pn.includes("material") || psn.includes("material"))) {
        r.material = String(pv);
      }
      // Volume
      if (r.volume === 0 && (pn === "volume" || pn === "netvolume" || pn === "grossvolume" || pn === "net volume" || pn === "gross volume" || p.type === 2)) {
        const v = parseFloat(pv);
        if (!isNaN(v) && v > 0) r.volume = v;
      }
      // Weight
      if (r.weight === 0 && (pn === "weight" || pn === "netweight" || pn === "grossweight" || pn === "mass" || p.type === 3)) {
        const w = parseFloat(pv);
        if (!isNaN(w) && w > 0) r.weight = w;
      }
      // Area
      if (r.area === 0 && (pn === "area" || pn === "netsurfacearea" || pn === "grosssurfacearea" || p.type === 1)) {
        const a = parseFloat(pv);
        if (!isNaN(a) && a > 0) r.area = a;
      }
      // Length
      if (r.length === 0 && (pn === "length" || pn === "span" || pn === "overalllength")) {
        const l = parseFloat(pv);
        if (!isNaN(l) && l > 0) r.length = p.type === 0 ? l / 1000 : l;
      }
    }
  }

  return r;
}

// ========================
// Search & Filter
// ========================

function getActiveFilters() {
  return {
    name: document.querySelector("#filterName input")?.checked,
    assembly: document.querySelector("#filterAssembly input")?.checked,
    type: document.querySelector("#filterType input")?.checked,
    group: document.querySelector("#filterGroup input")?.checked,
    material: document.querySelector("#filterMaterial input")?.checked,
  };
}

function filterObjects(query) {
  if (!query || !query.trim()) return [...allObjects];
  const q = query.toLowerCase().trim();
  const f = getActiveFilters();
  const anyActive = f.name || f.assembly || f.type || f.group || f.material;

  return allObjects.filter((o) => {
    if (!anyActive) {
      return [o.name, o.assembly, o.type, o.group, o.material, o.class]
        .some((v) => (v || "").toLowerCase().includes(q));
    }
    if (f.name && (o.name || "").toLowerCase().includes(q)) return true;
    if (f.assembly && (o.assembly || "").toLowerCase().includes(q)) return true;
    if (f.type && (o.type || "").toLowerCase().includes(q)) return true;
    if (f.group && (o.group || "").toLowerCase().includes(q)) return true;
    if (f.material && (o.material || "").toLowerCase().includes(q)) return true;
    return false;
  });
}

// ========================
// Render
// ========================

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const e = escapeHtml(text);
  const q = escapeHtml(query.trim()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return e.replace(new RegExp(`(${q})`, "gi"), '<span class="highlight-match">$1</span>');
}

function parseId(id) {
  if (typeof id === "number") return id;
  const n = parseInt(id, 10);
  return isNaN(n) ? id : n;
}

function renderResults(objects, query) {
  const list = document.getElementById("resultsList");
  const countEl = document.getElementById("resultCount");
  const loadingEl = document.getElementById("objectsLoading");
  if (loadingEl) loadingEl.style.display = "none";

  const searching = query && query.trim().length > 0;

  if (objects.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
          ${searching
            ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'
            : '<polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><line x1="12" y1="22" x2="12" y2="15.5"/>'}
        </svg>
        <p>${searching ? "Không tìm thấy đối tượng nào" : "Nhấn 🔄 để quét model IFC"}</p>
      </div>`;
    countEl.textContent = searching ? "Không tìm thấy" : "0 đối tượng";
    return;
  }

  countEl.textContent = searching ? `${objects.length} kết quả` : `${objects.length} đối tượng`;

  list.innerHTML = objects.map((o, i) => `
    <div class="result-item ${selectedIds.has(o.id) ? "selected" : ""}"
         data-id="${o.id}" data-model-id="${o.modelId || ""}"
         style="animation-delay:${Math.min(i * 0.02, 0.3)}s">
      <div class="item-checkbox"></div>
      <div class="item-info">
        <div class="item-name">${highlightText(o.name, query)}</div>
        <div class="item-meta">
          ${o.class ? `<span class="class-tag">${highlightText(o.class, query)}</span>` : ""}
          ${o.assembly ? `<span class="assembly-tag">⬡ ${highlightText(o.assembly, query)}</span>` : ""}
          ${o.type && o.type !== o.class ? `<span class="type-tag">${highlightText(o.type, query)}</span>` : ""}
          ${o.group ? `<span class="group-tag">▣ ${highlightText(o.group, query)}</span>` : ""}
          ${o.material ? `<span class="material-tag">◆ ${highlightText(o.material, query)}</span>` : ""}
        </div>
      </div>
      <button class="item-highlight-btn" title="Highlight trong 3D"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></button>
    </div>`).join("");

  list.querySelectorAll(".result-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.closest(".item-highlight-btn")) return;
      toggleSelection(item.dataset.id);
      item.classList.toggle("selected", selectedIds.has(parseId(item.dataset.id)));
    });
    item.querySelector(".item-highlight-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      highlightObject(item.dataset.id, item.dataset.modelId);
    });
  });

  if (searching) autoHighlight(objects);
  else clearHighlight();
}

// ========================
// 3D Highlight
// ========================

function groupByModel(objs) {
  const map = new Map();
  for (const o of objs) {
    if (!o.modelId) continue;
    if (!map.has(o.modelId)) map.set(o.modelId, []);
    map.get(o.modelId).push(o.id);
  }
  return [...map.entries()].map(([modelId, ids]) => ({ modelId, objectRuntimeIds: ids }));
}

async function autoHighlight(matched) {
  if (!getIsConnected() || !getViewer()) return;
  try {
    await getViewer().setObjectState(undefined, { color: "reset" });
    const sel = groupByModel(matched);
    if (sel.length > 0) {
      await getViewer().setObjectState({ modelObjectIds: sel }, { color: { r: 108, g: 123, b: 234, a: 180 } });
    }
  } catch (e) { console.warn("autoHighlight:", e); }
}

async function clearHighlight() {
  if (!getIsConnected() || !getViewer()) return;
  try { await getViewer().setObjectState(undefined, { color: "reset" }); } catch (e) {}
}

// ========================
// Selection
// ========================

function toggleSelection(id) {
  const nid = parseId(id);
  if (selectedIds.has(nid)) selectedIds.delete(nid);
  else selectedIds.add(nid);
  syncViewerSelection();
}

function selectAll() {
  const q = document.getElementById("searchInput").value;
  const filtered = filterObjects(q);
  if (selectedIds.size === filtered.length && filtered.length > 0) {
    selectedIds.clear();
  } else {
    filtered.forEach((o) => selectedIds.add(o.id));
  }
  renderResults(filtered, q);
  syncViewerSelection();
  showToast(selectedIds.size > 0 ? `Đã chọn ${selectedIds.size} đối tượng` : "Đã bỏ chọn tất cả");
}

async function syncViewerSelection() {
  if (!getIsConnected() || !getViewer()) return;
  const selected = allObjects.filter((o) => selectedIds.has(o.id));
  try {
    const sel = groupByModel(selected);
    await getViewer().setSelection(sel.length > 0 ? { modelObjectIds: sel } : { modelObjectIds: [] }, "set");
    if (sel.length > 0) {
      await getViewer().setObjectState({ modelObjectIds: sel }, { color: { r: 108, g: 123, b: 234, a: 200 } });
    }
  } catch (e) { console.warn("syncViewerSelection:", e); }
}

async function highlightObject(objId, modelId) {
  const nid = parseId(objId);
  const obj = allObjects.find((o) => o.id === nid);
  if (!obj) return;
  if (getIsConnected() && getViewer()) {
    try {
      const sel = [{ modelId: modelId || obj.modelId, objectRuntimeIds: [nid] }];
      await getViewer().setSelection({ modelObjectIds: sel }, "set");
      await getViewer().setObjectState({ modelObjectIds: sel }, { color: { r: 255, g: 200, b: 50, a: 255 } });
      try { await getViewer().setCamera({ modelObjectIds: sel }); } catch (e) {}
    } catch (e) { console.warn("highlightObject:", e); }
  }
  showToast(`Highlight: ${obj.name}`);
}

async function isolateSelected() {
  const selected = allObjects.filter((o) => selectedIds.has(o.id));
  if (selected.length === 0) { showToast("Chưa chọn đối tượng nào", "error"); return; }
  if (getIsConnected() && getViewer()) {
    try {
      const ents = groupByModel(selected).map((m) => ({ modelId: m.modelId, entityIds: m.objectRuntimeIds }));
      await getViewer().isolateEntities(ents);
    } catch (e) { console.warn("isolateSelected:", e); }
  }
  showToast(`Isolate ${selected.length} đối tượng`);
}

async function resetView() {
  selectedIds.clear();
  if (getIsConnected() && getViewer()) {
    try {
      await getViewer().setSelection({ modelObjectIds: [] }, "set");
      await getViewer().setObjectState(undefined, { color: "reset" });
      await getViewer().setObjectState(undefined, { visible: "reset" });
      await getViewer().setCamera("reset");
    } catch (e) { console.warn("resetView:", e); }
  }
  renderResults(allObjects, "");
  showToast("Đã reset view");
}

// ========================
// Scan (manual trigger)
// ========================

async function scanModel() {
  allObjects = [];
  selectedIds.clear();
  const loadingEl = document.getElementById("objectsLoading");
  if (loadingEl) loadingEl.style.display = "";
  renderResults([], "");

  const objects = await fetchAllObjects();

  const totalEl = document.getElementById("totalObjectCount");
  if (totalEl) totalEl.textContent = objects.length;

  renderResults(filterObjects(document.getElementById("searchInput").value), document.getElementById("searchInput").value);
  showToast(
    objects.length > 0 ? `Đã tải ${objects.length} cấu kiện` : "Không tìm thấy cấu kiện nào",
    objects.length > 0 ? "success" : "error"
  );
}

// ========================
// Init
// ========================

export function initObjectExplorer() {
  // Listen for model state changes — auto-scan when model loads
  onEvent("viewer.onModelStateChanged", (event, data) => {
    console.log("📦 Model state changed:", data);
    // Auto-scan after a model finishes loading
    setTimeout(() => scanModel(), 2000);
  });

  // Initial scan with delay
  setTimeout(() => scanModel(), 1500);

  // Search
  const searchInput = document.getElementById("searchInput");
  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const q = searchInput.value;
      renderResults(filterObjects(q), q);
    }, 200);
  });

  document.getElementById("clearSearch").addEventListener("click", () => {
    searchInput.value = "";
    selectedIds.clear();
    renderResults(allObjects, "");
    searchInput.focus();
  });

  document.getElementById("selectAllBtn").addEventListener("click", selectAll);
  document.getElementById("isolateBtn").addEventListener("click", isolateSelected);
  document.getElementById("resetViewBtn").addEventListener("click", () => scanModel());
}

export function getAllObjects() { return allObjects; }
export function getSelectedIds() { return selectedIds; }
