/**
 * objectExplorer.js — IFC Object Statistics, Search, Highlight, Isolate & Labels
 *
 * Scans all objects from loaded models, extracts IFC properties,
 * groups them, provides real-time search, 3D highlight/isolate, and labels.
 */

import { onEvent } from "./main.js";

// ── State ──
let apiRef = null;
let viewerRef = null;
let allObjects = []; // { id, modelId, name, assembly, group, type, material, volume, weight, area, length, profile, class }
let filteredObjects = [];
let selectedIds = new Set(); // Set of "modelId:objectId"
// Assembly hierarchy maps (built during scan)
let assemblyMembershipMap = new Map(); // "modelId:objectId" -> "modelId:assemblyParentId"
let assemblyChildrenMap = new Map(); // "modelId:assemblyParentId" -> Set([objectId1, objectId2, ...])
let assemblyNodeInfoMap = new Map(); // "modelId:assemblyNodeId" -> { id, name, class, modelId }
let isolateActive = false;
let searchTimeout = null;
let lastClickedItem = null; // for Shift+click range selection
let lastClickAction = "select"; // "select" or "deselect" — for Shift range
let lastClickedGroupEl = null; // for Shift+click range selection on group headers
let lastGroupClickAction = "select"; // "select" or "deselect" — for group Shift range
let isSyncingFromViewer = false; // flag to prevent re-entry during sync
let lastViewerSelectionKey = ""; // dedup key for polling
let selectionFromPanel = false; // true when selection originates from panel click
let shouldScrollToTop = false; // flag to scroll to top after renderTree()

// ── Init ──
export function initObjectExplorer(api, viewer) {
  apiRef = api;
  viewerRef = viewer;

  // Listen for model state changes
  onEvent("viewer.onModelStateChanged", () => {
    console.log("[ObjectExplorer] Model state changed, scanning...");
    scanObjects();
  });

  // Listen for TC viewer selection changes
  onEvent("viewer.onSelectionChanged", (data) => {
    // Skip echo events from our own setSelection calls
    if (isSyncingFromViewer) return;
    console.log(
      "[ObjectExplorer] onSelectionChanged event:",
      JSON.stringify(data).substring(0, 500),
    );
    handleViewerSelectionChanged(data);
  });

  // Backup: poll viewer.getSelection() every 2 seconds to catch missed events
  setInterval(async () => {
    if (isSyncingFromViewer || !viewerRef || allObjects.length === 0) return;
    try {
      const sel = await viewerRef.getSelection();
      if (sel) {
        handleViewerSelectionChanged(sel);
      }
    } catch (e) {
      /* ignore polling errors */
    }
  }, 2000);

  // UI bindings
  const searchInput = document.getElementById("search-input");
  if (searchInput) {
    searchInput.addEventListener("input", onSearchInput);
  }
  
  const searchClearBtn = document.getElementById("search-clear-btn");
  if (searchClearBtn) {
    searchClearBtn.addEventListener("click", clearSearch);
  }
  
  const groupBySelect = document.getElementById("group-by-select");
  if (groupBySelect) {
    groupBySelect.addEventListener("change", renderTree);
  }
  
  const isolateBtn = document.getElementById("btn-isolate");
  if (isolateBtn) {
    isolateBtn.addEventListener("click", toggleIsolate);
  }
  
  const resetBtn = document.getElementById("btn-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetAll);
  }
  
  const refreshBtn = document.getElementById("btn-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", scanObjects);
  }
  
  const selectAsmBtn = document.getElementById("btn-select-assembly");
  if (selectAsmBtn) {
    selectAsmBtn.addEventListener("click", selectAssembly);
  }
  
  const collapseBtn = document.getElementById("btn-collapse-all");
  if (collapseBtn) {
    collapseBtn.addEventListener("click", collapseAll);
  }
  
  const expandBtn = document.getElementById("btn-expand-all");
  if (expandBtn) {
    expandBtn.addEventListener("click", expandAll);
  }
}

// ── Export data for statistics module ──
export function getAllObjects() {
  return allObjects;
}
export function getSelectedIds() {
  return selectedIds;
}
export function getSelectedObjects() {
  if (selectedIds.size === 0) return [];
  return allObjects.filter((o) => selectedIds.has(`${o.modelId}:${o.id}`));
}

