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
      // Virtual / proxy non-geometry
      "ifcvirtualelement",
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

    // Filter Stage 2: exclude objects with weight = 0 AND area = 0 (must have at least one of: weight > 0, area > 0)
    const beforeStage2 = allObjects.length;
    allObjects = allObjects.filter((obj) => {
      const hasWeight = obj.weight > 0;
      const hasArea = obj.area > 0;
      const hasVolume = obj.volume > 0;
      // Some Tekla objects (e.g. bolts/discrete accessories) may not export area/weight,
      // but they can still have volume; keep them so statistics can calculate weight from volume.
      return hasWeight || hasArea || hasVolume;
    });
    console.log(
      `[ObjectExplorer] Stage 2 filter: ${beforeStage2} → ${allObjects.length} objects (removed ${beforeStage2 - allObjects.length} objects with weight=0, area=0, volume=0)`,
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

    // Mark assembly parent nodes and exclude component objects
    // Strategy: Assembly objects from IFC hierarchy should be visible.
    // Component objects (parts inside assembly) that are NOT assembly themselves should be hidden
    // unless they have their own assemblyPos (Tekla main parts)
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

    // Stage 3: keep ALL objects (including assembly components).
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
// Implements MULTIPLE strategies to minimize "(Không xác định)" category:
// Strategy 1: IfcElementAssembly membership
// Strategy 2: Direct parent node name
// Strategy 3: IFC Class-based grouping
// Strategy 4: Object name (for assembly nodes themselves)
// Strategy 5: Model-level fallback
async function enrichAssemblyFromHierarchy() {
  let enrichedFromAssembly = 0;
  let enrichedFromParent = 0;
  let enrichedFromClass = 0;
  let enrichedFromName = 0;
  let skippedAlreadyHas = 0;

  for (const obj of allObjects) {
    if (obj.assemblyPos && obj.assemblyPos.trim()) {
      skippedAlreadyHas++;
      continue; // already has valid ASSEMBLY_POS
    }

    const objectKey = `${obj.modelId}:${obj.id}`;

    // Strategy 1: Check explicit IfcElementAssembly membership first
    const assemblyKey = assemblyMembershipMap.get(objectKey);
    if (assemblyKey) {
      const nodeInfo = assemblyNodeInfoMap.get(assemblyKey);
      if (nodeInfo && nodeInfo.name && nodeInfo.name.trim()) {
        obj.assemblyPos = nodeInfo.name;
        if (!obj.assemblyName) obj.assemblyName = nodeInfo.name;
        if (!obj.assembly) obj.assembly = nodeInfo.name;
        obj.isTekla = true;
        enrichedFromAssembly++;
        continue;
      }
    }

    // Strategy 2: Use direct parent node name from spatial hierarchy
    const parentInfo = hierarchyParentMap.get(objectKey);
    if (parentInfo && parentInfo.name && parentInfo.name.trim()) {
      const parentClass = (parentInfo.class || "").toLowerCase();
      
      // Accept parent as assembly if it's a structural element or assembly type
      const isStructuralElement = (
        parentClass.includes("assembly") ||
        parentClass.includes("ifcelementassembly") ||
        parentClass.includes("ifcbeam") ||
        parentClass.includes("ifccolumn") ||
        parentClass.includes("ifcplate") ||
        parentClass.includes("ifcmember") ||
        parentClass.includes("ifcslab") ||
        parentClass.includes("ifcwall") ||
        parentClass.includes("ifcbuildingelementproxy") ||
        parentClass.includes("ifcdiscreteaccessory") ||
        parentClass.includes("ifcfastener") ||
        parentClass.includes("ifcmechanicalfastener") ||
        parentClass === "" // generic parent
      );
      
      if (isStructuralElement) {
        obj.assemblyPos = parentInfo.name;
        if (!obj.assemblyName) obj.assemblyName = parentInfo.name;
        if (!obj.assembly) obj.assembly = parentInfo.name;
        enrichedFromParent++;
        continue;
      }
    }

    // Strategy 3: Group objects by IFC Class when parent name unavailable
    // This prevents many objects from falling to "(Không xác định)"
    const ifcClass = (obj.ifcClass || "").toLowerCase();
    if (ifcClass && !obj.assemblyPos) {
      // Map common IFC classes to meaningful groups
      const classGroupMap = {
        "ifcbeam": "Beams",
        "ifccolumn": "Columns",
        "ifcslab": "Slabs",
        "ifcwall": "Walls",
        "ifcplate": "Plates",
        "ifcroof": "Roofs",
        "ifcdoor": "Doors",
        "ifcwindow": "Windows",
        "ifcmember": "Members",
        "ifcelementassembly": "Element Assemblies",
        "ifcdiscreteaccessory": "Discrete Accessories",
        "ifcfastener": "Fasteners",
        "ifcmechanicalfastener": "Mechanical Fasteners",
        "ifcbuildingelementproxy": "Building Element Proxies",
        "ifcramp": "Ramps",
        "ifcstaircase": "Staircases",
      };
      
      const groupName = classGroupMap[ifcClass];
      if (groupName) {
        obj.assemblyPos = groupName;
        enrichedFromClass++;
        continue;
      }
    }

    // Strategy 4: For assembly node objects themselves, use their own name
    if (!obj.assemblyPos && (ifcClass === "ifcelementassembly" || ifcClass.includes("elementassembly"))) {
      if (obj.name && obj.name.trim()) {
        obj.assemblyPos = obj.name;
        enrichedFromName++;
        continue;
      }
    }

    // Strategy 5: Use secondary assembly properties if available
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

    // Last resort for structural/bolt objects: use type classification
    if (!obj.assemblyPos && obj.type) {
      const typeStr = obj.type.toLowerCase();
      if (typeStr.includes("bolt") || typeStr.includes("fastener") || typeStr.includes("washer")) {
        obj.assemblyPos = "Bolts & Fasteners";
        enrichedFromClass++;
      }
    }
  }

  const total = enrichedFromAssembly + enrichedFromParent + enrichedFromClass + enrichedFromName;
  if (total > 0) {
    console.log(`[ObjectExplorer] Enriched from hierarchy: ${enrichedFromAssembly} from IfcElementAssembly, ${enrichedFromParent} from parent, ${enrichedFromClass} from IFC class, ${enrichedFromName} from names (total: ${total}). Already had assemblyPos: ${skippedAlreadyHas}`);
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
// Identifies and extracts Tekla Bolt properties like washer type, count, etc.
// Returns object with detected bolt properties
function detectTeklaBoltProperties(props, modelId) {
  const boltProps = {
    isTeklaBolt: false,
    boltType: "",
    boltSize: "",
    boltGrade: "",
    washerType: "",
    washerCount: 0,
    nutType: "",
    nutCount: 0,
    tightened: false,
    comments: "",
    allBoltProperties: {}, // Store all detected bolt-related properties
  };

  const propertySets = props.properties || [];
  for (const pSet of propertySets) {
    const setName = (pSet.name || "").toLowerCase();
    const properties = pSet.properties || [];

    // Check if this property set contains bolt/fastener information
    const isBoltPropSet = (
      setName.includes("bolt") ||
      setName.includes("fastener") ||
      setName.includes("tekla") ||
      setName.includes("connection") ||
      setName.includes("assembly")
    );

    for (const prop of properties) {
      const propNameLower = (prop.name || "").toLowerCase();
      const propValue = String(prop.value || "").trim();

      // Normalize property name for matching
      const normalized = propNameLower
        .replace(/[\s_.\-]/g, "")
        .replace(/[()]/g, "");

      // Store all potential bolt properties
      if (isBoltPropSet && propValue) {
        boltProps.allBoltProperties[prop.name] = propValue;
      }

      // ── Bolt Type Detection ──
      if (
        normalized.includes("bolttype") ||
        normalized.includes("bolt_type") ||
        normalized.includes("type") && isBoltPropSet
      ) {
        if (propValue && propValue !== "") {
          boltProps.boltType = propValue;
          boltProps.isTeklaBolt = true;
        }
      }

      // ── Bolt Size/Diameter Detection ──
      if (
        normalized.includes("boltsize") ||
        normalized.includes("bolt_size") ||
        normalized.includes("bolt_diameter") ||
        normalized.includes("diameter") ||
        normalized.includes("size") && propNameLower.includes("bolt")
      ) {
        if (propValue && propValue !== "") {
          boltProps.boltSize = propValue;
          boltProps.isTeklaBolt = true;
        }
      }

      // ── Bolt Grade Detection ──
      if (
        normalized.includes("boltgrade") ||
        normalized.includes("bolt_grade") ||
        normalized.includes("grade") && propNameLower.includes("bolt")
      ) {
        if (propValue && propValue !== "") {
          boltProps.boltGrade = propValue;
          boltProps.isTeklaBolt = true;
        }
      }

      // ── Washer Type Detection ──
      if (
        normalized.includes("washertype") ||
        normalized.includes("washer_type") ||
        normalized.includes("washername") ||
        normalized.includes("washer_name") ||
        normalized === "washertype" ||
        (normalized.includes("washer") && normalized.includes("type"))
      ) {
        if (propValue && propValue !== "") {
          boltProps.washerType = propValue;
          boltProps.isTeklaBolt = true;
        }
      }

      // ── Washer Count Detection ──
      if (
        normalized.includes("washercount") ||
        normalized.includes("washer_count") ||
        normalized.includes("numberofwashers") ||
        normalized.includes("number_of_washers") ||
        normalized === "washercount"
      ) {
        const count = parseQuantityNumber(propValue);
        if (!isNaN(count) && count > 0) {
          boltProps.washerCount = Math.floor(count);
          boltProps.isTeklaBolt = true;
        }
      }

      // ── Nut Type Detection ──
      if (
        normalized.includes("nuttype") ||
        normalized.includes("nut_type") ||
        normalized.includes("nutname") ||
        normalized.includes("nut_name")
      ) {
        if (propValue && propValue !== "") {
          boltProps.nutType = propValue;
          boltProps.isTeklaBolt = true;
        }
      }

      // ── Nut Count Detection ──
      if (
        normalized.includes("nutcount") ||
        normalized.includes("nut_count") ||
        normalized.includes("numberofnuts")
      ) {
        const count = parseQuantityNumber(propValue);
        if (!isNaN(count) && count > 0) {
          boltProps.nutCount = Math.floor(count);
          boltProps.isTeklaBolt = true;
        }
      }

      // ── Tightened Status Detection ──
      if (
        normalized.includes("tightened") ||
        normalized.includes("tightened_torque") ||
        normalized.includes("preloaded")
      ) {
        boltProps.tightened = 
          propValue.toLowerCase() === "yes" ||
          propValue.toLowerCase() === "true" ||
          propValue === "1";
        boltProps.isTeklaBolt = true;
      }

      // ── Comments/Notes Detection ──
      if (
        normalized.includes("comment") ||
        normalized.includes("notes") ||
        normalized.includes("remark")
      ) {
        boltProps.comments = propValue;
      }

      // Auto-detect if this is a bolt object based on property names
      if (
        normalized.includes("bolt") ||
        normalized.includes("fastener") ||
        normalized.includes("washer") ||
        normalized.includes("nut")
      ) {
        boltProps.isTeklaBolt = true;
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
    ifcClass: props.class || "",
    isTekla: false,
    isAssemblyParent: false,     // Marked as IfcElementAssembly or assembly parent node
    isAssemblyComponent: false,  // Marked as component/child of an assembly
    // ── Tekla Bolt Properties ──
    isTeklaBolt: false,
    boltType: "",
    boltSize: "",
    boltGrade: "",
    washerType: "",
    washerCount: 0,
    nutType: "",
    nutCount: 0,
    boltTightened: false,
    boltComments: "",
    allBoltProperties: {}, // All detected bolt properties
    rawProperties: [], // [{pset, name, value}] for debug/export
  };

  // ── Detect Tekla Bolt Properties ──
  const boltProps = detectTeklaBoltProperties(props, modelId);
  if (boltProps.isTeklaBolt) {
    result.isTeklaBolt = true;
    result.boltType = boltProps.boltType;
    result.boltSize = boltProps.boltSize;
    result.boltGrade = boltProps.boltGrade;
    result.washerType = boltProps.washerType;
    result.washerCount = boltProps.washerCount;
    result.nutType = boltProps.nutType;
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
  }

  // IFC Class as type fallback
  if (!result.type && props.class) {
    result.type = props.class;
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
        normalizedVolume.includes("volume")
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
        normalizedWeight.includes("weight") ||
        normalizedWeight.includes("mass")
      ) {
        const w = parseQuantityNumber(propValue);
        if (!isNaN(w) && w > 0 && w > result.weight) result.weight = w;
      }

      // Surface Area (m²)
      const normalizedArea = propName.replace(/[\s_.\-]/g, "").replace(/[()]/g, "");
      if (
        propType === 1 ||
        propName === "area" ||
        propName === "diện tích" ||
        propName === "surfacearea" ||
        propName === "surface area" ||
        propName === "netsurfacearea" ||
        propName === "grosssurfacearea" ||
        propName === "totalsurfacearea" ||
        propName === "netarea" ||
        propName === "grossarea"
        || normalizedArea.includes("area")
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
        normalizedLength.includes("length")
      ) {
        const l = parseQuantityNumber(propValue);
        if (!isNaN(l) && l > result.length) result.length = l;
      }

      // Profile
      if (
        propName === "profile" ||
        propName === "profilename" ||
        propName === "profile name" ||
        propName === "profiletype" ||
        propName === "cross section" ||
        propName === "section" ||
        propName === "sectionname" ||
        propName === "crosssectionarea"
      ) {
        if (!result.profile) result.profile = String(propValue || "");
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

  // Calculate weight from volume if not provided (steel density = 7850 kg/m³)
  if (result.weight === 0 && result.volume > 0) {
    result.weight = result.volume * 7850;
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
          (o.profile && o.profile.toLowerCase().includes(q)),
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
      
      // Tekla Bolt badge (highest priority)
      if (obj.isTeklaBolt) {
        html += `<span class="tree-item-badge bolt" title="Tekla Bolt - ${obj.boltType || 'Fastener'}">⚙️ Bolt</span>`;
      }
      // Tekla Structures badge
      else if (obj.isTekla) {
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
  if (obj.type) parts.push(`Type: ${obj.type}`);
  if (obj.ifcClass) parts.push(`IFC Class: ${obj.ifcClass}`);
  if (obj.assembly) parts.push(`Assembly: ${obj.assembly}`);
  if (obj.assemblyPos) parts.push(`Assembly Pos: ${obj.assemblyPos}`);
  if (obj.assemblyPosCode) parts.push(`Assembly Pos Code: ${obj.assemblyPosCode}`);
  if (obj.material) parts.push(`Vật liệu: ${obj.material}`);
  
  // ── Tekla Bolt Properties ──
  if (obj.isTeklaBolt) {
    parts.push(`[TEKLA BOLT]`);
    if (obj.boltType) parts.push(`Bolt Type: ${obj.boltType}`);
    if (obj.boltSize) parts.push(`Bolt Size: ${obj.boltSize}`);
    if (obj.boltGrade) parts.push(`Bolt Grade: ${obj.boltGrade}`);
    if (obj.washerType) parts.push(`Washer: ${obj.washerType}${obj.washerCount > 0 ? ` (x${obj.washerCount})` : ""}`);
    if (obj.nutType) parts.push(`Nut: ${obj.nutType}${obj.nutCount > 0 ? ` (x${obj.nutCount})` : ""}`);
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