// ── Object Scanning ──
async function scanObjects() {
  showLoading(true);
  allObjects = [];

  try {
    // Get all loaded models
    let models = [];
    try {
      models = await viewerRef.getModels("loaded");
      console.log("[ObjectExplorer] Loaded models:", models);
    } catch (e) {
      console.warn("[ObjectExplorer] getModels failed:", e);
      try {
        models = await viewerRef.getModels();
        console.log("[ObjectExplorer] All models:", models);
      } catch (e2) {
        console.warn("[ObjectExplorer] getModels() also failed:", e2);
      }
    }

    // Strategy 1: getObjects() returns ModelObjects[] with full ObjectProperties
    let modelObjectsList = [];
    try {
      modelObjectsList = await viewerRef.getObjects();
      console.log(
        "[ObjectExplorer] getObjects() returned:",
        modelObjectsList?.length,
        "models",
      );
    } catch (e) {
      console.warn("[ObjectExplorer] getObjects() failed:", e);
    }

    if (modelObjectsList && modelObjectsList.length > 0) {
      // ModelObjects has { modelId, objects: ObjectProperties[] }
      // Always fetch full properties via getObjectProperties() for complete data
      // (inline properties from getObjects() are often incomplete — missing quantities)
      for (const modelObjs of modelObjectsList) {
        const modelId = modelObjs.modelId;
        const objects = modelObjs.objects || [];

        if (objects.length === 0) continue;

        // Extract all runtime IDs
        const objectIds = objects.map((o) =>
          typeof o === "number" ? o : o.id,
        ).filter((id) => id !== undefined && id !== null);

        console.log(
          `[ObjectExplorer] Model ${modelId}: ${objectIds.length} objects — fetching full properties via getObjectProperties()`,
        );

        // Always fetch complete properties (like TC Data Table does)
        await fetchAndParseProperties(modelId, objectIds);
      }
    }

    // Strategy 2: If no objects, try per-model fetching
    if (allObjects.length === 0 && models.length > 0) {
      for (const model of models) {
        if (model.state && model.state !== "loaded") continue;
        try {
          const modelObjs = await viewerRef.getObjects({
            modelObjectIds: [{ modelId: model.id }],
          });
          if (modelObjs) {
            for (const mo of modelObjs) {
              const objects = mo.objects || [];
              for (const obj of objects) {
                allObjects.push(parseObjectProperties(obj, mo.modelId));
              }
            }
          }
        } catch (e) {
          console.warn(
            `[ObjectExplorer] Per-model fetch failed for ${model.id}:`,
            e,
          );
        }
      }
    }

    // Strategy 3: Hierarchy-based approach
    if (allObjects.length === 0 && models.length > 0) {
      for (const model of models) {
        if (model.state && model.state !== "loaded") continue;
        try {
          // Get root entities via spatial hierarchy
          const rootEntities = await viewerRef.getHierarchyChildren(
            model.id,
            [0],
            1,
            true,
          );
          if (rootEntities && rootEntities.length > 0) {
            const entityIds = rootEntities.map((e) => e.id);
            await fetchAndParseProperties(model.id, entityIds);
          }
        } catch (e) {
          console.warn(
            `[ObjectExplorer] Hierarchy fetch failed for ${model.id}:`,
            e,
          );
        }
      }
    }

    console.log(`[ObjectExplorer] Raw scanned ${allObjects.length} objects`);

    // Deduplicate: keep only unique modelId:objectId (prefer the one with more data)
    const seen = new Map();
    for (const obj of allObjects) {
      const key = `${obj.modelId}:${obj.id}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, obj);
      } else {
        // Keep the entry with more physical data
        // Score includes: volume, weight, area, assembly info, profile, bolt info
        const existingScore = 
          (existing.volume > 0 ? 3 : 0) +
          (existing.weight > 0 ? 2 : 0) +
          (existing.area > 0 ? 2 : 0) +
          (existing.assemblyPos ? 2 : 0) +
          (existing.profile ? 1 : 0) +
          (existing.isTeklaBolt ? 2 : 0) +
          (existing.isTekla ? 1 : 0);
        
        const newScore = 
          (obj.volume > 0 ? 3 : 0) +
          (obj.weight > 0 ? 2 : 0) +
          (obj.area > 0 ? 2 : 0) +
          (obj.assemblyPos ? 2 : 0) +
          (obj.profile ? 1 : 0) +
          (obj.isTeklaBolt ? 2 : 0) +
          (obj.isTekla ? 1 : 0);
        
        if (newScore > existingScore) {
          seen.set(key, obj);
        }
      }
    }
    const beforeDedup = allObjects.length;
    allObjects = Array.from(seen.values());
    if (beforeDedup !== allObjects.length) {
      console.log(`[ObjectExplorer] Deduplicated: ${beforeDedup} → ${allObjects.length} objects (removed ${beforeDedup - allObjects.length} duplicates)`);
    }

    // Filter Stage 1: exclude IFC metadata/non-3D classes
    const NON_3D_CLASSES = new Set([
      // IFC structural/metadata
      "ifcproject", "ifcsite", "ifcbuilding", "ifcbuildingstorey",
      "ifcspace", "ifcgroup", "ifcopeningelement", "ifcownerhistory",
      "ifcreldefinesbyproperties", "ifcrelassociatesmaterial",
      "ifcrelcontainedinspatialstructure", "ifcrelaggregates",
      // Grid & Level (Revit/IFC)
      "ifcgrid", "ifcgridaxis", "ifcgridplacement",
      // Annotations & 2D
      "ifcannotation", "ifcannotationfillarea",
      "ifctextliteral", "ifctextliteralwithextent",
      // Spatial zones
      "ifczone", "ifcspatialzone",
      // Distribution systems (MEP abstract)
      "ifcdistributionsystem", "ifcsystem",
    ]);
    const beforeFilter = allObjects.length;
    allObjects = allObjects.filter((obj) => {
      const cls = (obj.ifcClass || "").toLowerCase();
      return !NON_3D_CLASSES.has(cls);
    });
    console.log(
      `[ObjectExplorer] Stage 1 filter: ${beforeFilter} → ${allObjects.length} objects (removed ${beforeFilter - allObjects.length} non-3D classes)`,
    );

    // Filter Stage 2: exclude objects with no physical data
    // BUT keep bolt/fastener/accessory objects and Tekla-detected objects even without quantities
    // to match Trimble Connect Data Table total count
    // ── Comprehensive IFC 3D element classes that should ALWAYS be kept ──
    const ALWAYS_KEEP_CLASSES = new Set([
      // Structural elements
      "ifcbeam", "ifcbeamtype",
      "ifccolumn", "ifccolumntype",
      "ifcmember", "ifcmembertype",
      "ifcplate", "ifcplatetype",
      "ifcslab", "ifcslabtype",
      "ifcwall", "ifcwalltype", "ifcwallstandardcase",
      "ifcfooting", "ifcfootingtype",
      "ifcpile", "ifcpiletype",
      "ifcrailing", "ifcrailingtype",
      "ifcramp", "ifcramptype", "ifcrampflight", "ifcrampflighttype",
      "ifcroof", "ifcrooftype",
      "ifcstair", "ifcstairtype", "ifcstairflight", "ifcstairflighttype",
      "ifcchimney", "ifchimneytype",
      // Architectural elements
      "ifcdoor", "ifcdoortype", "ifcdoorstandardcase",
      "ifcwindow", "ifcwindowtype", "ifcwindowstandardcase",
      // Building element proxies & parts
      "ifcbuildingelementproxy", "ifcbuildingelementproxytype",
      "ifcbuildingelementpart", "ifcbuildingelementparttype",
      // Bearings & connections
      "ifcbearing", "ifcbearingtype",
      "ifctendonanchor", "ifctendonanchortype",
      "ifctendon", "ifctendontype",
      "ifctendonconduit", "ifctendonconduittype",
      // Virtual elements (user requested)
      "ifcvirtualelement",
      // Fasteners & bolts (comprehensive)
      "ifcmechanicalfastener", "ifcmechanicalfastenertype",
      "ifcdiscreteaccessory", "ifcdiscreteaccessorytype",
      "ifcfastener", "ifcfastenertype",
      "ifcbolt", "ifcbolttype",
      "ifcboltgroup", "ifcboltgrouptype",
      "ifcboltassembly", "ifcboltassemblytype",
      // Assembly
      "ifcelementassembly", "ifcelementassemblytype",
      // Reinforcement
      "ifcreinforcingbar", "ifcreinforcingbartype",
      "ifcreinforcingmesh", "ifcreinforcingmeshtype",
      "ifcreinforcingelement", "ifcreinforcingelementtype",
      // Covering & cladding
      "ifccovering", "ifccoveringtype",
      "ifccurtainwall", "ifccurtainwalltype",
      // Other physical elements
      "ifcbuildingelementcomponent",
      "ifcshadingdevice", "ifcshadingdevicetype",
      "ifcearthworkselement", "ifcearthworkselementtype",
      "ifcgeographicelement", "ifcgeographicelementtype",
      "ifctransportelement", "ifctransportelementtype",
      "ifcfurnishingelement", "ifcfurnishingelementtype",
      // MEP physical elements
      "ifcflowsegment", "ifcflowsegmenttype",
      "ifcflowfitting", "ifcflowfittingtype",
      "ifcflowterminal", "ifcflowterminaltype",
      "ifcflowcontroller", "ifcflowcontrollertype",
      "ifcflowmovingdevice", "ifcflowmovingdevicetype",
      "ifcflowstoragedevice", "ifcflowstoragedevicetype",
      "ifcflowtreatmentdevice", "ifcflowtreatmentdevicetype",
      "ifcenergyconversiondevice", "ifcenergyconversiondevicetype",
      "ifcdistributionelement", "ifcdistributionelementtype",
      "ifcdistributionflowelement", "ifcdistributionflowelementtype",
      "ifcdistributioncontrolelement", "ifcdistributioncontrolelementtype",
      // Pipes & ducts
      "ifcpipesegment", "ifcpipesegmenttype",
      "ifcpipefitting", "ifcpipefittingtype",
      "ifcductsegment", "ifcductsegmenttype",
      "ifcductfitting", "ifcductfittingtype",
      // Civil infrastructure
      "ifcbridge", "ifcbridgetype",
      "ifcbridgepart", "ifcbridgeparttype",
      "ifcroad", "ifcroadtype",
      "ifcroadpart", "ifcroadparttype",
    ]);
    const beforeStage2 = allObjects.length;
    allObjects = allObjects.filter((obj) => {
      const hasWeight = obj.weight > 0;
      const hasArea = obj.area > 0;
      const hasVolume = obj.volume > 0;
      // Keep objects with physical data
      if (hasWeight || hasArea || hasVolume) return true;
      // Keep bolt/fastener objects (they are real modeled 3D objects)
      if (obj.isTeklaBolt) return true;
      // Keep Tekla-origin objects (they exist in the model)
      if (obj.isTekla) return true;
      // Keep specific IFC classes that represent real 3D elements
      const cls = (obj.ifcClass || "").toLowerCase();
      if (ALWAYS_KEEP_CLASSES.has(cls)) return true;
      // Keep objects that have a name from property sets (not auto-generated)
      if (obj.name && !/^Object \d+$/.test(obj.name)) return true;
      return false;
    });
    console.log(
      `[ObjectExplorer] Stage 2 filter: ${beforeStage2} → ${allObjects.length} objects (removed ${beforeStage2 - allObjects.length} objects without physical data or valid identity)`,
    );

    // Assign assembly instances via Tekla properties (ASSEMBLY_POS)
    assignAssemblyInstances();

    // Build IFC hierarchy-based assembly map (like TC Windows)
    await buildAssemblyHierarchyMap(models);

    // Enrich objects missing ASSEMBLY_POS using IFC hierarchy
    // This mimics how Trimble Connect for Windows groups parts:
    // parts under the same IfcElementAssembly node share the same assembly
    await enrichAssemblyFromHierarchy();

    // Re-assign instances after enrichment
    assignAssemblyInstances();

    // Build display names for assembly groups
    buildAssemblyDisplayNames();

    // Mark assembly parent nodes and component objects
    // Build a set of all object keys for quick lookup
    const allObjectKeys = new Set(allObjects.map(o => `${o.modelId}:${o.id}`));

    for (const obj of allObjects) {
      const objectKey = `${obj.modelId}:${obj.id}`;
      
      // Mark if this is an assembly parent node
      if (assemblyChildrenMap.has(objectKey)) {
        obj.isAssemblyParent = true;
      }
      
      // Mark if this object is a component of an assembly
      if (assemblyMembershipMap.has(objectKey)) {
        obj.isAssemblyComponent = true;
      }
    }

    // ── FIX: Remove IfcElementAssembly aggregate parents to prevent double-counting ──
    // In Tekla IFC exports, IfcElementAssembly parent nodes carry
    // aggregated weight/volume/area = sum of all children.
    // If children are ALSO in allObjects, keeping the parent would
    // double-count both quantities AND object count.
    // Solution: completely remove assembly parent nodes when their children exist.
    const beforeAssemblyDedup = allObjects.length;
    const removedAssemblyParents = [];
    allObjects = allObjects.filter((obj) => {
      if (!obj.isAssemblyParent) return true;
      
      const objectKey = `${obj.modelId}:${obj.id}`;
      const childIds = assemblyChildrenMap.get(objectKey);
      if (!childIds || childIds.size === 0) return true;
      
      // Check if ANY children exist in allObjects
      for (const childId of childIds) {
        if (allObjectKeys.has(`${obj.modelId}:${childId}`)) {
          // Children exist → remove this aggregate parent
          removedAssemblyParents.push({
            name: obj.name, ifcClass: obj.ifcClass,
            weight: obj.weight, volume: obj.volume, area: obj.area,
            childCount: childIds.size,
          });
          return false; // REMOVE from allObjects
        }
      }
      return true; // no children found, keep it
    });
    if (removedAssemblyParents.length > 0) {
      console.log(
        `[ObjectExplorer] ✓ Removed ${removedAssemblyParents.length} IfcElementAssembly aggregate parents ` +
        `(${beforeAssemblyDedup} → ${allObjects.length} objects) to prevent double-counting`
      );
      for (const p of removedAssemblyParents.slice(0, 5)) {
        console.log(
          `  - "${p.name}" (${p.ifcClass}): W=${(p.weight||0).toFixed(2)}kg V=${(p.volume||0).toFixed(6)}m³ (${p.childCount} children)`
        );
      }
    }

    // ── Estimate bolt quantities ──
    // Bolts (IfcMechanicalFastener) typically have no volume/weight/area.
    // Estimate from bolt dimensions: V ≈ π×(d/2)²×L, W = V × 7850
    let boltsEstimated = 0;
    for (const obj of allObjects) {
      if (!obj.isTeklaBolt) continue;
      if (obj.weight > 0 || obj.volume > 0) continue; // already has data
      
      // Parse bolt diameter (mm) and length (mm)
      const diameter = parseBoltDimension(obj.boltSize);
      const length = parseBoltDimension(obj.boltLength);
      
      if (diameter > 0 && length > 0) {
        const dMeters = diameter / 1000;
        const lMeters = length / 1000;
        const boltVolume = Math.PI * Math.pow(dMeters / 2, 2) * lMeters;
        const count = obj.boltCount > 0 ? obj.boltCount : 1;
        obj.volume = boltVolume * count;
        obj.weight = obj.volume * 7850;
        obj.area = Math.PI * dMeters * lMeters * count;
        obj.boltEstimated = true;
        boltsEstimated++;
      } else if (diameter > 0) {
        const dMeters = diameter / 1000;
        const estimatedLength = diameter * 3;
        const lMeters = estimatedLength / 1000;
        const boltVolume = Math.PI * Math.pow(dMeters / 2, 2) * lMeters;
        const count = obj.boltCount > 0 ? obj.boltCount : 1;
        obj.volume = boltVolume * count;
        obj.weight = obj.volume * 7850;
        obj.area = Math.PI * dMeters * lMeters * count;
        obj.boltEstimated = true;
        boltsEstimated++;
      }
    }
    if (boltsEstimated > 0) {
      console.log(`[ObjectExplorer] ✓ Estimated quantities for ${boltsEstimated} bolt objects from dimensions`);
    }

    // Stage 3: keep ALL objects (assembly aggregates already removed above).
    // The requirement "each 3D object is 1 object" needs a 1:1 mapping.
    // Grouping into assemblyPos will be handled by assigning assemblyPos/assemblyName/assembly.
    filteredObjects = [...allObjects];

    selectedIds.clear();
    updateSummary();
    renderTree();
    hidePlaceholder();

    // Notify statistics module
    window.dispatchEvent(
      new CustomEvent("objects-scanned", { detail: allObjects }),
    );
  } catch (error) {
    console.error("[ObjectExplorer] Scan failed:", error);
  } finally {
    showLoading(false);
  }
}

// ── Fetch properties in batches ──
async function fetchAndParseProperties(modelId, objectIds) {
  const BATCH_SIZE = 50;
  for (let i = 0; i < objectIds.length; i += BATCH_SIZE) {
    const batch = objectIds.slice(i, i + BATCH_SIZE);
    try {
      const propsArray = await viewerRef.getObjectProperties(modelId, batch);
      if (propsArray) {
        for (const props of propsArray) {
          allObjects.push(parseObjectProperties(props, modelId));
        }
      }
    } catch (e) {
      console.warn(`[ObjectExplorer] getObjectProperties batch failed:`, e);
      // Add with minimal info
      for (const objId of batch) {
        allObjects.push({
          id: objId,
          modelId,
          name: `Object ${objId}`,
          assembly: "",
          group: "",
          type: "",
          material: "",
          volume: 0,
          weight: 0,
          area: 0,
          length: 0,
          profile: "",
          ifcClass: "",
        });
      }
    }
  }
}

// ── Centralized Assembly Property Classifier ──
// Classifies any IFC property name into assembly categories.
// Returns: "pos" | "name" | "code" | "mark" | "generic" | null
function classifyAssemblyProperty(rawPropName) {
  if (!rawPropName) return null;

  // Strip dot-prefix notation (e.g. "Tekla.ASSEMBLY_POS" → "ASSEMBLY_POS")
  let cleanName = rawPropName;
  const lastDot = rawPropName.lastIndexOf(".");
  const lastSlash = rawPropName.lastIndexOf("/");
  const lastSep = Math.max(lastDot, lastSlash);
  if (lastSep > 0 && lastSep < rawPropName.length - 1) {
    cleanName = rawPropName.substring(lastSep + 1);
  }

  // Normalize: lowercase, remove spaces, underscores, dots, hyphens
  const norm = cleanName.toLowerCase().replace(/[\s_.\-]/g, "");

  // ── ASSEMBLY_POS detection ──
  if (
    norm === "assemblypos" ||
    norm === "assemblyposition" ||
    norm === "mainpartpos" ||
    norm === "mainpartposition"
  ) {
    if (!norm.includes("code") && !norm.includes("prefix") && !norm.includes("number")) {
      return "pos";
    }
  }

  // ── ASSEMBLY_MARK detection ──
  if (
    norm === "assemblymark" ||
    norm === "assemblemark" ||
    norm === "asmmark" ||
    norm === "mainmark" ||
    norm === "mainpartmark"
  ) {
    return "mark";
  }

  // ── ASSEMBLY_NAME detection ──
  if (
    norm === "assemblyname" ||
    norm === "assemblename" ||
    norm === "asmname"
  ) {
    return "name";
  }

  // ── ASSEMBLY_POSITION_CODE detection ──
  if (
    norm === "assemblypositioncode" ||
    norm === "assemblyposcode" ||
    norm === "assemblyprefixcode" ||
    norm === "assemblyprefix" ||
    norm === "positioncode"
  ) {
    return "code";
  }

  // ── Generic assembly fallback ──
  if (
    norm === "assembly" ||
    norm === "assemblycode" ||
    norm === "teklaassembly" ||
    norm === "teklaassemblymark" ||
    norm === "preliminarymark"
  ) {
    return "generic";
  }

  // Regex fallback for unusual patterns (e.g. "Asm Pos", "Main_Part_Pos")
  if (/^ass?e?m(?:bly)?[\s_.-]?pos(?:ition)?$/i.test(cleanName)) return "pos";
  if (/^ass?e?m(?:bly)?[\s_.-]?mark$/i.test(cleanName)) return "mark";
  if (/^ass?e?m(?:bly)?[\s_.-]?name$/i.test(cleanName)) return "name";
  if (/^main[\s_.-]?part[\s_.-]?pos(?:ition)?$/i.test(cleanName)) return "pos";

  return null;
}

// ── Assembly Instance Assignment by Tekla Properties ──
// Uses ASSEMBLY_POS as unique instance identifier (unique per physical assembly in Tekla)
function assignAssemblyInstances() {
  for (const obj of allObjects) {
    if (obj.assemblyPos) {
      obj.assemblyInstanceId = `${obj.modelId}:pos_${obj.assemblyPos}`;
    } else if (obj.assemblyName) {
      obj.assemblyInstanceId = `${obj.modelId}:aname_${obj.assemblyName}`;
    } else if (obj.assembly) {
      obj.assemblyInstanceId = `${obj.modelId}:name_${obj.assembly}`;
    } else {
      obj.assemblyInstanceId = "";
    }
  }

  const uniqueInstances = new Set(allObjects.filter(o => o.assemblyInstanceId).map(o => o.assemblyInstanceId));
  console.log(`[ObjectExplorer] Assigned ${uniqueInstances.size} assembly instances`);
}

// ── Build Assembly Hierarchy Map ──
// Walks the IFC hierarchy to find assembly groupings.
// Two strategies (like Trimble Connect for Windows):
// 1. IfcElementAssembly nodes → explicit assembly grouping
// 2. Parent-child relationships → any parent node can serve as assembly grouping
// Also stores a parentMap for fallback: object → its direct parent node
let hierarchyParentMap = new Map(); // "modelId:childId" → { id, name, class, modelId }

async function buildAssemblyHierarchyMap(models) {
  assemblyMembershipMap.clear();
  assemblyChildrenMap.clear();
  assemblyNodeInfoMap.clear();
  hierarchyParentMap.clear();

  if (!viewerRef || !models || models.length === 0) return;

  for (const model of models) {
    const modelId = model.id || model;
    try {
      // getHierarchyChildren(modelId, entityIds, hierarchyType, recursive)
      // NOTE: The 3rd argument is HierarchyType (not "depth").
      // If we pass a wrong HierarchyType, assembly membership mapping becomes incomplete,
      // causing many objects to fall back to "(Không xác định)".
      const HierarchyType = {
        Unknown: 0,
        SpatialHierarchy: 1,
        SpatialContainment: 2,
        Containment: 3,
        ElementAssembly: 4,
        Group: 5,
        System: 6,
        Zone: 7,
        VoidsElement: 8,
        FillsElement: 9,
        ConnectsPortToElement: 10,
        ConnectsPorts: 11,
        ServicesBuildings: 12,
        Positions: 13,
      };

      // 1) Build general parent->child relationships from spatial hierarchy
      const spatialRootNodes = await viewerRef.getHierarchyChildren(
        modelId,
        [0],
        HierarchyType.SpatialHierarchy,
        true,
      );
      if (!spatialRootNodes || spatialRootNodes.length === 0) continue;

      // Debug: log the first few hierarchy nodes to understand structure
      if (!window._hierDebugDone) {
        window._hierDebugDone = true;
        function logTree(nodes, depth = 0) {
          if (depth > 3) return; // limit depth for logging
          for (const n of nodes.slice(0, 5)) {
            console.log(
              `[HIERARCHY][spatial] ${"  ".repeat(depth)}${n.class || "?"} | name="${n.name || ""}" | id=${n.id} | children=${n.children ? n.children.length : 0}`,
            );
            if (n.children && n.children.length > 0) {
              logTree(n.children, depth + 1);
            }
          }
        }
        logTree(spatialRootNodes);
      }

      // Walk spatial tree to fill hierarchyParentMap for all nodes
      function walkSpatialTree(nodes, parentNode) {
        for (const node of nodes) {
          if (parentNode) {
            hierarchyParentMap.set(`${modelId}:${node.id}`, {
              id: parentNode.id,
              name: parentNode.name || "",
              class: parentNode.class || "",
              modelId: modelId,
            });
          }

          if (node.children && node.children.length > 0) {
            walkSpatialTree(node.children, node);
          }
        }
      }

      walkSpatialTree(spatialRootNodes, null);

      // 2) Build assembly membership from element-assembly hierarchy
      const assemblyRootNodes = await viewerRef.getHierarchyChildren(
        modelId,
        [0],
        HierarchyType.ElementAssembly,
        true,
      );

      if (!assemblyRootNodes || assemblyRootNodes.length === 0) continue;

      // Walk assembly tree to fill assembly membership maps
      function walkAssemblyTree(nodes) {
        for (const node of nodes) {
          const nodeClass = (node.class || "").toLowerCase();

          // Strategy 1: IfcElementAssembly → explicit assembly grouping
          if (nodeClass === "ifcelementassembly" || nodeClass.includes("elementassembly")) {
            const assemblyKey = `${modelId}:${node.id}`;
            const childSet = new Set();

            // Store assembly node info for later enrichment
            assemblyNodeInfoMap.set(assemblyKey, {
              id: node.id,
              name: node.name || "",
              class: node.class || "",
              modelId: modelId,
            });

            function collectChildren(childNodes) {
              if (!childNodes) return;
              for (const child of childNodes) {
                childSet.add(child.id);
                assemblyMembershipMap.set(`${modelId}:${child.id}`, assemblyKey);
                if (child.children && child.children.length > 0) {
                  collectChildren(child.children);
                }
              }
            }

            if (node.children && node.children.length > 0) {
              collectChildren(node.children);
            }

            assemblyChildrenMap.set(assemblyKey, childSet);
            assemblyMembershipMap.set(`${modelId}:${node.id}`, assemblyKey);
          }

          if (node.children && node.children.length > 0) {
            walkAssemblyTree(node.children);
          }
        }
      }

      walkAssemblyTree(assemblyRootNodes);
    } catch (e) {
      console.warn(`[ObjectExplorer] buildAssemblyHierarchyMap failed for ${modelId}:`, e);
    }
  }

  console.log(`[ObjectExplorer] Assembly hierarchy: ${assemblyChildrenMap.size} IfcElementAssembly nodes, ${assemblyMembershipMap.size} mapped objects, ${hierarchyParentMap.size} parent-child relationships`);
}

// ── Enrich objects with assembly info from IFC hierarchy ──
// Uses cached hierarchy info — no extra API calls.
// Fixed logic: prevents duplicates in assembly groups and eliminates false "(Không xác định)" entries.
//
// Strategy 1: IfcElementAssembly membership → the correct Tekla assembly grouping
// Strategy 2: Direct parent node from assembly/element hierarchy → inherit parent's assemblyPos
// Strategy 3: Use secondary assembly properties (assemblyName, assembly)
// Strategy 4: For assembly nodes themselves, use their own name
//
// REMOVED: IFC Class-based grouping (was creating synthetic groups like "Beams", "Columns"
// that duplicated objects already assigned to real assembly groups)
async function enrichAssemblyFromHierarchy() {
  let enrichedFromAssembly = 0;
  let enrichedFromParent = 0;
  let enrichedFromName = 0;
  let skippedAlreadyHas = 0;

  // Build a lookup from objectId to object for quick access
  const objectMap = new Map();
  for (const obj of allObjects) {
    objectMap.set(`${obj.modelId}:${obj.id}`, obj);
  }

  for (const obj of allObjects) {
    if (obj.assemblyPos && obj.assemblyPos.trim()) {
      skippedAlreadyHas++;
      continue; // already has valid ASSEMBLY_POS from Tekla properties
    }

    const objectKey = `${obj.modelId}:${obj.id}`;

    // Strategy 1: Check explicit IfcElementAssembly membership first
    // This is the most accurate — Tekla exports assembly structure via IfcElementAssembly
    const assemblyKey = assemblyMembershipMap.get(objectKey);
    if (assemblyKey) {
      const nodeInfo = assemblyNodeInfoMap.get(assemblyKey);
      if (nodeInfo && nodeInfo.name && nodeInfo.name.trim()) {
        // Check if the assembly node itself has assemblyPos from Tekla properties
        const assemblyObj = objectMap.get(assemblyKey);
        if (assemblyObj && assemblyObj.assemblyPos && assemblyObj.assemblyPos.trim()) {
          // Inherit the assembly node's assemblyPos
          obj.assemblyPos = assemblyObj.assemblyPos;
        } else {
          obj.assemblyPos = nodeInfo.name;
        }
        if (!obj.assemblyName) obj.assemblyName = nodeInfo.name;
        if (!obj.assembly) obj.assembly = nodeInfo.name;
        obj.isTekla = true;
        enrichedFromAssembly++;
        continue;
      }
    }

    // Strategy 2: Use direct parent node from hierarchy
    // Only accept parent as assembly source if it's an assembly-type node (not building storey/site)
    const parentInfo = hierarchyParentMap.get(objectKey);
    if (parentInfo && parentInfo.name && parentInfo.name.trim()) {
      const parentClass = (parentInfo.class || "").toLowerCase();
      
      // Only use parent as assembly if it's an assembly or structural element container
      // NOT spatial structure like IfcBuildingStorey, IfcBuilding, IfcSite
      const isSpatialStructure = (
        parentClass.includes("ifcbuilding") && !parentClass.includes("proxy") ||
        parentClass.includes("ifcsite") ||
        parentClass.includes("ifcproject") ||
        parentClass.includes("ifcbuildingstorey") ||
        parentClass.includes("ifcspace")
      );
      
      const isAssemblyType = (
        parentClass.includes("assembly") ||
        parentClass.includes("ifcelementassembly")
      );
      
      if (isAssemblyType) {
        // Assembly parent — inherit its name
        const parentObj = objectMap.get(`${obj.modelId}:${parentInfo.id}`);
        if (parentObj && parentObj.assemblyPos && parentObj.assemblyPos.trim()) {
          obj.assemblyPos = parentObj.assemblyPos;
        } else {
          obj.assemblyPos = parentInfo.name;
        }
        if (!obj.assemblyName) obj.assemblyName = parentInfo.name;
        if (!obj.assembly) obj.assembly = parentInfo.name;
        enrichedFromParent++;
        continue;
      } else if (!isSpatialStructure) {
        // Structural element parent (beam, plate, etc.) — use as assembly
        obj.assemblyPos = parentInfo.name;
        if (!obj.assemblyName) obj.assemblyName = parentInfo.name;
        if (!obj.assembly) obj.assembly = parentInfo.name;
        enrichedFromParent++;
        continue;
      }
    }

    // Strategy 3: For assembly node objects themselves, use their own name
    const ifcClass = (obj.ifcClass || "").toLowerCase();
    if (ifcClass === "ifcelementassembly" || ifcClass.includes("elementassembly")) {
      if (obj.name && obj.name.trim()) {
        obj.assemblyPos = obj.name;
        enrichedFromName++;
        continue;
      }
    }

    // Strategy 4: Use secondary assembly properties if available
    if (!obj.assemblyPos) {
      if (obj.assemblyName && obj.assemblyName.trim()) {
        obj.assemblyPos = obj.assemblyName;
        enrichedFromName++;
        continue;
      } else if (obj.assembly && obj.assembly.trim()) {
        obj.assemblyPos = obj.assembly;
        enrichedFromName++;
        continue;
      }
    }

    // Strategy 5: Last resort — bolt/fastener objects use their bolt name or type
    if (!obj.assemblyPos && obj.isTeklaBolt) {
      const boltIdentifier = obj.boltFullName || obj.boltName || obj.boltStandard || obj.boltType;
      if (boltIdentifier && boltIdentifier.trim()) {
        obj.assemblyPos = boltIdentifier;
        enrichedFromName++;
        continue;
      }
    }

    // Objects without assemblyPos will appear in "(Không xác định)" — that's OK
    // as long as they DON'T also appear in another group (no duplicates)
  }

  const total = enrichedFromAssembly + enrichedFromParent + enrichedFromName;
  if (total > 0) {
    console.log(`[ObjectExplorer] Enriched from hierarchy: ${enrichedFromAssembly} from IfcElementAssembly, ${enrichedFromParent} from parent, ${enrichedFromName} from names (total: ${total}). Already had assemblyPos: ${skippedAlreadyHas}`);
  }
}

// Build human-readable display names for assembly groups
function buildAssemblyDisplayNames() {
  for (const obj of allObjects) {
    if (obj.assemblyPos) {
      // For Tekla: show ASSEMBLY_POS as the display name
      obj.assemblyDisplayName = obj.assemblyPos;
    } else if (obj.assembly) {
      obj.assemblyDisplayName = obj.assembly;
    } else {
      obj.assemblyDisplayName = "";
    }
  }
}

// ── Parse bolt dimension value (mm) ──
// Handles formats: "20", "M20", "20mm", "20.0", "M20x60", "Ø20"
function parseBoltDimension(value) {
  if (!value) return 0;
  const str = String(value).trim();
  if (!str) return 0;
  
  // Try to extract first number from the string
  // Handle M-prefix (metric bolt: M20 → 20)
  const mMatch = str.match(/[Mm](\d+(?:[.,]\d+)?)/);
  if (mMatch) return parseFloat(mMatch[1].replace(",", "."));
  
  // Handle Ø prefix
  const diaMatch = str.match(/[Øø∅](\d+(?:[.,]\d+)?)/);
  if (diaMatch) return parseFloat(diaMatch[1].replace(",", "."));
  
  // Generic number extraction
  const numMatch = str.match(/(\d+(?:[.,]\d+)?)/);
  if (numMatch) return parseFloat(numMatch[1].replace(",", "."));
  
  return 0;
}

// ── Classify Part Roles ──
// Assigns a partRole to each object based on Tekla hierarchy and IFC class:
// - assemblyContainer: IfcElementAssembly parent (container node)
// - mainPart: Tekla main part (MAIN_PART=yes or first/largest part in assembly)
// - secondaryPart: other structural parts within assembly
// - bolt: IfcMechanicalFastener, IfcBolt, etc.
// - accessory: IfcDiscreteAccessory (plates, clips, etc.)
// - standalone: objects not part of any assembly
function classifyPartRoles() {
  let classified = { assemblyContainer: 0, mainPart: 0, secondaryPart: 0, bolt: 0, accessory: 0, standalone: 0 };

  for (const obj of allObjects) {
    const cls = (obj.ifcClass || "").toLowerCase();

    // 1. Assembly container nodes
    if (obj.isAssemblyParent && (cls === "ifcelementassembly" || cls.includes("elementassembly"))) {
      obj.partRole = "assemblyContainer";
      classified.assemblyContainer++;
      continue;
    }

    // 2. Bolts / Fasteners
    if (obj.isTeklaBolt) {
      obj.partRole = "bolt";
      classified.bolt++;
      continue;
    }

    // 3. Discrete accessories
    if (cls.includes("ifcdiscreteaccessory")) {
      obj.partRole = "accessory";
      classified.accessory++;
      continue;
    }

    // 4. Main part (explicit flag from Tekla)
    if (obj.isMainPart) {
      obj.partRole = "mainPart";
      classified.mainPart++;
      continue;
    }

    // 5. Assembly components (parts within an assembly)
    if (obj.isAssemblyComponent) {
      // Try to determine if this is a main part by checking:
      // - Has the same name as assemblyPos (convention: main part name = assembly name)
      // - Is the heaviest part in its assembly group
      // For now, classify as secondaryPart; mainPart detection is refined below
      obj.partRole = "secondaryPart";
      classified.secondaryPart++;
      continue;
    }

    // 6. Standalone objects (not part of any assembly)
    if (!obj.assemblyPos && !obj.isAssemblyComponent) {
      obj.partRole = "standalone";
      classified.standalone++;
      continue;
    }

    // Default: secondary part
    obj.partRole = "secondaryPart";
    classified.secondaryPart++;
  }

  // Second pass: auto-detect main parts for assemblies missing MAIN_PART flag
  // Strategy: within each assembly group, the heaviest part is likely the main part
  const assemblyGroups = new Map(); // assemblyInstanceId → [objects]
  for (const obj of allObjects) {
    if (!obj.assemblyInstanceId || obj.partRole === "assemblyContainer" || obj.partRole === "bolt" || obj.partRole === "accessory") continue;
    if (!assemblyGroups.has(obj.assemblyInstanceId)) {
      assemblyGroups.set(obj.assemblyInstanceId, []);
    }
    assemblyGroups.get(obj.assemblyInstanceId).push(obj);
  }

  let autoMainParts = 0;
  for (const [asmId, parts] of assemblyGroups) {
    // Skip if any part is already marked as mainPart
    if (parts.some(p => p.partRole === "mainPart")) continue;
    if (parts.length === 0) continue;

    // Find the heaviest part (most likely the main part)
    let heaviest = parts[0];
    for (const p of parts) {
      if (p.weight > heaviest.weight) heaviest = p;
    }

    // Only auto-classify if there are multiple parts in the assembly
    if (parts.length > 1) {
      heaviest.partRole = "mainPart";
      heaviest.isMainPart = true;
      autoMainParts++;
    }
  }

  console.log(
    `[ObjectExplorer] Part roles: ${classified.assemblyContainer} containers, ` +
    `${classified.mainPart + autoMainParts} main parts (${autoMainParts} auto-detected), ` +
    `${classified.secondaryPart - autoMainParts} secondary, ${classified.bolt} bolts, ` +
    `${classified.accessory} accessories, ${classified.standalone} standalone`
  );
}

// Parses numeric quantity values returned from Trimble Connect.
// Handles cases like "0,12", "1,234.56", "1.234,56", "12.3 m³", etc.
function parseQuantityNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;

  const raw = String(value).trim();
  if (!raw) return NaN;

  // Extract the first numeric-like token.
  const m = raw.match(/[-+]?\d[\d.,]*/);
  if (!m) return NaN;

  let numStr = m[0];
  const hasDot = numStr.includes(".");
  const hasComma = numStr.includes(",");

  if (hasDot && hasComma) {
    // Decimal separator is whichever appears last.
    const lastDot = numStr.lastIndexOf(".");
    const lastComma = numStr.lastIndexOf(",");
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandSep = decimalSep === "." ? "," : ".";
    numStr = numStr.replace(new RegExp("\\" + thousandSep, "g"), "");
    if (decimalSep === ",") numStr = numStr.replace(",", ".");
  } else if (hasComma && !hasDot) {
    const parts = numStr.split(",");
    if (parts.length === 2 && parts[1].length === 3) numStr = parts.join("");
    else numStr = numStr.replace(",", ".");
  }

  const n = parseFloat(numStr);
  return Number.isFinite(n) ? n : NaN;
}

// ── Tekla Bolt & Fastener Property Detector ──
// Identifies and extracts ALL Tekla Bolt properties from IFC property sets.
// Covers: BOLT_STANDARD, BOLT_FULL_NAME, BOLT_SHORT_NAME, BOLT_SIZE, BOLT_LENGTH,
// BOLT_MATERIAL_LENGTH, BOLT_THREAD_LENGTH, BOLT_NPARTS, BOLT_COUNTERSUNK,
// BOLT_EDGE_DISTANCE, BOLT_EDGE_DISTANCE_MIN, NUT_COUNT, NUT_TYPE, NUT_NAME,
// WASHER_COUNT, WASHER_TYPE, WASHER_NAME, BOLT_COUNT, and more.
// Also detects objects from IFC class: IfcMechanicalFastener, IfcDiscreteAccessory, IfcFastener
function detectTeklaBoltProperties(props, modelId) {
  const boltProps = {
    isTeklaBolt: false,
    boltType: "",
    boltName: "",
    boltSize: "",
    boltGrade: "",
    boltStandard: "",
    boltFullName: "",
    boltShortName: "",
    boltLength: "",
    boltThreadLength: "",
    boltMaterialLength: "",
    boltCount: 0,
    boltNParts: 0,
    boltCountersunk: false,
    boltEdgeDistance: "",
    boltEdgeDistanceMin: "",
    washerType: "",
    washerName: "",
    washerCount: 0,
    nutType: "",
    nutName: "",
    nutCount: 0,
    tightened: false,
    comments: "",
    allBoltProperties: {}, // Store all detected bolt-related properties
  };

  // ── Step 1: Detect from IFC class ──
  const ifcClass = (props.class || "").toLowerCase();
  const BOLT_IFC_CLASSES = [
    "ifcmechanicalfastener", "ifcmechanicalfastenertype",
    "ifcdiscreteaccessory", "ifcdiscreteaccessorytype",
    "ifcfastener", "ifcfastenertype",
    "ifcbolt", "ifcbolttype",
    "ifcboltgroup", "ifcboltgrouptype",
    "ifcboltassembly", "ifcboltassemblytype",
  ];
  if (BOLT_IFC_CLASSES.some(cls => ifcClass.includes(cls))) {
    boltProps.isTeklaBolt = true;
  }

  // ── Step 2: Detect from product info ──
  if (props.product) {
    const productName = (props.product.name || "").toLowerCase();
    const productType = (props.product.objectType || "").toLowerCase();
    const productDesc = (props.product.description || "").toLowerCase();
    if (
      productName.includes("bolt") || productName.includes("nut") ||
      productName.includes("washer") || productName.includes("fastener") ||
      productName.includes("anchor") || productName.includes("screw") ||
      productType.includes("bolt") || productType.includes("fastener") ||
      productType.includes("mechanicalfastener") ||
      productDesc.includes("bolt") || productDesc.includes("fastener")
    ) {
      boltProps.isTeklaBolt = true;
      if (!boltProps.boltName && props.product.name) boltProps.boltName = props.product.name;
    }
  }

  // ── Step 3: Scan all property sets ──
  const propertySets = props.properties || [];

  // Property set names that indicate bolt/fastener data
  const BOLT_PSET_PATTERNS = [
    "bolt", "fastener", "mechanicalfastener",
    "pset_mechanicalfastenerbolt", "pset_mechanicalfastenercommon",
    "teklacommon", "tekla common", "tekla_common",
    "teklaquantity", "tekla quantity", "tekla_quantity",
    "teklaassembly", "tekla assembly", "tekla_assembly",
    "bolt assembly catalog", "boltassemblycatalog",
    "connection", "discreteaccessory",
  ];

  for (const pSet of propertySets) {
    const setName = (pSet.name || "").toLowerCase();
    const setNameNorm = setName.replace(/[\s_.\-]/g, "");
    const properties = pSet.properties || [];

    // Check if this property set is bolt-related
    const isBoltPropSet = BOLT_PSET_PATTERNS.some(p => 
      setNameNorm.includes(p.replace(/[\s_.\-]/g, ""))
    );

    for (const prop of properties) {
      const propNameRaw = prop.name || "";
      const propNameLower = propNameRaw.toLowerCase();
      const propValue = String(prop.value ?? "").trim();
      if (!propValue) continue;

      // Normalize: strip dots, underscores, spaces, hyphens, parens
      const norm = propNameLower.replace(/[\s_.\-()]/g, "");

      // Store all properties from bolt-related property sets
      if (isBoltPropSet) {
        boltProps.allBoltProperties[propNameRaw] = propValue;
      }

      // ═══ BOLT STANDARD ═══
      if (norm === "boltstandard" || norm === "standard" && isBoltPropSet) {
        boltProps.boltStandard = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT FULL NAME ═══
      if (norm === "boltfullname" || norm === "fullname" && isBoltPropSet) {
        boltProps.boltFullName = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT SHORT NAME ═══
      if (norm === "boltshortname" || norm === "shortname" && isBoltPropSet) {
        boltProps.boltShortName = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT NAME ═══
      if (
        norm === "boltname" ||
        (norm === "name" && isBoltPropSet && !boltProps.boltName)
      ) {
        boltProps.boltName = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT TYPE ═══
      if (
        norm === "bolttype" ||
        (norm === "type" && isBoltPropSet && !boltProps.boltType) ||
        norm === "predefinedtype" && ifcClass.includes("fastener")
      ) {
        boltProps.boltType = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT SIZE / DIAMETER ═══
      if (
        norm === "boltsize" || norm === "boltdiameter" ||
        norm === "nominaldiameter" ||
        (norm === "size" && isBoltPropSet) ||
        (norm === "diameter" && isBoltPropSet)
      ) {
        boltProps.boltSize = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT LENGTH ═══
      if (
        norm === "boltlength" ||
        (norm === "nominallength" && isBoltPropSet) ||
        (norm === "length" && isBoltPropSet && !boltProps.boltLength)
      ) {
        boltProps.boltLength = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT THREAD LENGTH ═══
      if (norm === "boltthreadlength" || norm === "threadlength") {
        boltProps.boltThreadLength = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT MATERIAL LENGTH ═══
      if (norm === "boltmateriallength" || norm === "materiallength") {
        boltProps.boltMaterialLength = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT GRADE ═══
      if (
        norm === "boltgrade" ||
        (norm === "grade" && isBoltPropSet)
      ) {
        boltProps.boltGrade = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT COUNT ═══
      if (
        norm === "boltcount" || norm === "numberofbolts" ||
        norm === "boltnumber" || norm === "quantity" && isBoltPropSet
      ) {
        const count = parseQuantityNumber(propValue);
        if (!isNaN(count) && count > 0) {
          boltProps.boltCount = Math.floor(count);
          boltProps.isTeklaBolt = true;
        }
      }

      // ═══ BOLT NPARTS ═══
      if (norm === "boltnparts" || norm === "nparts") {
        const n = parseQuantityNumber(propValue);
        if (!isNaN(n) && n > 0) {
          boltProps.boltNParts = Math.floor(n);
          boltProps.isTeklaBolt = true;
        }
      }

      // ═══ BOLT COUNTERSUNK ═══
      if (norm === "boltcountersunk" || norm === "countersunk") {
        boltProps.boltCountersunk =
          propValue.toLowerCase() === "yes" ||
          propValue.toLowerCase() === "true" ||
          propValue === "1";
        boltProps.isTeklaBolt = true;
      }

      // ═══ BOLT EDGE DISTANCE ═══
      if (norm === "boltedgedistance" || norm === "edgedistance") {
        boltProps.boltEdgeDistance = propValue;
        boltProps.isTeklaBolt = true;
      }
      if (norm === "boltedgedistancemin" || norm === "edgedistancemin") {
        boltProps.boltEdgeDistanceMin = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ WASHER TYPE ═══
      if (
        norm === "washertype" || norm === "washername" ||
        (norm.includes("washer") && norm.includes("type"))
      ) {
        boltProps.washerType = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ WASHER NAME ═══
      if (norm === "washername" && !boltProps.washerName) {
        boltProps.washerName = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ WASHER COUNT ═══
      if (
        norm === "washercount" || norm === "numberofwashers" ||
        (norm.includes("washer") && norm.includes("count"))
      ) {
        const count = parseQuantityNumber(propValue);
        if (!isNaN(count) && count > 0) {
          boltProps.washerCount = Math.floor(count);
          boltProps.isTeklaBolt = true;
        }
      }

      // ═══ NUT TYPE ═══
      if (
        norm === "nuttype" || norm === "nutname" ||
        (norm.includes("nut") && norm.includes("type"))
      ) {
        boltProps.nutType = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ NUT NAME ═══
      if (norm === "nutname" && !boltProps.nutName) {
        boltProps.nutName = propValue;
        boltProps.isTeklaBolt = true;
      }

      // ═══ NUT COUNT ═══
      if (
        norm === "nutcount" || norm === "numberofnuts" ||
        (norm.includes("nut") && norm.includes("count"))
      ) {
        const count = parseQuantityNumber(propValue);
        if (!isNaN(count) && count > 0) {
          boltProps.nutCount = Math.floor(count);
          boltProps.isTeklaBolt = true;
        }
      }

      // ═══ TIGHTENED STATUS ═══
      if (
        norm === "tightened" || norm === "tightenedtorque" ||
        norm === "preloaded" || norm === "pretensioned"
      ) {
        boltProps.tightened =
          propValue.toLowerCase() === "yes" ||
          propValue.toLowerCase() === "true" ||
          propValue === "1";
        boltProps.isTeklaBolt = true;
      }

      // ═══ COMMENTS ═══
      if (norm === "comment" || norm === "comments" || norm === "notes" || norm === "remark") {
        if (!boltProps.comments) boltProps.comments = propValue;
      }

      // ═══ Auto-detect bolt by property name patterns ═══
      if (
        norm.startsWith("bolt") ||
        (isBoltPropSet && (
          norm.includes("fastener") || norm.includes("washer") || norm.includes("nut")
        ))
      ) {
        boltProps.isTeklaBolt = true;
        // Store any unrecognized bolt property
        if (!boltProps.allBoltProperties[propNameRaw]) {
          boltProps.allBoltProperties[propNameRaw] = propValue;
        }
      }
    }
  }

  return boltProps;
}

// ObjectProperties: { id: number, class?: string, product?: Product, properties?: PropertySet[] }
// Product: { name?: string, description?: string, objectType?: string }
// PropertySet: { name?: string, properties?: Property[] }
// Property: { name: string, value: string|number, type: PropertyType }
function parseObjectProperties(props, modelId) {
  const result = {
    id: props.id,
    modelId,
    name: "",
    assembly: "",
    assemblyName: "",     // ASSEMBLY_NAME from Tekla
    assemblyPos: "",      // ASSEMBLY_POS from Tekla (unique per assembly instance)
    assemblyPosCode: "",  // ASSEMBLY_POSITION_CODE from Tekla
    group: "",
    type: "",
    material: "",
    volume: 0,
    weight: 0,
    area: 0,
    length: 0,
    profile: "",
    referenceName: "",    // Reference / Reference Name from IFC
    productName: "",      // Product Name
    productObjectType: "", // Product Object Type
    ifcClass: props.class || "",
    isTekla: false,
    isAssemblyParent: false,     // Marked as IfcElementAssembly or assembly parent node
    isAssemblyComponent: false,  // Marked as component/child of an assembly
    isAssemblyAggregate: false,  // Marked: quantities zeroed to prevent double-counting
    // ── Tekla Part Hierarchy ──
    partPos: "",          // PART_POS from Tekla (unique per part)
    isMainPart: false,    // MAIN_PART flag from Tekla
    partRole: "",         // Classified role: mainPart, secondaryPart, bolt, accessory, assemblyContainer
    phase: "",            // PHASE from Tekla
    hierarchyLevel: "",   // HIERARCHY_LEVEL from Tekla
    // ── Preserved original quantities (before assembly zeroing) ──
    originalWeight: 0,
    originalVolume: 0,
    originalArea: 0,
    // ── Tekla Bolt Properties (comprehensive) ──
    isTeklaBolt: false,
    boltEstimated: false,  // If true, quantities were estimated from bolt dimensions
    boltType: "",
    boltName: "",
    boltSize: "",
    boltGrade: "",
    boltStandard: "",
    boltFullName: "",
    boltShortName: "",
    boltLength: "",
    boltThreadLength: "",
    boltMaterialLength: "",
    boltCount: 0,
    boltNParts: 0,
    boltCountersunk: false,
    boltEdgeDistance: "",
    boltEdgeDistanceMin: "",
    washerType: "",
    washerName: "",
    washerCount: 0,
    nutType: "",
    nutName: "",
    nutCount: 0,
    boltTightened: false,
    boltComments: "",
    allBoltProperties: {}, // All detected bolt properties
    rawProperties: [], // [{pset, name, value}] for debug/export
  };

  // ── Detect Tekla Bolt Properties (comprehensive) ──
  const boltProps = detectTeklaBoltProperties(props, modelId);
  if (boltProps.isTeklaBolt) {
    result.isTeklaBolt = true;
    result.boltType = boltProps.boltType;
    result.boltName = boltProps.boltName;
    result.boltSize = boltProps.boltSize;
    result.boltGrade = boltProps.boltGrade;
    result.boltStandard = boltProps.boltStandard;
    result.boltFullName = boltProps.boltFullName;
    result.boltShortName = boltProps.boltShortName;
    result.boltLength = boltProps.boltLength;
    result.boltThreadLength = boltProps.boltThreadLength;
    result.boltMaterialLength = boltProps.boltMaterialLength;
    result.boltCount = boltProps.boltCount;
    result.boltNParts = boltProps.boltNParts;
    result.boltCountersunk = boltProps.boltCountersunk;
    result.boltEdgeDistance = boltProps.boltEdgeDistance;
    result.boltEdgeDistanceMin = boltProps.boltEdgeDistanceMin;
    result.washerType = boltProps.washerType;
    result.washerName = boltProps.washerName;
    result.washerCount = boltProps.washerCount;
    result.nutType = boltProps.nutType;
    result.nutName = boltProps.nutName;
    result.nutCount = boltProps.nutCount;
    result.boltTightened = boltProps.tightened;
    result.boltComments = boltProps.comments;
    result.allBoltProperties = boltProps.allBoltProperties;
    result.isTekla = true; // Mark as Tekla if it has bolt properties
  }

  // Product info (standardized)
  if (props.product) {
    result.name = props.product.name || "";
    result.type = props.product.objectType || props.class || "";
    result.productName = props.product.name || "";
    result.productObjectType = props.product.objectType || "";
  }

  // IFC Class as type fallback
  if (!result.type && props.class) {
    result.type = props.class;
  }

  // Auto-detect bolt from IFC class (before property parsing)
  const ifcClassLower = (props.class || "").toLowerCase();
  const BOLT_IFC_CLASSES_PARSE = [
    "ifcmechanicalfastener", "ifcmechanicalfastenertype",
    "ifcdiscreteaccessory", "ifcdiscreteaccessorytype",
    "ifcfastener", "ifcfastenertype",
    "ifcbolt", "ifcbolttype",
    "ifcboltgroup", "ifcboltgrouptype",
    "ifcboltassembly", "ifcboltassemblytype",
  ];
  if (BOLT_IFC_CLASSES_PARSE.some(cls => ifcClassLower.includes(cls))) {
    result.isTeklaBolt = true;
    result.isTekla = true;
  }

  // Parse property sets
  const propertySets = props.properties || [];
  for (const pSet of propertySets) {
    const setName = (pSet.name || "").toLowerCase();
    const properties = pSet.properties || [];

    // Detect Tekla Structures origin by property set name
    if (
      setName.includes("tekla") ||
      setName === "teklaquantity" ||
      setName === "teklacommon" ||
      setName === "tekla common" ||
      setName === "tekla_bim" ||
      setName === "tekla quantity"
    ) {
      result.isTekla = true;
    }

    // Also detect Tekla from assembly-related properties in any property set
    if (!result.isTekla) {
      for (const p of properties) {
        if (classifyAssemblyProperty(p.name || "")) {
          result.isTekla = true;
          break;
        }
      }
    }

    for (const prop of properties) {
      const propName = (prop.name || "").toLowerCase();
      const propValue = prop.value;
      const propType = prop.type;

      // Name (if not already set from product)
      if (!result.name && (propName === "name" || propName === "tên")) {
        result.name = String(propValue || "");
      }

      // ── Assembly Properties Detection (using centralized classifier) ──
      const rawPropName = prop.name || "";
      const asmVal = String(propValue || "").trim();

      if (asmVal) {
        // Store raw properties for export
        result.rawProperties.push({ pset: pSet.name || "", name: rawPropName, value: asmVal });

        // Classify the property
        const asmClass = classifyAssemblyProperty(rawPropName);

        if (asmClass === "pos" && !result.assemblyPos) {
          result.assemblyPos = asmVal;
          console.log(`[ASM] Object ${props.id}: assemblyPos = "${asmVal}" (from "${rawPropName}")`);
        } else if (asmClass === "mark" && !result.assemblyPos) {
          // ASSEMBLY_MARK is used as assemblyPos fallback (unique per assembly)
          result.assemblyPos = asmVal;
          console.log(`[ASM] Object ${props.id}: assemblyPos(mark) = "${asmVal}" (from "${rawPropName}")`);
        } else if (asmClass === "name" && !result.assemblyName) {
          result.assemblyName = asmVal;
        } else if (asmClass === "code" && !result.assemblyPosCode) {
          result.assemblyPosCode = asmVal;
        } else if (asmClass === "generic" && !result.assembly) {
          result.assembly = asmVal;
        }
      }

      // Group
      if (
        propName === "group" ||
        propName === "nhóm" ||
        propName === "groupname" ||
        propName === "group name"
      ) {
        if (!result.group) result.group = String(propValue || "");
      }

      // Material
      if (
        propName === "material" ||
        propName === "vật liệu" ||
        propName === "materials" ||
        propName === "materialname"
      ) {
        if (!result.material) result.material = String(propValue || "");
      }

      // Volume (PropertyType.VolumeMeasure = 2, value in m³)
      const normalizedVolume = propName
        .replace(/[\s_.\-]/g, "")
        .replace(/[()]/g, "");
      if (
        propType === 2 ||
        propName === "volume" ||
        propName === "thể tích" ||
        propName === "grossvolume" ||
        propName === "netvolume" ||
        propName === "net volume" ||
        propName === "gross volume" ||
        normalizedVolume === "volume" ||
        normalizedVolume === "grossvolume" ||
        normalizedVolume === "netvolume" ||
        normalizedVolume === "totalvolume" ||
        normalizedVolume.includes("volume") ||
        // IFC BaseQuantities
        propName === "nominalvolume" ||
        propName === "nominal volume" ||
        normalizedVolume === "nominalvolume"
      ) {
        const v = parseQuantityNumber(propValue);
        if (!isNaN(v) && v > result.volume) result.volume = v;
      }

      // Weight (PropertyType.MassMeasure = 3, value in kg)
      const normalizedWeight = propName.replace(/[\s_.\-]/g, "").replace(/[()]/g, "");
      if (
        propType === 3 ||
        propName === "weight" ||
        propName === "khối lượng" ||
        propName === "grossweight" ||
        propName === "netweight" ||
        propName === "mass" ||
        propName === "trọng lượng" ||
        normalizedWeight.includes("weight") ||
        normalizedWeight.includes("mass") ||
        // IFC BaseQuantities
        normalizedWeight === "nominalmass" ||
        normalizedWeight === "nominalweight" ||
        normalizedWeight === "grossmass" ||
        normalizedWeight === "netmass" ||
        normalizedWeight === "totalmass" ||
        normalizedWeight === "totalweight"
      ) {
        const w = parseQuantityNumber(propValue);
        if (!isNaN(w) && w > 0 && w > result.weight) result.weight = w;
      }

      // Surface Area (m²) — only match actual surface area properties,
      // NOT cross-section area, reinforcement area, etc.
      const normalizedArea = propName.replace(/[\s_.\-]/g, "").replace(/[()]/g, "");
      const isCrossSectionArea = normalizedArea.includes("crosssection") ||
        normalizedArea.includes("reinforcement") ||
        normalizedArea.includes("rebar");
      if (
        !isCrossSectionArea && (
          propName === "area" ||
          propName === "diện tích" ||
          propName === "diện tích bề mặt" ||
          propName === "surfacearea" ||
          propName === "surface area" ||
          propName === "netsurfacearea" ||
          propName === "net surface area" ||
          propName === "grosssurfacearea" ||
          propName === "gross surface area" ||
          propName === "totalsurfacearea" ||
          propName === "total surface area" ||
          propName === "outersurfacearea" ||
          propName === "outer surface area" ||
          propName === "netarea" ||
          propName === "grossarea" ||
          propName === "totalarea" ||
          normalizedArea === "area" ||
          normalizedArea === "surfacearea" ||
          normalizedArea === "netsurfacearea" ||
          normalizedArea === "grosssurfacearea" ||
          normalizedArea === "totalsurfacearea" ||
          normalizedArea === "outersurfacearea" ||
          normalizedArea === "netarea" ||
          normalizedArea === "grossarea" ||
          normalizedArea === "totalarea" ||
          // IFC BaseQuantities for various element types
          normalizedArea === "nominalarea" ||
          normalizedArea === "nominalsurfacearea" ||
          normalizedArea === "footprintarea" ||
          normalizedArea === "projectedarea" ||
          normalizedArea === "lateralarea" ||
          normalizedArea === "lateralsurfacearea" ||
          // Specific element area quantities
          normalizedArea === "netsidearea" ||
          normalizedArea === "grosssidearea" ||
          normalizedArea === "netfloorarea" ||
          normalizedArea === "grossfloorarea" ||
          normalizedArea === "netceilingarea" ||
          normalizedArea === "grossceilingarea"
        )
      ) {
        const a = parseQuantityNumber(propValue);
        if (!isNaN(a) && a > result.area) result.area = a;
      }

      // Length (m)
      const normalizedLength = propName
        .replace(/[\s_.\-]/g, "")
        .replace(/[()]/g, "");
      if (
        propType === 0 ||
        propName === "length" ||
        propName === "chiều dài" ||
        propName === "span" ||
        propName === "overalllength" ||
        propName === "netlength" ||
        propName === "totallength" ||
        propName === "height" ||
        propName === "chiều cao" ||
        normalizedLength.includes("length") ||
        // IFC BaseQuantities
        normalizedLength === "nominallength" ||
        normalizedLength === "nominalheight" ||
        normalizedLength === "nominalwidth" ||
        normalizedLength === "overallheight" ||
        normalizedLength === "overallwidth" ||
        normalizedLength === "depth" ||
        normalizedLength === "nominaldepth"
      ) {
        const l = parseQuantityNumber(propValue);
        if (!isNaN(l) && l > result.length) result.length = l;
      }

      // Profile
      const propNameNorm = propName.replace(/[\s_.\-]/g, "").replace(/[()]/g, "");
      if (
        propName === "profile" ||
        propName === "profilename" ||
        propName === "profile name" ||
        propName === "profiletype" ||
        propName === "profile_name" ||
        propName === "cross section" ||
        propName === "section" ||
        propName === "sectionname" ||
        propName === "section_name" ||
        propName === "crosssectionarea" ||
        propNameNorm === "profilename" ||
        propNameNorm === "profile"
      ) {
        if (!result.profile) result.profile = String(propValue || "");
      }

      // Reference Name
      if (
        propName === "reference" ||
        propName === "referencename" ||
        propName === "reference name" ||
        propName === "reference_name" ||
        propNameNorm === "reference" ||
        propNameNorm === "referencename"
      ) {
        if (!result.referenceName) result.referenceName = String(propValue || "");
      }

      // Detect Tekla via assembly-related property names (using classifier)
      if (!result.isTekla && classifyAssemblyProperty(rawPropName)) {
        result.isTekla = true;
      }

      // Type from property
      if (
        !result.type &&
        (propName === "objecttype" ||
          propName === "type" ||
          propName === "ifctype" ||
          propName === "typename")
      ) {
        result.type = String(propValue || "");
      }

      // ── Tekla Part Hierarchy Properties ──
      const propNameNormForPart = propName.replace(/[\s_.\-]/g, "").replace(/[()]/g, "");
      
      // PART_POS (unique per part within assembly)
      if (
        propNameNormForPart === "partpos" ||
        propNameNormForPart === "partposition" ||
        propNameNormForPart === "partmark" ||
        propName === "part_pos" ||
        propName === "part pos"
      ) {
        if (!result.partPos) result.partPos = String(propValue || "");
      }

      // MAIN_PART flag
      if (
        propNameNormForPart === "mainpart" ||
        propNameNormForPart === "ismainpart" ||
        propName === "main_part" ||
        propName === "main part"
      ) {
        const val = String(propValue || "").toLowerCase();
        result.isMainPart = (val === "yes" || val === "true" || val === "1" || val === "main");
      }

      // PHASE
      if (
        propNameNormForPart === "phase" ||
        propName === "phase" ||
        propName === "giai đoạn"
      ) {
        if (!result.phase) result.phase = String(propValue || "");
      }

      // HIERARCHY_LEVEL
      if (
        propNameNormForPart === "hierarchylevel" ||
        propNameNormForPart === "hierarchy" ||
        propName === "hierarchy_level"
      ) {
        if (!result.hierarchyLevel) result.hierarchyLevel = String(propValue || "");
      }
    }
  }

  // Fallback: use product description as assembly if still empty
  if (!result.assembly && props.product && props.product.description) {
    const desc = props.product.description.trim();
    if (desc && desc !== result.name) {
      result.assembly = desc;
    }
  }

  // If assemblyPos is missing but we have assemblyName/assembly,
  // use them as assemblyPos so grouping by "assemblyPos" won't produce "(Không xác định)".
  if (!result.assemblyPos || result.assemblyPos === "(Không xác định)") {
    if (result.assemblyName && result.assemblyName !== "(Không xác định)") {
      result.assemblyPos = result.assemblyName;
    } else if (
      result.assemblyPosCode &&
      result.assemblyPosCode !== "(Không xác định)"
    ) {
      // Some Tekla bolts/connections may export only assembly position code.
      result.assemblyPos = result.assemblyPosCode;
    } else if (result.assembly && result.assembly !== "(Không xác định)") {
      result.assemblyPos = result.assembly;
    }
  }

  // Fallback name
  if (!result.name) result.name = `Object ${props.id}`;

  // Calculate weight from volume if not provided
  // Use material-appropriate density:
  // - Steel: 7850 kg/m³
  // - Concrete: 2400 kg/m³
  // - Default: 7850 kg/m³ (steel assumed for structural elements)
  if (result.weight === 0 && result.volume > 0) {
    const matLower = (result.material || "").toLowerCase();
    const clsLower = (result.ifcClass || "").toLowerCase();
    let density = 7850; // default steel
    if (
      matLower.includes("concrete") || matLower.includes("bê tông") || matLower.includes("beton") ||
      clsLower === "ifcfooting" || clsLower === "ifcpile" ||
      clsLower === "ifcslab" || clsLower === "ifcwall" ||
      clsLower === "ifcwallstandardcase" ||
      clsLower === "ifcstair" || clsLower === "ifcstairflight" ||
      clsLower === "ifcramp" || clsLower === "ifcrampflight"
    ) {
      if (!matLower.includes("steel") && !matLower.includes("thép")) {
        density = 2400; // concrete
      }
    }
    if (matLower.includes("wood") || matLower.includes("gỗ") || matLower.includes("timber")) {
      density = 600; // wood
    }
    if (matLower.includes("aluminum") || matLower.includes("aluminium") || matLower.includes("nhôm")) {
      density = 2700; // aluminum
    }
    result.weight = result.volume * density;
  }

  return result;
}

// ── Search ──
function onSearchInput(e) {
  const query = e.target.value.trim();
  document.getElementById("search-clear-btn").style.display = query
    ? "block"
    : "none";

  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (!query) {
      filteredObjects = [...allObjects];
    } else {
      const q = query.toLowerCase();
      filteredObjects = allObjects.filter(
        (o) =>
          o.name.toLowerCase().includes(q) ||
          o.assembly.toLowerCase().includes(q) ||
          o.assemblyPos.toLowerCase().includes(q) ||
          o.assemblyName.toLowerCase().includes(q) ||
          o.assemblyPosCode.toLowerCase().includes(q) ||
          (o.assemblyDisplayName && o.assemblyDisplayName.toLowerCase().includes(q)) ||
          o.group.toLowerCase().includes(q) ||
          o.type.toLowerCase().includes(q) ||
          o.material.toLowerCase().includes(q) ||
          o.ifcClass.toLowerCase().includes(q) ||
          (o.profile && o.profile.toLowerCase().includes(q)) ||
          (o.referenceName && o.referenceName.toLowerCase().includes(q)) ||
          (o.boltStandard && o.boltStandard.toLowerCase().includes(q)) ||
          (o.boltFullName && o.boltFullName.toLowerCase().includes(q)) ||
          (o.boltName && o.boltName.toLowerCase().includes(q)) ||
          (o.boltType && o.boltType.toLowerCase().includes(q)) ||
          (o.productName && o.productName.toLowerCase().includes(q)),
      );
    }
    updateSummary();
    renderTree();
  }, 250);
}

function clearSearch() {
  document.getElementById("search-input").value = "";
  document.getElementById("search-clear-btn").style.display = "none";
  filteredObjects = [...allObjects];
  updateSummary();
  renderTree();
}

// ── Tree Rendering ──
function renderTree() {
  const container = document.getElementById("object-tree");
  const groupBy = document.getElementById("group-by-select").value;

  if (filteredObjects.length === 0) {
    container.innerHTML = "";
    showPlaceholder();
    return;
  }

  // Group objects
  const groups = {};
  for (const obj of filteredObjects) {
    const key = getGroupKey(obj, groupBy) || "(Không xác định)";
    if (!groups[key]) groups[key] = [];
    groups[key].push(obj);
  }

  const sortedKeys = Object.keys(groups).sort();

  let html = "";
  for (const key of sortedKeys) {
    const items = groups[key];
    // Check if all items in group are selected
    const allGroupUids = items.map((o) => `${o.modelId}:${o.id}`);
    const allChecked = allGroupUids.every((uid) => selectedIds.has(uid));
    const someChecked = allGroupUids.some((uid) => selectedIds.has(uid));

    // Add Assembly badge when grouping by assemblyPos
    const isAssemblyGroup = groupBy === "assemblyPos";
    const groupDisplayName = isAssemblyGroup ? `🏗️ ${escHtml(key)}` : escHtml(key);

    html += `<div class="tree-group" data-group="${escHtml(key)}">`;
    html += `<div class="tree-group-header">`;
    html += `<input type="checkbox" class="tree-group-checkbox" ${allChecked ? "checked" : ""} ${!allChecked && someChecked ? 'data-indeterminate="true"' : ""} title="Chọn/bỏ chọn nhóm" />`;
    html += `<span class="tree-toggle" onclick="this.closest('.tree-group').classList.toggle('collapsed')">▼</span>`;
    html += `<span class="tree-group-name" onclick="this.closest('.tree-group').classList.toggle('collapsed')">${groupDisplayName}</span>`;
    html += `<span class="tree-group-count" onclick="this.closest('.tree-group').classList.toggle('collapsed')">${items.length}</span>`;
    html += `</div>`;
    html += `<div class="tree-items">`;

    for (const obj of items) {
      const uid = `${obj.modelId}:${obj.id}`;
      const isSelected = selectedIds.has(uid);
      const displayLabel = getObjectDisplayName(obj);
      const tooltip = buildTooltip(obj);
      html += `<div class="tree-item${isSelected ? " selected" : ""}" data-uid="${escHtml(uid)}" data-model-id="${escHtml(obj.modelId)}" data-object-id="${obj.id}">`;
      html += `<input type="checkbox" class="tree-item-checkbox" ${isSelected ? "checked" : ""} />`;
      html += `<span class="tree-item-name" title="${escHtml(tooltip)}">${escHtml(displayLabel)}</span>`;
      
      // IFC Class badge (show element type for recognized structural/architectural elements)
      const ifcClassBadge = getIfcClassBadge(obj.ifcClass);
      if (ifcClassBadge) {
        html += `<span class="tree-item-badge ifc-class" title="${escHtml(obj.ifcClass)}">${ifcClassBadge}</span>`;
      }
      
      // Tekla Structures badge
      if (obj.isTekla) {
        html += `<span class="tree-item-badge tekla" title="Vẽ bằng Tekla Structures">🏗️</span>`;
      }
      
      // Profile badge
      if (obj.profile) {
        html += `<span class="tree-item-badge profile">${escHtml(obj.profile)}</span>`;
      } else if (obj.type) {
        html += `<span class="tree-item-badge">${escHtml(obj.type)}</span>`;
      }
      html += `</div>`;
    }

    html += `</div></div>`;
  }

  container.innerHTML = html;
  document.getElementById("groups-count").textContent =
    `${sortedKeys.length} nhóm`;

  // Set indeterminate state for group checkboxes (can't set via HTML attribute)
  container.querySelectorAll('.tree-group-checkbox[data-indeterminate="true"]').forEach((cb) => {
    cb.indeterminate = true;
  });

  // Bind group checkbox events (select/deselect all items in group) with Shift+click support
  const allGroups = Array.from(container.querySelectorAll(".tree-group"));
  allGroups.forEach((groupEl) => {
    const groupCb = groupEl.querySelector(".tree-group-checkbox");
    if (!groupCb) return;

    // Use click instead of change to access shiftKey
    groupCb.addEventListener("click", (e) => {
      const treeContainer = document.getElementById("object-tree");
      const savedScroll = treeContainer.scrollTop;
      const doSelect = groupCb.checked;

      if (e.shiftKey && lastClickedGroupEl !== null) {
        // Shift+click: apply same action (select or deselect) to range of groups
        const lastGroupIndex = allGroups.indexOf(lastClickedGroupEl);
        const currentGroupIndex = allGroups.indexOf(groupEl);
        if (lastGroupIndex >= 0 && currentGroupIndex >= 0) {
          const start = Math.min(lastGroupIndex, currentGroupIndex);
          const end = Math.max(lastGroupIndex, currentGroupIndex);
          const shiftDoSelect = lastGroupClickAction === "select";

          // Override the checkbox state to match the range action
          groupCb.checked = shiftDoSelect;

          for (let gi = start; gi <= end; gi++) {
            const g = allGroups[gi];
            const gCb = g.querySelector(".tree-group-checkbox");
            const gItems = g.querySelectorAll(".tree-item");
            if (gCb) {
              gCb.checked = shiftDoSelect;
              gCb.indeterminate = false;
            }
            gItems.forEach((item) => {
              const uid = item.dataset.uid;
              if (shiftDoSelect) {
                selectedIds.add(uid);
                item.classList.add("selected");
                item.querySelector(".tree-item-checkbox").checked = true;
              } else {
                selectedIds.delete(uid);
                item.classList.remove("selected");
                item.querySelector(".tree-item-checkbox").checked = false;
              }
            });
          }

          selectionFromPanel = true;
          updateSummary();
          notifySelectionChanged();
          applyHighlightColors();
          syncSelectionToViewer();
          treeContainer.scrollTop = savedScroll;
          return;
        }
      }

      // Normal click: select/deselect all items in this group
      const items = groupEl.querySelectorAll(".tree-item");
      items.forEach((item) => {
        const uid = item.dataset.uid;
        if (doSelect) {
          selectedIds.add(uid);
          item.classList.add("selected");
          item.querySelector(".tree-item-checkbox").checked = true;
        } else {
          selectedIds.delete(uid);
          item.classList.remove("selected");
          item.querySelector(".tree-item-checkbox").checked = false;
        }
      });

      groupCb.indeterminate = false;
      lastClickedGroupEl = groupEl;
      lastGroupClickAction = doSelect ? "select" : "deselect";
      selectionFromPanel = true;
      updateSummary();
      notifySelectionChanged();
      applyHighlightColors();
      syncSelectionToViewer();
      treeContainer.scrollTop = savedScroll;
    });
  });

  // Bind click events with Shift+click support (select AND deselect range)
  // Unified handler: works for both clicking the row and clicking the checkbox
  const allItems = Array.from(container.querySelectorAll(".tree-item"));
  allItems.forEach((el, index) => {
    el.addEventListener("click", (e) => {
      const treeContainer = document.getElementById("object-tree");
      const savedScroll = treeContainer.scrollTop;
      const isCheckboxClick = e.target.classList.contains("tree-item-checkbox");

      // ── Shift+click range selection ──
      if (e.shiftKey && lastClickedItem !== null) {
        const lastIndex = allItems.indexOf(lastClickedItem);
        if (lastIndex >= 0) {
          const start = Math.min(lastIndex, index);
          const end = Math.max(lastIndex, index);
          const doSelect = lastClickAction === "select";

          // If clicking checkbox, override browser's toggle to match range action
          if (isCheckboxClick) {
            e.target.checked = doSelect;
          }

          for (let i = start; i <= end; i++) {
            const item = allItems[i];
            const uid = item.dataset.uid;
            if (doSelect) {
              selectedIds.add(uid);
              item.classList.add("selected");
              item.querySelector(".tree-item-checkbox").checked = true;
            } else {
              selectedIds.delete(uid);
              item.classList.remove("selected");
              item.querySelector(".tree-item-checkbox").checked = false;
            }
          }
          selectionFromPanel = true;
          updateGroupCheckboxStates();
          updateSummary();
          notifySelectionChanged();
          applyHighlightColors();
          syncSelectionToViewer();
          treeContainer.scrollTop = savedScroll;
          return;
        }
      }

      // ── Normal click (no Shift) ──
      const uid = el.dataset.uid;

      if (isCheckboxClick) {
        // Checkbox was already toggled by browser before click event fires
        const newChecked = e.target.checked;
        lastClickAction = newChecked ? "select" : "deselect";
        if (newChecked) {
          selectedIds.add(uid);
          el.classList.add("selected");
        } else {
          selectedIds.delete(uid);
          el.classList.remove("selected");
        }
        lastClickedItem = el;
        selectionFromPanel = true;
        updateGroupCheckboxStates();
        updateSummary();
        notifySelectionChanged();
        applyHighlightColors();
        syncSelectionToViewer();
        treeContainer.scrollTop = savedScroll;
      } else {
        // Click on row text — toggle selection
        selectionFromPanel = true;
        lastClickAction = selectedIds.has(uid) ? "deselect" : "select";
        toggleSelection(uid, el);
        lastClickedItem = el;
        treeContainer.scrollTop = savedScroll;
      }
    });
  });

  // If some external action (e.g. "Thu gọn tất cả") changed list height,
  // reset scroll to the start so the UI doesn't clamp to the bottom.
  if (shouldScrollToTop) {
    if (container) container.scrollTop = 0;
    shouldScrollToTop = false;
  }
}

// ── Update group checkbox states after individual item changes ──
function updateGroupCheckboxStates() {
  document.querySelectorAll(".tree-group").forEach((groupEl) => {
    const groupCb = groupEl.querySelector(".tree-group-checkbox");
    if (!groupCb) return;
    const items = groupEl.querySelectorAll(".tree-item");
    const total = items.length;
    let checked = 0;
    items.forEach((item) => {
      if (selectedIds.has(item.dataset.uid)) checked++;
    });
    groupCb.checked = checked === total;
    groupCb.indeterminate = checked > 0 && checked < total;
  });
}

function toggleSelection(uid, el) {
  const treeContainer = document.getElementById("object-tree");
  const savedScroll = treeContainer ? treeContainer.scrollTop : 0;

  if (selectedIds.has(uid)) {
    selectedIds.delete(uid);
    el.classList.remove("selected");
    el.querySelector(".tree-item-checkbox").checked = false;
  } else {
    selectedIds.add(uid);
    el.classList.add("selected");
    el.querySelector(".tree-item-checkbox").checked = true;
  }
  updateGroupCheckboxStates();
  updateSummary();
  notifySelectionChanged();
  applyHighlightColors();
  syncSelectionToViewer();

  // Restore scroll position to prevent auto-scroll
  if (treeContainer) treeContainer.scrollTop = savedScroll;
}

// ── Select Assembly — select all objects sharing the same assembly as the selected object ──
// Flow: select 1 object → click Select Assembly → find its assembly group → select all objects in that group
async function selectAssembly() {
  if (!viewerRef) return;

  try {
    // Step 1: Get current selection from the viewer
    const viewerSel = await viewerRef.getSelection();
    console.log("[SelectAssembly] Viewer selection:", JSON.stringify(viewerSel).substring(0, 500));

    let selModelId = "";
    let selObjectIds = [];

    // Parse viewer selection format
    if (viewerSel && viewerSel.modelObjectIds) {
      for (const entry of viewerSel.modelObjectIds) {
        if (entry.modelId && (entry.objectRuntimeIds || entry.entityIds || entry.ids)) {
          selModelId = entry.modelId;
          selObjectIds = entry.objectRuntimeIds || entry.entityIds || entry.ids || [];
          break;
        }
      }
    } else if (Array.isArray(viewerSel)) {
      for (const entry of viewerSel) {
        if (entry && entry.modelId) {
          selModelId = entry.modelId;
          selObjectIds = entry.objectRuntimeIds || entry.entityIds || entry.ids || [];
          break;
        }
      }
    }

    // Fallback: use panel selectedIds if viewer selection is empty
    if (selObjectIds.length === 0 && selectedIds.size > 0) {
      const firstUid = selectedIds.values().next().value;
      const idx = firstUid.indexOf(":");
      if (idx > 0) {
        selModelId = firstUid.substring(0, idx);
        selObjectIds = [parseInt(firstUid.substring(idx + 1))];
      }
    }

    if (!selModelId || selObjectIds.length === 0) {
      console.log("[SelectAssembly] No object selected in viewer or panel");
      return;
    }

    const objectId = selObjectIds[0];
    const objectKey = `${selModelId}:${objectId}`;
    console.log(`[SelectAssembly] Looking for objectKey=${objectKey} in ${allObjects.length} objects`);

    // Step 2: Find this object in allObjects
    const selectedObj = allObjects.find(o => `${o.modelId}:${o.id}` === objectKey);

    if (!selectedObj) {
      console.log(`[SelectAssembly] Object ${objectKey} NOT found in allObjects`);
      // Debug: log first 5 objects to compare ID formats
      console.log("[SelectAssembly] Sample allObjects keys:", allObjects.slice(0, 5).map(o => `${o.modelId}:${o.id}`));
      return;
    }

    console.log(`[SelectAssembly] Found object: name="${selectedObj.name}", assemblyPos="${selectedObj.assemblyPos}", assemblyName="${selectedObj.assemblyName}", assemblyInstanceId="${selectedObj.assemblyInstanceId}"`);

    // Step 3: Determine the assembly identifier to match
    const assemblyId = selectedObj.assemblyInstanceId;
    if (!assemblyId) {
      console.log("[SelectAssembly] Object has no assembly identifier (assemblyPos, assemblyName, or assembly are all empty)");
      return;
    }

    // Step 4: Select ALL objects with the same assemblyInstanceId
    selectedIds.clear();
    let count = 0;
    for (const obj of allObjects) {
      if (obj.assemblyInstanceId === assemblyId) {
        selectedIds.add(`${obj.modelId}:${obj.id}`);
        count++;
      }
    }
    console.log(`[SelectAssembly] Selected ${count} objects with assemblyInstanceId="${assemblyId}"`);

    if (count === 0) {
      console.log("[SelectAssembly] No matching objects found");
      return;
    }

    // Step 5: Update tree UI
    document.querySelectorAll(".tree-item").forEach((el) => {
      const uid = el.dataset.uid;
      const isSelected = selectedIds.has(uid);
      el.classList.toggle("selected", isSelected);
      const cb = el.querySelector(".tree-item-checkbox");
      if (cb) cb.checked = isSelected;
    });

    updateGroupCheckboxStates();
    updateSummary();
    notifySelectionChanged();
    applyHighlightColors();
    syncSelectionToViewer();
  } catch (e) {
    console.error("[SelectAssembly] Error:", e);
  }
}


function updateTreeAndNotify() {
  document.querySelectorAll(".tree-item").forEach((el) => {
    if (selectedIds.has(el.dataset.uid)) {
      el.classList.add("selected");
      const cb = el.querySelector(".tree-item-checkbox");
      if (cb) cb.checked = true;
    }
  });
  updateGroupCheckboxStates();
  updateSummary();
  notifySelectionChanged();
  applyHighlightColors();
  syncSelectionToViewer();
}

// ── Collapse / Expand All Groups ──
function collapseAll() {
  document.querySelectorAll(".tree-group").forEach((g) => g.classList.add("collapsed"));
  // Browser may clamp scrollTop to the new max position (often the bottom).
  // Force reset to top immediately after reflow.
  shouldScrollToTop = true;
  requestAnimationFrame(() => {
    const treeContainer = document.getElementById("object-tree");
    if (treeContainer) treeContainer.scrollTop = 0;
    shouldScrollToTop = false;
  });
  console.log("[ObjectExplorer] Collapse all triggered, will scroll to top");
}

function expandAll() {
  document.querySelectorAll(".tree-group").forEach((g) => g.classList.remove("collapsed"));
}

function getGroupKey(obj, groupBy) {
  switch (groupBy) {
    case "assemblyName":
      return obj.assemblyName || obj.assembly || "(Không xác định)";
    case "assemblyPos":
      return obj.assemblyPos || "(Không xác định)";
    case "assemblyPosCode":
      return obj.assemblyPosCode || "(Không xác định)";
    case "name":
      return obj.name;
    case "group":
      return obj.group;
    case "objectType":
      return obj.type || obj.ifcClass || "(Không xác định)";
    case "material":
      return obj.material;
    case "profile":
      return obj.profile || "(Không xác định)";
    case "referenceName":
      return obj.referenceName || "(Không xác định)";
    case "ifcClass":
      return obj.ifcClass || "(Không xác định)";
    default:
      return obj.assemblyDisplayName || obj.assembly;
  }
}



// ── Highlight ──
// Selection glow is handled natively by the TC viewer via setSelection.
// No color overlay is applied — objects just glow when selected.
async function applyHighlightColors() {
  // No-op: rely on viewer's native selection highlight (glow)
}

// Sync panel selection to TC viewer (one-way: panel → viewer)
async function syncSelectionToViewer() {
  const modelMap = buildModelMap();

  // Update lastViewerSelectionKey so polling dedup won't re-trigger scroll
  const currentUids = Array.from(selectedIds).sort().join(",");
  lastViewerSelectionKey = currentUids;

  try {
    isSyncingFromViewer = true;

    if (selectedIds.size === 0) {
      await viewerRef.setSelection({ modelObjectIds: [] }, "set");
    } else {
      await viewerRef.setSelection(
        {
          modelObjectIds: Object.entries(modelMap).map(([modelId, ids]) => ({
            modelId,
            objectRuntimeIds: ids,
          })),
        },
        "set",
      );
    }
  } catch (e) {
    console.warn("[ObjectExplorer] setSelection failed:", e);
  } finally {
    // Keep flag on for 200ms to absorb the echo event
    setTimeout(() => {
      isSyncingFromViewer = false;
    }, 200);
    // Clear panel flag after polling interval
    setTimeout(() => {
      selectionFromPanel = false;
    }, 3000);
  }
}

// ── Isolate ──
async function toggleIsolate() {
  const btn = document.getElementById("btn-isolate");

  if (isolateActive) {
    // Reset: show all objects again
    try {
      // Reset visibility for all objects
      await viewerRef.setObjectState(undefined, { visible: "reset" });
      await viewerRef.setObjectState(undefined, { color: "reset" });
      isolateActive = false;
      btn.classList.remove("active");
      console.log("[ObjectExplorer] Isolation reset");
    } catch (e) {
      console.warn("[ObjectExplorer] Reset state failed:", e);
      try {
        await viewerRef.reset();
        isolateActive = false;
        btn.classList.remove("active");
      } catch (e2) {
        console.error("[ObjectExplorer] Full reset also failed:", e2);
      }
    }
    return;
  }

  if (selectedIds.size === 0) return;

  const modelMap = buildModelMap();

  try {
    // isolateEntities uses IModelEntities[] with { modelId, entityIds }
    await viewerRef.isolateEntities(
      Object.entries(modelMap).map(([modelId, ids]) => ({
        modelId,
        entityIds: ids,
      })),
    );
    isolateActive = true;
    btn.classList.add("active");
    console.log(`[ObjectExplorer] Isolated ${selectedIds.size} objects`);
  } catch (e) {
    console.error("[ObjectExplorer] Isolate failed:", e);
    // Fallback: hide all, show selected
    try {
      await viewerRef.setObjectState(undefined, { visible: false });
      await viewerRef.setObjectState(
        {
          modelObjectIds: Object.entries(modelMap).map(([modelId, ids]) => ({
            modelId,
            objectRuntimeIds: ids,
          })),
        },
        { visible: true },
      );
      isolateActive = true;
      btn.classList.add("active");
    } catch (e2) {
      console.error("[ObjectExplorer] Fallback isolate failed:", e2);
    }
  }
}

// ── IFC Class Badge Mapping ──
// Returns a short emoji+label badge for recognized IFC element types
function getIfcClassBadge(ifcClass) {
  if (!ifcClass) return null;
  const cls = ifcClass.toLowerCase();
  // Structural
  if (cls.includes("ifcbeam")) return "🔩 Beam";
  if (cls.includes("ifccolumn")) return "🏛️ Column";
  if (cls.includes("ifcmember")) return "📏 Member";
  if (cls.includes("ifcplate")) return "🔲 Plate";
  if (cls.includes("ifcslab")) return "⬜ Slab";
  if (cls.includes("ifcwall")) return "🧱 Wall";
  if (cls.includes("ifcfooting")) return "🏗️ Footing";
  if (cls.includes("ifcpile")) return "📍 Pile";
  if (cls.includes("ifcrailing")) return "🚧 Railing";
  if (cls.includes("ifcramp")) return "♿ Ramp";
  if (cls.includes("ifcroof")) return "🏠 Roof";
  if (cls.includes("ifcstair")) return "🪜 Stair";
  if (cls.includes("ifcchimney")) return "🏭 Chimney";
  // Architectural
  if (cls.includes("ifcdoor")) return "🚪 Door";
  if (cls.includes("ifcwindow")) return "🪟 Window";
  if (cls.includes("ifccurtainwall")) return "🏢 CurtainWall";
  if (cls.includes("ifccovering")) return "📦 Covering";
  // Connections & Bearings
  if (cls.includes("ifcbearing")) return "⚙️ Bearing";
  if (cls.includes("ifctendon")) return "🔗 Tendon";
  // Proxies & Parts
  if (cls.includes("ifcbuildingelementpart")) return "🧩 Part";
  if (cls.includes("ifcbuildingelementproxy")) return "📎 Proxy";
  if (cls.includes("ifcvirtualelement")) return "👻 Virtual";
  // Fasteners & Bolts
  if (cls.includes("ifcbolt")) return "🔩 Bolt";
  if (cls.includes("ifcmechanicalfastener")) return "⚙️ Fastener";
  if (cls.includes("ifcdiscreteaccessory")) return "🔧 Accessory";
  if (cls.includes("ifcfastener")) return "📌 Fastener";
  // Assembly
  if (cls.includes("ifcelementassembly")) return "🏗️ Assembly";
  // Reinforcement
  if (cls.includes("ifcreinforc")) return "🔗 Rebar";
  // MEP
  if (cls.includes("ifcpipesegment") || cls.includes("ifcpipefitting")) return "🔧 Pipe";
  if (cls.includes("ifcductsegment") || cls.includes("ifcductfitting")) return "💨 Duct";
  if (cls.includes("ifcflow")) return "💧 Flow";
  // Civil
  if (cls.includes("ifcbridge")) return "🌉 Bridge";
  if (cls.includes("ifcroad")) return "🛣️ Road";
  return null;
}

// ── Build a descriptive display name for tree items ──
function getObjectDisplayName(obj) {
  let name = obj.name || "";
  if (!name || /^Object \d+$/.test(name)) {
    if (obj.assembly) name = obj.assembly;
    else if (obj.type) name = obj.type;
    else if (obj.ifcClass) name = obj.ifcClass;
    else name = `Object ${obj.id}`;
  }
  return name;
}

// ── Build a rich tooltip with all available info ──
function buildTooltip(obj) {
  const parts = [];
  if (obj.name) parts.push(`Tên: ${obj.name}`);
  if (obj.profile) parts.push(`Profile: ${obj.profile}`);
  if (obj.referenceName) parts.push(`Reference: ${obj.referenceName}`);
  if (obj.type) parts.push(`Type: ${obj.type}`);
  if (obj.ifcClass) parts.push(`IFC Class: ${obj.ifcClass}`);
  if (obj.assembly) parts.push(`Assembly: ${obj.assembly}`);
  if (obj.assemblyPos) parts.push(`Assembly Pos: ${obj.assemblyPos}`);
  if (obj.assemblyPosCode) parts.push(`Assembly Pos Code: ${obj.assemblyPosCode}`);
  if (obj.material) parts.push(`Vật liệu: ${obj.material}`);
  
  // Physical properties
  if (obj.volume > 0) parts.push(`V: ${obj.volume.toFixed(6)} m³`);
  if (obj.area > 0) parts.push(`A: ${obj.area.toFixed(4)} m²`);
  if (obj.weight > 0) parts.push(`W: ${obj.weight.toFixed(2)} kg`);
  if (obj.length > 0) parts.push(`L: ${obj.length.toFixed(3)} m`);
  
  // ── Tekla Bolt Properties (comprehensive) ──
  if (obj.isTeklaBolt) {
    parts.push(`[TEKLA BOLT]`);
    if (obj.boltStandard) parts.push(`Standard: ${obj.boltStandard}`);
    if (obj.boltFullName) parts.push(`Full Name: ${obj.boltFullName}`);
    if (obj.boltType) parts.push(`Bolt Type: ${obj.boltType}`);
    if (obj.boltSize) parts.push(`Size: ${obj.boltSize}`);
    if (obj.boltLength) parts.push(`Length: ${obj.boltLength}`);
    if (obj.boltGrade) parts.push(`Grade: ${obj.boltGrade}`);
    if (obj.boltCount > 0) parts.push(`Bolt Count: ${obj.boltCount}`);
    if (obj.washerType) parts.push(`Washer: ${obj.washerType}${obj.washerCount > 0 ? ` (x${obj.washerCount})` : ""}`);
    if (obj.nutType) parts.push(`Nut: ${obj.nutType}${obj.nutCount > 0 ? ` (x${obj.nutCount})` : ""}`);
    if (obj.boltCountersunk) parts.push(`Countersunk: Yes`);
    if (obj.boltComments) parts.push(`Comments: ${obj.boltComments}`);
  }
  
  return parts.join(" | ") || `Object ${obj.id}`;
}

// ── Build a label combining name + profile + type for 3D labels ──
function getObjectLabel(obj) {
  const parts = [];
  // Name (skip generic)
  const name = obj.name || "";
  if (name && !/^Object \d+$/.test(name)) parts.push(name);
  // Profile
  if (obj.profile) parts.push(obj.profile);
  // Type (if different from name)
  if (obj.type && obj.type !== name) parts.push(obj.type);
  // IFC Class as last resort
  if (parts.length === 0 && obj.ifcClass) parts.push(obj.ifcClass);
  if (parts.length === 0) parts.push(`Object ${obj.id}`);
  return parts.join(" — ");
}

// ── Handle TC Viewer selection → sync tree checkboxes + statistics ──
// Called when user single-clicks or area-selects objects in TC 3D viewer.
// Simple approach: parse IDs, match against allObjects, update panel UI + stats.
function handleViewerSelectionChanged(data) {
  if (!allObjects || allObjects.length === 0) return;

  try {
    // Step 1: Extract all object IDs from event data
    const incomingUids = new Set();
    const incomingUidList = [];

    // Handle multiple data formats from TC API
    let entries = null;
    if (data && data.modelObjectIds) {
      entries = data.modelObjectIds;
    } else if (Array.isArray(data)) {
      entries = data;
    } else if (data && typeof data === "object" && data.modelId) {
      entries = [data];
    }

    if (entries && Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || !entry.modelId) continue;
        const modelId = entry.modelId;
        // Try all possible ID field names
        const ids =
          entry.objectRuntimeIds || entry.entityIds || entry.ids || [];
        for (const id of ids) {
          const uid = `${modelId}:${id}`;
          incomingUidList.push(uid);
          incomingUids.add(uid);
        }
      }
    }

    // Step 2: Dedup — if same selection as last time (from polling), skip
    const selKey = Array.from(incomingUids).sort().join(",");
    if (selKey === lastViewerSelectionKey) return;
    lastViewerSelectionKey = selKey;

    // Step 3: Empty selection → keep panel state (persistent memory)
    if (incomingUids.size === 0) {
      console.log(
        "[ObjectExplorer] Viewer empty selection — keeping panel state",
      );
      return;
    }

    // Step 4: Match incoming IDs against our allObjects
    const knownUids = new Set(allObjects.map((o) => `${o.modelId}:${o.id}`));
    const matchedUids = new Set();
    let targetUid = null;
    const unmatchedCount = { count: 0 };

    for (const uid of incomingUids) {
      if (knownUids.has(uid)) {
        matchedUids.add(uid);
      } else {
        unmatchedCount.count++;
      }
    }

    console.log(
      `[ObjectExplorer] Viewer selection: ${incomingUids.size} IDs, ${matchedUids.size} matched, ${unmatchedCount.count} unmatched`,
    );

    // If zero matches, keep current panel state
    if (matchedUids.size === 0) {
      console.log(
        "[ObjectExplorer] No matching objects in panel for viewer selection",
      );
      return;
    }

    // Step 5: Check if selection actually changed (to avoid scroll on polling echo)
    const selectionChanged = (
      matchedUids.size !== selectedIds.size ||
      [...matchedUids].some(uid => !selectedIds.has(uid))
    );

    if (!selectionChanged) {
      // Polling returned the same selection — no need to update or scroll
      return;
    }

    // Decide which UID we should scroll to:
    // - Ctrl-add selection: scroll to the last newly-added object (relative to previous selection).
    // - Other selection types: fallback to last matched UID by incoming event order.
    const prevSelectedUids = new Set(selectedIds);
    const newlyAddedUids = new Set();
    for (const uid of matchedUids) {
      if (!prevSelectedUids.has(uid)) newlyAddedUids.add(uid);
    }

    if (newlyAddedUids.size > 0) {
      // Pick the last newly-added UID as it appears in the viewer event list.
      for (let i = incomingUidList.length - 1; i >= 0; i--) {
        const uid = incomingUidList[i];
        if (newlyAddedUids.has(uid)) {
          targetUid = uid;
          break;
        }
      }
    } else {
      // Fallback: pick last matched UID in viewer event order.
      for (let i = incomingUidList.length - 1; i >= 0; i--) {
        const uid = incomingUidList[i];
        if (matchedUids.has(uid)) {
          targetUid = uid;
          break;
        }
      }
    }

    // Step 6: Apply selection to panel
    selectedIds.clear();
    for (const uid of matchedUids) {
      selectedIds.add(uid);
    }

    // Step 7: Update tree UI checkboxes
    const treeItems = document.querySelectorAll(".tree-item");
    for (const el of treeItems) {
      const uid = el.dataset.uid;
      const isSelected = selectedIds.has(uid);
      el.classList.toggle("selected", isSelected);
      const cb = el.querySelector(".tree-item-checkbox");
      if (cb) cb.checked = isSelected;
    }

    // Step 8: Update summary + statistics
    updateGroupCheckboxStates();
    updateSummary();
    notifySelectionChanged();
    applyHighlightColors();

    // Auto-scroll to selected item(s) based on their position in the current tree DOM.
    // - Single selection: scroll to that item.
    // - Multiple selection: scroll to the bottom-most selected item.
    if (matchedUids.size > 0) {
      requestAnimationFrame(() => {
        const container = document.getElementById("object-tree");
        if (!container) return;

        const allTreeItems = document.querySelectorAll(".tree-item");
        let targetEl = null;

        if (targetUid) {
          for (const el of allTreeItems) {
            if (el.dataset.uid === targetUid) {
              targetEl = el;
              break;
            }
          }
        }

        // Fallback: if the target uid isn't currently rendered (filters/collapse),
        // scroll to the bottom-most selected item currently present in DOM.
        if (!targetEl) {
          for (const el of allTreeItems) {
            const uid = el.dataset.uid;
            if (matchedUids.has(uid)) {
              targetEl = el;
              targetUid = uid;
            }
          }
        }

        if (targetEl && targetUid) {
          // Auto-expand the parent group if it's collapsed (so the element can be scrolled to).
          const parentGroup = targetEl.closest(".tree-group");
          let didExpand = false;
          if (parentGroup && parentGroup.classList.contains("collapsed")) {
            parentGroup.classList.remove("collapsed");
            didExpand = true;
          }

          const doScroll = () => {
            targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
            console.log(`[ObjectExplorer] Scrolled to selected item: ${targetUid}`);
          };

          // If we just expanded, wait one more frame for layout to settle.
          if (didExpand) requestAnimationFrame(doScroll);
          else doScroll();
        }
      });
    }
  } catch (e) {
    console.warn("[ObjectExplorer] Viewer selection sync error:", e);
  }
}

// ── Create SVG label as data URL ──
function createLabelSvgDataUrl(text) {
  const shortText = text.length > 30 ? text.substring(0, 27) + "..." : text;
  const width = Math.max(120, shortText.length * 8 + 20);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="32">
    <defs>
      <filter id="s" x="-5%" y="-5%" width="110%" height="110%">
        <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#000" flood-opacity="0.5"/>
      </filter>
    </defs>
    <rect x="0" y="0" width="${width}" height="28" rx="6" ry="6"
          fill="rgba(13,17,23,0.9)" stroke="#58a6ff" stroke-width="1.5" filter="url(#s)"/>
    <text x="${width / 2}" y="18" text-anchor="middle"
          font-family="Inter,Arial,sans-serif" font-size="11" font-weight="600"
          fill="#e6edf3">${escXml(shortText)}</text>
    <polygon points="${width / 2 - 5},28 ${width / 2},34 ${width / 2 + 5},28" fill="rgba(13,17,23,0.9)" stroke="#58a6ff" stroke-width="1"/>
  </svg>`;

  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
}

// ── Reset ──
async function resetAll() {
  selectedIds.clear();
  isolateActive = false;
  lastClickedItem = null;
  lastClickedGroupEl = null;

  const btnIsolate = document.getElementById("btn-isolate");
  if (btnIsolate) btnIsolate.classList.remove("active");

  try {
    // Clear selection
    await viewerRef.setSelection({ modelObjectIds: [] }, "set");
  } catch (e) {
    /* ignore */
  }

  try {
    // Reset object states (visibility, color)
    await viewerRef.setObjectState(undefined, {
      visible: "reset",
      color: "reset",
    });
  } catch (e) {
    /* ignore */
  }

  updateSummary();
  notifySelectionChanged();
  renderTree();
  console.log("[ObjectExplorer] Reset complete");
}

// ── Helpers ──
function buildModelMap() {
  const map = {};
  for (const uid of selectedIds) {
    const idx = uid.indexOf(":");
    const modelId = uid.substring(0, idx);
    const objectId = parseInt(uid.substring(idx + 1));
    if (!map[modelId]) map[modelId] = [];
    if (!isNaN(objectId)) map[modelId].push(objectId);
  }
  return map;
}

function updateSummary() {
  document.getElementById("total-objects-count").textContent =
    `${filteredObjects.length} objects`;
  document.getElementById("selected-objects-count").textContent =
    `${selectedIds.size} đã chọn`;

  // Calculate and display stats for selected objects
  const selStatsEl = document.getElementById("selected-stats");
  const statsDivider = document.getElementById("stats-divider");

  if (selectedIds.size > 0) {
    let totalVolume = 0, totalWeight = 0, totalArea = 0;
    let matchCount = 0;

    // Debug: log what selectedIds look like
    const sampleIds = Array.from(selectedIds).slice(0, 3);
    console.log("[UpdateSummary] Sample selectedIds:", sampleIds);

    for (const obj of allObjects) {
      const uid = `${obj.modelId}:${obj.id}`;
      if (selectedIds.has(uid)) {
        totalVolume += obj.volume || 0;
        totalWeight += obj.weight || 0;
        totalArea += obj.area || 0;
        matchCount++;
        // Debug: log first 3 matched objects
        if (matchCount <= 3) {
          console.log(`[UpdateSummary] Matched: uid=${uid} vol=${obj.volume} wt=${obj.weight} area=${obj.area}`);
        }
      }
    }
    console.log(`[UpdateSummary] Matched ${matchCount}/${selectedIds.size} objects. V=${totalVolume} W=${totalWeight} A=${totalArea}`);

    // Build stats text - always show all fields
    const parts = [];
    parts.push(`V: ${totalVolume.toFixed(4)} m³`);
    parts.push(`W: ${totalWeight.toFixed(1)} kg`);
    parts.push(`A: ${totalArea.toFixed(2)} m²`);
    const statsText = parts.join(" | ");

    if (selStatsEl) {
      selStatsEl.textContent = statsText;
      selStatsEl.style.display = "inline";
    }
    if (statsDivider) statsDivider.style.display = "inline";
  } else {
    if (selStatsEl) {
      selStatsEl.textContent = "";
      selStatsEl.style.display = "none";
    }
    if (statsDivider) statsDivider.style.display = "none";
  }
}

function showLoading(show) {
  document.getElementById("loading-overlay").style.display = show
    ? "flex"
    : "none";
}

function showPlaceholder() {
  document.getElementById("tree-placeholder").style.display = "flex";
}

function hidePlaceholder() {
  document.getElementById("tree-placeholder").style.display =
    filteredObjects.length > 0 ? "none" : "flex";
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function escXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Notify statistics module of selection change ──
function notifySelectionChanged() {
  window.dispatchEvent(
    new CustomEvent("selection-changed", {
      detail: { selectedIds: Array.from(selectedIds), count: selectedIds.size },
    }),
  );
}
