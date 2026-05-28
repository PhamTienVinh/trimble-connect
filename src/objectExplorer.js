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
let assemblyNodeInfoMap = new Map(); // "modelId:assemblyNodeId" -> { id, name, class, modelId, assemblyWeight }
let savedAssemblyContainers = []; // Full IfcElementAssembly objects saved before removal (for display)
let isolateActive = false;
let searchTimeout = null;
let lastClickedItem = null; // for Shift+click range selection
let lastClickAction = "select"; // "select" or "deselect" — for Shift range
let lastClickedGroupEl = null; // for Shift+click range selection on group headers
let lastGroupClickAction = "select"; // "select" or "deselect" — for group Shift range
let lastClickedSubgroupEl = null; // for Shift+click range selection on subgroup headers
let lastSubgroupClickAction = "select"; // "select" or "deselect" — for subgroup Shift range
let lastClickedSub2groupEl = null; // for Shift+click range selection on sub2group headers
let lastSub2groupClickAction = "select"; // "select" or "deselect" — for sub2group Shift range
let isSyncingFromViewer = false; // flag to prevent re-entry during sync
let lastViewerSelectionKey = ""; // dedup key for polling
let selectionFromPanel = false; // true when selection originates from panel click
let shouldScrollToTop = false; // flag to scroll to top after renderTree()

// ── Undo/Redo State ──
let selectionHistory = []; // Stack of Set snapshots (serialized as arrays)
let selectionHistoryIndex = -1; // Current position in history
const MAX_UNDO_HISTORY = 50; // Max number of undo steps
let isUndoRedoAction = false; // Prevent pushing state during undo/redo

// Save the current selection state to the undo history
function pushSelectionState() {
  if (isUndoRedoAction) return; // Don't save during undo/redo

  // If we're not at the end of history, truncate forward history
  if (selectionHistoryIndex < selectionHistory.length - 1) {
    selectionHistory = selectionHistory.slice(0, selectionHistoryIndex + 1);
  }

  // Save current state as a snapshot
  selectionHistory.push([...selectedIds]);

  // Enforce max history limit
  if (selectionHistory.length > MAX_UNDO_HISTORY) {
    selectionHistory.shift();
  }

  selectionHistoryIndex = selectionHistory.length - 1;
  updateUndoRedoButtons();
}

// Undo: restore previous selection state
function undoSelection() {
  if (selectionHistoryIndex <= 0) return; // Nothing to undo

  selectionHistoryIndex--;
  const snapshot = selectionHistory[selectionHistoryIndex];

  isUndoRedoAction = true;
  selectedIds.clear();
  for (const uid of snapshot) {
    selectedIds.add(uid);
  }

  // Update UI
  renderTree();
  updateSummary();
  notifySelectionChanged();
  applyHighlightColors();
  syncSelectionToViewer();
  isUndoRedoAction = false;

  updateUndoRedoButtons();
  console.log(`[ObjectExplorer] Undo → ${selectedIds.size} selected (step ${selectionHistoryIndex + 1}/${selectionHistory.length})`);
}

// Redo: restore next selection state
function redoSelection() {
  if (selectionHistoryIndex >= selectionHistory.length - 1) return; // Nothing to redo

  selectionHistoryIndex++;
  const snapshot = selectionHistory[selectionHistoryIndex];

  isUndoRedoAction = true;
  selectedIds.clear();
  for (const uid of snapshot) {
    selectedIds.add(uid);
  }

  // Update UI
  renderTree();
  updateSummary();
  notifySelectionChanged();
  applyHighlightColors();
  syncSelectionToViewer();
  isUndoRedoAction = false;

  updateUndoRedoButtons();
  console.log(`[ObjectExplorer] Redo → ${selectedIds.size} selected (step ${selectionHistoryIndex + 1}/${selectionHistory.length})`);
}

// Update undo/redo button states (enabled/disabled)
function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("btn-undo");
  const redoBtn = document.getElementById("btn-redo");
  if (undoBtn) {
    undoBtn.disabled = selectionHistoryIndex <= 0;
    undoBtn.classList.toggle("disabled", selectionHistoryIndex <= 0);
  }
  if (redoBtn) {
    redoBtn.disabled = selectionHistoryIndex >= selectionHistory.length - 1;
    redoBtn.classList.toggle("disabled", selectionHistoryIndex >= selectionHistory.length - 1);
  }
}




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
  

  
  const collapseBtn = document.getElementById("btn-collapse-all");
  if (collapseBtn) {
    collapseBtn.addEventListener("click", collapseAll);
  }
  
  const expandBtn = document.getElementById("btn-expand-all");
  if (expandBtn) {
    expandBtn.addEventListener("click", expandAll);
  }

  // Undo/Redo buttons
  const undoBtn = document.getElementById("btn-undo");
  if (undoBtn) {
    undoBtn.addEventListener("click", undoSelection);
  }
  const redoBtn = document.getElementById("btn-redo");
  if (redoBtn) {
    redoBtn.addEventListener("click", redoSelection);
  }

  // Keyboard shortcuts: Ctrl+Z = Undo, Ctrl+Y / Ctrl+Shift+Z = Redo
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      undoSelection();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault();
      redoSelection();
    }
  });

  // Initialize undo/redo button states
  updateUndoRedoButtons();
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
export function getSavedAssemblyContainers() {
  return savedAssemblyContainers;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── PUBLIC API: Assembly Container Information ──
// ══════════════════════════════════════════════════════════════════════════════
// 
// These functions help identify which IfcElementAssembly container a child object
// belongs to, and provide information about assembly relationships.
//

/**
 * Get the IfcElementAssembly container information for a child object
 * @param {Object} obj - The object to query
 * @returns {Object|null} Container info: { id, modelId, name, assemblyPos, assemblyName, assemblyPosCode }
 *                        or null if the object is not part of an assembly
 */
export function getAssemblyContainerForObject(obj) {
  if (!obj) return null;
  
  const objectKey = `${obj.modelId}:${obj.id}`;
  const assemblyKey = assemblyMembershipMap.get(objectKey);
  
  if (!assemblyKey) return null;
  
  // Get the assembly container info from nodeInfoMap
  const nodeInfo = assemblyNodeInfoMap.get(assemblyKey);
  if (!nodeInfo) return null;
  
  return {
    id: nodeInfo.id,
    modelId: nodeInfo.modelId,
    name: nodeInfo.name,
    ifcClass: nodeInfo.class,
    assemblyPos: nodeInfo.assemblyPos,
    assemblyName: nodeInfo.assemblyName,
    assemblyPosCode: nodeInfo.assemblyPosCode,
    assemblyWeight: nodeInfo.assemblyWeight || 0,
  };
}

/**
 * Get all children of a specific IfcElementAssembly container
 * @param {string} modelId - The model ID
 * @param {number} containerId - The IfcElementAssembly object ID
 * @returns {Array} Array of child objects that belong to this container
 */
export function getAssemblyChildren(modelId, containerId) {
  const containerKey = `${modelId}:${containerId}`;
  const childIds = assemblyChildrenMap.get(containerKey);
  
  if (!childIds || childIds.size === 0) return [];
  
  // Use Map lookup instead of find() for O(1) per child
  const children = [];
  for (const childId of childIds) {
    const key = `${modelId}:${childId}`;
    const obj = allObjects.find(o => `${o.modelId}:${o.id}` === key);
    if (obj) children.push(obj);
  }
  
  return children;
}

/**
 * Get all assembly containers (IfcElementAssembly nodes) with their info
 * @returns {Array} Array of container info objects
 */
export function getAssemblyContainers() {
  const containers = [];
  for (const [key, nodeInfo] of assemblyNodeInfoMap) {
    containers.push({
      key,
      id: nodeInfo.id,
      modelId: nodeInfo.modelId,
      name: nodeInfo.name,
      ifcClass: nodeInfo.class,
      assemblyPos: nodeInfo.assemblyPos,
      assemblyName: nodeInfo.assemblyName,
      assemblyPosCode: nodeInfo.assemblyPosCode,
      assemblyWeight: nodeInfo.assemblyWeight || 0,
      childCount: (assemblyChildrenMap.get(key) || new Set()).size,
    });
  }
  return containers;
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
    } catch (e) {
      console.warn("[ObjectExplorer] getModels failed:", e);
      try {
        models = await viewerRef.getModels();
      } catch (e2) {
        console.warn("[ObjectExplorer] getModels() also failed:", e2);
      }
    }

    // Strategy 1: getObjects() returns ModelObjects[] with full ObjectProperties
    let modelObjectsList = [];
    try {
      modelObjectsList = await viewerRef.getObjects();
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
      // NOTE: IfcElementAssembly is NOT in this list.
      // It must survive Stage 1 so enrichAssemblyFromHierarchy() can
      // propagate assembly info to children. It is removed later.
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
      // Assembly container (NOT a real 3D object — handled separately)
      // "ifcelementassembly" is intentionally EXCLUDED — these are aggregate
      // containers whose weight = sum of children. They are removed in the
      // assembly dedup stage to prevent double-counting.
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
      // ── IFC4/IFC4.3 — MEP Equipment (Revit, ArchiCAD, Allplan) ──
      "ifcboiler", "ifcboilertype",
      "ifcchiller", "ifcchillertype",
      "ifccompressor", "ifccompressortype",
      "ifccondenser", "ifccondensertype",
      "ifccooledbeam", "ifccooledbeamtype",
      "ifccoolingtower", "ifccoolingtowertype",
      "ifccoil", "ifccoiltype",
      "ifcelectricgenerator", "ifcelectricgeneratortype",
      "ifcelectricmotor", "ifcelectricmotortype",
      "ifcevaporativecooler", "ifcevaporativecoolertype",
      "ifcevaporator", "ifcevaporatortype",
      "ifcfan", "ifcfantype",
      "ifcfilter", "ifcfiltertype",
      "ifcheatexchanger", "ifcheatexchangertype",
      "ifchumidifier", "ifchumidifiertype",
      "ifcpump", "ifcpumptype",
      "ifctank", "ifctanktype",
      "ifctransformer", "ifctransformertype",
      "ifctubebundle", "ifctubebundletype",
      "ifcunitaryequipment", "ifcunitaryequipmenttype",
      "ifcairtoairheatrecovery", "ifcairtoairheatrecoverytype",
      "ifcairterminalbox", "ifcairterminalboxtype",
      "ifcdamper", "ifcdampertype",
      "ifcburner", "ifcburnertype",
      "ifcengine", "ifcenginetype",
      // ── HVAC Terminals & Accessories ──
      "ifcspaceheater", "ifcspaceheatertype",
      "ifcvalve", "ifcvalvetype",
      "ifcductsilencer", "ifcductsilencertype",
      // ── Plumbing & Sanitary (Revit MEP) ──
      "ifcsanitaryterminal", "ifcsanitaryterminaltype",
      "ifcwasteterminal", "ifcwasteterminaltype",
      "ifcstackterminal", "ifcstackterminaltype",
      "ifcinterceptor", "ifcinterceptortype",
      "ifcfiresuppressionterminal", "ifcfiresuppressionterminaltype",
      // ── Electrical (Revit Electrical) ──
      "ifcoutlet", "ifcoutlettype",
      "ifcswitchingdevice", "ifcswitchingdevicetype",
      "ifcjunctionbox", "ifcjunctionboxtype",
      "ifcprotectivedevice", "ifcprotectivedevicetype",
      "ifcprotectivedevicetrippingunit", "ifcprotectivedevicetrippingunittype",
      "ifcelectricdistributionboard", "ifcelectricdistributionboardtype",
      "ifcelectricflowstoragedevice", "ifcelectricflowstoragedevicetype",
      "ifcelectrictimecontrol", "ifcelectrictimecontroltype",
      "ifcmotorconnection", "ifcmotorconnectiontype",
      "ifcsolardevice", "ifcsolardevicetype",
      "ifcelectricflowtreatmentdevice", "ifcelectricflowtreatmentdevicetype",
      // ── Cable & Wiring ──
      "ifccablecarriersegment", "ifccablecarriersegmenttype",
      "ifccablecarrierfitting", "ifccablecarrierfittingtype",
      "ifccablesegment", "ifccablesegmenttype",
      "ifccablefitting", "ifccablefittingtype",
      // ── Lighting ──
      "ifclightfixture", "ifclightfixturetype",
      "ifclamp", "ifclamptype",
      // ── Fire Protection & Safety ──
      "ifcalarm", "ifcalarmtype",
      "ifcfirehydrant",
      // ── Sensors, Actuators & Controls ──
      "ifcsensor", "ifcsensortype",
      "ifcactuator", "ifcactuatortype",
      "ifccontroller", "ifccontrollertype",
      "ifcunitarycontrolelement", "ifcunitarycontrolelementtype",
      "ifcflowinstrument", "ifcflowinstrumenttype",
      // ── Appliances & Devices ──
      "ifcaudiovisualappliance", "ifcaudiovisualappliancetype",
      "ifccommunicationsappliance", "ifccommunicationsappliancetype",
      "ifcelectricappliance", "ifcelectricappliancetype",
      "ifcmedicaldevice", "ifcmedicaldevicetype",
      // ── Furniture ──
      "ifcfurniture", "ifcfurnituretype",
      "ifcsystemfurnitureelement", "ifcsystemfurnitureelementtype",
      // ── IFC4.3 Civil / Infrastructure ──
      "ifccourse", "ifccoursetype",
      "ifcdeepfoundation", "ifcdeepfoundationtype",
      "ifccaissonfoundation", "ifccaissonfoundationtype",
      "ifckerb", "ifckerbtype",
      "ifcpavement", "ifcpavementtype",
      "ifcrail", "ifcrailtype",
      "ifctrackellement",
      "ifcsign", "ifcsigntype",
      "ifcsignal", "ifcsignaltype",
      "ifcnavigationelement",
      "ifcborehole",
      "ifcgeotechnicalassembly",
      "ifcgeotechnicalstratum",
      "ifcalignment", "ifcalignmentcant", "ifcalignmenthorizontal", "ifcalignmentvertical",
      "ifcalignmentsegment",
      "ifcreferent",
      "ifcfacility", "ifcfacilitypart", "ifcfacilitypartcommon",
      "ifcrailway", "ifcrailwaypart",
      "ifcmarinefacility", "ifcmarinepart",
      // ── Voids, Openings & Surface Features ──
      "ifcvoidingfeature",
      "ifcsurfacefeature", "ifcsurfacefeaturetype",
      // ── Distribution Ports & Connections ──
      "ifcdistributionport",
      "ifcdistributionchamber", "ifcdistributionchambertype",
      // ── Structural Analysis (ETABS, SAP2000, STAAD) ──
      "ifcstructuralcurvemember", "ifcstructuralsurfacemember",
      "ifcstructuralpointconnection", "ifcstructuralcurveconnection",
      "ifcstructuralsurfaceconnection",
      "ifcstructurallinearaction", "ifcstructuralsurfaceaction",
      "ifcstructuralpointaction",
      // ── Advance Steel / GRAITEC / Bocad ──
      "ifcelementcomponent", "ifcelementcomponenttype",
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
    // NOTE: Only called ONCE at the end now for speed
    // assignAssemblyInstances() is deferred until after enrichment

    // Build IFC hierarchy-based assembly map (like TC Windows)
    await buildAssemblyHierarchyMap(models);

    // ── KEY STEP: Fetch properties directly from IfcElementAssembly containers ──
    // TC API does NOT inherit properties from parent to children.
    // We must explicitly fetch the parent container's properties (ASSEMBLY_POS, etc.)
    // and propagate them to children ourselves.
    await fetchAssemblyContainerProperties();

    // Enrich objects missing ASSEMBLY_POS using IFC hierarchy
    // This mimics how Trimble Connect for Windows groups parts:
    // parts under the same IfcElementAssembly node share the same assembly
    await enrichAssemblyFromHierarchy();

    // Re-assign instances after enrichment - DEFERRED
    // assignAssemblyInstances();

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

    // ══════════════════════════════════════════════════════════════════
    // Remove IfcElementAssembly containers — only count CHILDREN
    // ══════════════════════════════════════════════════════════════════
    // IfcElementAssembly is an aggregate CONTAINER:
    //   weight = SUM(children weights)
    //   volume = SUM(children volumes)
    //   area   = SUM(children areas)
    // Keeping it would double-count all quantities.
    //
    // Before removing: propagate assembly grouping info to ALL children
    // so they remain correctly grouped under assembly_pos/assembly_name.
    // ══════════════════════════════════════════════════════════════════

    // Step 1: Build lookup map for quick object access
    const objectLookup = new Map();
    for (const obj of allObjects) {
      objectLookup.set(`${obj.modelId}:${obj.id}`, obj);
    }

    // Step 1.5: Enrich assemblyNodeInfoMap with ACTUAL parsed assembly properties
    // from the container objects (IfcElementAssembly). This is critical because:
    //   - assemblyNodeInfoMap initially only stores node.name (IFC entity name)
    //   - After parsing, containers now have actual ASSEMBLY_POS, ASSEMBLY_NAME, etc.
    //   - We must copy these BEFORE propagation, so children get correct values
    //   - Later when containers are removed from allObjects, the map still has correct data
    for (const [asmKey, nodeInfo] of assemblyNodeInfoMap) {
      const containerObj = objectLookup.get(asmKey);
      if (containerObj) {
        if (containerObj.assemblyPos) nodeInfo.assemblyPos = containerObj.assemblyPos;
        if (containerObj.assemblyName) nodeInfo.assemblyName = containerObj.assemblyName;
        if (containerObj.assemblyPosCode) nodeInfo.assemblyPosCode = containerObj.assemblyPosCode;
        if (containerObj.assemblyWeight > 0 && (!nodeInfo.assemblyWeight || containerObj.assemblyWeight > nodeInfo.assemblyWeight)) {
          nodeInfo.assemblyWeight = containerObj.assemblyWeight;
        }
        // Also use the container's own weight as assembly weight if not already set
        if (!nodeInfo.assemblyWeight && containerObj.weight > 0) {
          nodeInfo.assemblyWeight = containerObj.weight;
        }
      }
    }

    // Step 2: Propagate assembly info from IfcElementAssembly containers to ALL children
    // Uses 3 sources to maximize coverage:
    //   Source A: assemblyChildrenMap (from ElementAssembly hierarchy API)
    //   Source B: hierarchyParentMap (from spatial hierarchy — child→parent)
    //   Source C: assemblyMembershipMap (from walkAssemblyTree — child→assemblyKey)
    let childrenEnriched = 0;

    // Helper: propagate assembly info from container to child
    // IMPORTANT: Only propagate actual property values, NOT the container's IFC name.
    // The IFC entity name (e.g. "BEAM-1") is NOT the same as ASSEMBLY_POS.
    function propagateAssemblyInfo(containerObj, childObj) {
      // Use only actual assembly property values from the container
      // Do NOT use containerObj.name as fallback — that's the IFC entity name, not ASSEMBLY_POS
      const containerAssemblyPos = containerObj.assemblyPos || "";
      const containerAssemblyName = containerObj.assemblyName || "";
      const containerAssemblyPosCode = containerObj.assemblyPosCode || "";
      const containerAssembly = containerObj.assembly || "";

      // Need at least one real assembly property to propagate
      if (!containerAssemblyPos && !containerAssemblyName && !containerAssemblyPosCode && !containerAssembly) return false;

      let enriched = false;
      // Only propagate assemblyPos if container has a real assemblyPos value
      if (containerAssemblyPos && (!childObj.assemblyPos || childObj.assemblyPos === "(Không xác định)")) {
        childObj.assemblyPos = containerAssemblyPos;
        enriched = true;
      }
      // Only propagate assemblyName if container has a real assemblyName value  
      if (containerAssemblyName && (!childObj.assemblyName || childObj.assemblyName === "(Không xác định)")) {
        childObj.assemblyName = containerAssemblyName;
        enriched = true;
      }
      if (containerAssemblyPosCode && !childObj.assemblyPosCode) {
        childObj.assemblyPosCode = containerAssemblyPosCode;
        enriched = true;
      }
      if (containerAssembly && !childObj.assembly) {
        childObj.assembly = containerAssembly;
      }
      return enriched;
    }

    // Source A: assemblyChildrenMap (most direct — parent IfcElementAssembly → children)
    for (const obj of allObjects) {
      const cls = (obj.ifcClass || "").toLowerCase();
      if (cls !== "ifcelementassembly" && !cls.includes("elementassembly")) continue;

      const containerKey = `${obj.modelId}:${obj.id}`;
      const childIds = assemblyChildrenMap.get(containerKey);
      if (!childIds || childIds.size === 0) continue;

      for (const childId of childIds) {
        const childObj = objectLookup.get(`${obj.modelId}:${childId}`);
        if (childObj && propagateAssemblyInfo(obj, childObj)) {
          childrenEnriched++;
        }
      }
    }

      // Source B: hierarchyParentMap (spatial tree — for children missed by Source A)
    for (const [childKey, parentInfo] of hierarchyParentMap) {
      const parentCls = (parentInfo.class || "").toLowerCase();
      if (parentCls !== "ifcelementassembly" && !parentCls.includes("elementassembly")) continue;

      const childObj = objectLookup.get(childKey);
      if (!childObj) continue;

      // Find the parent container object to get its assembly properties
      const parentObj = objectLookup.get(`${parentInfo.modelId}:${parentInfo.id}`);
      if (parentObj) {
        if (propagateAssemblyInfo(parentObj, childObj)) {
          childrenEnriched++;
        }
      } else {
        // Parent was already removed or not in allObjects — use ONLY explicit
        // Tekla assembly properties captured in assemblyNodeInfoMap.
        const nodeInfo = assemblyNodeInfoMap.get(`${parentInfo.modelId}:${parentInfo.id}`);
        if (nodeInfo) {
          if (nodeInfo.assemblyPos && (!childObj.assemblyPos || childObj.assemblyPos === "(Không xác định)")) {
            childObj.assemblyPos = nodeInfo.assemblyPos;
            childrenEnriched++;
          }
          if (nodeInfo.assemblyName && !childObj.assemblyName) {
            childObj.assemblyName = nodeInfo.assemblyName;
          }
          if (nodeInfo.assemblyPosCode && !childObj.assemblyPosCode) {
            childObj.assemblyPosCode = nodeInfo.assemblyPosCode;
          }
        }
      }
    }

    // Source C: assemblyMembershipMap (explicit membership — for any remaining children)
    for (const obj of allObjects) {
      if (obj.assemblyPos && obj.assemblyPos !== "(Không xác định)") continue; // already has info

      const objectKey = `${obj.modelId}:${obj.id}`;
      const assemblyKey = assemblyMembershipMap.get(objectKey);
      if (!assemblyKey) continue;

      // Try to find the container in allObjects
      const containerObj = objectLookup.get(assemblyKey);
      if (containerObj) {
        if (propagateAssemblyInfo(containerObj, obj)) {
          childrenEnriched++;
        }
      } else {
        // Container already removed — use ONLY explicit Tekla properties
        // from assemblyNodeInfoMap (no IFC name fallback).
        const nodeInfo = assemblyNodeInfoMap.get(assemblyKey);
        if (nodeInfo) {
          if (nodeInfo.assemblyPos && (!obj.assemblyPos || obj.assemblyPos === "(Không xác định)")) {
            obj.assemblyPos = nodeInfo.assemblyPos;
            childrenEnriched++;
          }
          if (nodeInfo.assemblyName && !obj.assemblyName) {
            obj.assemblyName = nodeInfo.assemblyName;
          }
          if (nodeInfo.assemblyPosCode && !obj.assemblyPosCode) {
            obj.assemblyPosCode = nodeInfo.assemblyPosCode;
          }
        }
      }
    }

    if (childrenEnriched > 0) {
      console.log(`[ObjectExplorer] ✓ Propagated assembly info to ${childrenEnriched} children (3 sources: childrenMap + parentMap + membershipMap)`);
    }

    // Re-assign assembly instances after propagation to update assemblyInstanceId
    assignAssemblyInstances();

    // Step 3: Remove ALL IfcElementAssembly containers from allObjects
    // BUT save full objects for assembly grouping display (container headers)
    const beforeAssemblyDedup = allObjects.length;
    savedAssemblyContainers = [];
    allObjects = allObjects.filter((obj) => {
      const cls = (obj.ifcClass || "").toLowerCase();
      if (cls === "ifcelementassembly" || cls.includes("elementassembly")) {
        // Save the FULL object (with all parsed properties) for display purposes
        savedAssemblyContainers.push({ ...obj });
        return false; // REMOVE — container, not a real 3D object
      }
      return true;
    });
    if (savedAssemblyContainers.length > 0) {
      console.log(
        `[ObjectExplorer] Removed ${savedAssemblyContainers.length} IfcElementAssembly containers (${beforeAssemblyDedup} → ${allObjects.length} objects)`
      );
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
    // Initialize undo history with empty selection
    selectionHistory = [[]];
    selectionHistoryIndex = 0;
    updateUndoRedoButtons();
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

// ── Fetch properties in batches (parallel) ──
async function fetchAndParseProperties(modelId, objectIds) {
  const BATCH_SIZE = 200;
  const batchPromises = [];
  for (let i = 0; i < objectIds.length; i += BATCH_SIZE) {
    const batch = objectIds.slice(i, i + BATCH_SIZE);
    batchPromises.push(
      viewerRef.getObjectProperties(modelId, batch).then(propsArray => {
        const results = [];
        if (propsArray) {
          for (const props of propsArray) {
            results.push(parseObjectProperties(props, modelId));
          }
        }
        return results;
      }).catch(e => {
        console.warn(`[ObjectExplorer] batch failed:`, e);
        return batch.map(objId => ({
          id: objId, modelId, name: `Object ${objId}`,
          assembly: "", assemblyName: "", assemblyPos: "", assemblyPosCode: "",
          group: "", type: "", material: "",
          volume: 0, weight: 0, area: 0, length: 0,
          profile: "", ifcClass: "", isTekla: false, isTeklaBolt: false,
        }));
      })
    );
  }
  // Run all batches in parallel
  const batchResults = await Promise.all(batchPromises);
  for (const results of batchResults) {
    for (const obj of results) {
      allObjects.push(obj);
    }
  }
}

// ── Centralized Assembly Property Classifier ──
// Classifies any IFC property name into assembly categories.
// Returns: "pos" | "name" | "code" | "mark" | "generic" | null
//
// Tekla exports assembly properties in multiple formats:
//   1. Direct: "ASSEMBLY_POS", "ASSEMBLY_NAME", "ASSEMBLY_POSITION_CODE"
//   2. Prefixed: "Tekla.ASSEMBLY_POS", "Tekla Common/ASSEMBLY_POS"
//   3. ASSEMBLY. prefix on children: "ASSEMBLY.ASSEMBLY_POS" (inherits from parent assembly)
//   4. User-defined labels: "Assembly Pos", "Asm Pos", etc.
//   5. Slash-separated: "TeklaCommon/ASSEMBLY_POS"
function classifyAssemblyProperty(rawPropName) {
  if (!rawPropName) return null;

  // Strip ALL prefix notations:
  // "Tekla.ASSEMBLY_POS" → "ASSEMBLY_POS"
  // "TeklaCommon/ASSEMBLY_POS" → "ASSEMBLY_POS"
  // "ASSEMBLY.ASSEMBLY_POS" → "ASSEMBLY_POS"
  // "Pset_TeklaCommon/ASSEMBLY.ASSEMBLY_POS" → "ASSEMBLY_POS"
  // "ASSEMBLY_NAME.ASSEMBLY_POS" → "ASSEMBLY_POS" (compound names)
  let cleanName = rawPropName;
  
  // First strip path-like prefixes (slashes)
  const lastSlash = rawPropName.lastIndexOf("/");
  if (lastSlash > 0 && lastSlash < rawPropName.length - 1) {
    cleanName = rawPropName.substring(lastSlash + 1);
  }
  
  // Then strip ASSEMBLY. prefix (Tekla uses this for child-to-parent inheritance)
  // Handle nested: "ASSEMBLY.ASSEMBLY.ASSEMBLY_POS" → "ASSEMBLY_POS"
  while (cleanName.toUpperCase().startsWith("ASSEMBLY.")) {
    cleanName = cleanName.substring(9); // len("ASSEMBLY.") = 9
  }
  
  // Handle compound dot-separated patterns like "ASSEMBLY_NAME.ASSEMBLY_POS"
  // Take the last dot-segment if it looks like a known assembly property
  const lastDot = cleanName.lastIndexOf(".");
  if (lastDot > 0 && lastDot < cleanName.length - 1) {
    const afterDot = cleanName.substring(lastDot + 1);
    const afterDotNorm = afterDot.toLowerCase().replace(/[\s_\-]/g, "");
    // Only strip the prefix if the suffix looks like a known assembly property
    if (
      afterDotNorm.startsWith("assembly") ||
      afterDotNorm.startsWith("castunit") ||
      afterDotNorm === "mainpartpos" ||
      afterDotNorm === "mainpartposition" ||
      afterDotNorm === "mainpartmark" ||
      afterDotNorm === "positioncode" ||
      afterDotNorm === "preliminarymark"
    ) {
      cleanName = afterDot;
    } else {
      cleanName = cleanName.substring(lastDot + 1);
    }
  }

  // Normalize: lowercase, remove spaces, underscores, dots, hyphens
  const norm = cleanName.toLowerCase().replace(/[\s_.\-]/g, "");

  // ── ASSEMBLY_POS detection ──
  if (
    norm === "assemblypos" ||
    norm === "assemblyposition" ||
    norm === "mainpartpos" ||
    norm === "mainpartposition" ||
    norm === "asmpos" ||
    norm === "asmposition"
  ) {
    if (!norm.includes("code") && !norm.includes("prefix") && !norm.includes("number")) {
      return "pos";
    }
  }

  // ── ASSEMBLY_MARK detection ──
  // Also recognizes "assembly/cast unit mark" (Tekla cast unit naming convention)
  if (
    norm === "assemblymark" ||
    norm === "assemblemark" ||
    norm === "asmmark" ||
    norm === "mainmark" ||
    norm === "mainpartmark" ||
    norm === "assemblypartmark" ||
    norm === "castunitmark" ||
    norm === "assemblycastunitmark"
  ) {
    return "mark";
  }

  // ── ASSEMBLY_NAME detection ──
  if (
    norm === "assemblyname" ||
    norm === "assemblename" ||
    norm === "asmname" ||
    norm === "assemblypartname"
  ) {
    return "name";
  }

  // ── ASSEMBLY_POSITION_CODE detection ──
  // Also recognizes "assembly/cast unit position code" and common typo "ASSEMBLY_POSTION_CODE"
  if (
    norm === "assemblypositioncode" ||
    norm === "assemblyposcode" ||
    norm === "assemblyprefixcode" ||
    norm === "assemblyprefix" ||
    norm === "positioncode" ||
    norm === "asmposcode" ||
    norm === "asmpositioncode" ||
    norm === "assemblyposprefix" ||
    norm === "assemblypostioncode" ||     // common typo: POSTION → POSITION
    norm === "castunitpositioncode" ||    // cast unit naming variant
    norm === "castunitposcode" ||         // cast unit short variant
    norm === "assemblycastunitpositioncode"
  ) {
    return "code";
  }

  // ── Assembly Weight detection ──
  // Tekla exports: WEIGHT_NET, ASSEMBLY.WEIGHT, CAST_UNIT_WEIGHT, ASSEMBLY_WEIGHT
  if (
    norm === "weightnet" ||
    norm === "netweight" ||
    norm === "assemblyweight" ||
    norm === "castunitweight" ||
    norm === "castunitweightnet" ||
    norm === "assemblyweightnet" ||
    norm === "assemblynetweight" ||
    norm === "asmweight" ||
    norm === "asmweightnet" ||
    norm === "totalassemblyweight" ||
    norm === "assemblygrossweight"
  ) {
    return "weight";
  }

  // ── Generic assembly fallback ──
  if (
    norm === "assembly" ||
    norm === "teklaassembly" ||
    norm === "teklaassemblymark" ||
    norm === "preliminarymark"
  ) {
    return "generic";
  }

  // ── Revit Assembly Properties ──
  // Revit exports "Assembly Code" (UniFormat/OmniClass code) and "Assembly Description"
  if (
    norm === "assemblycode" ||
    norm === "uniformatcode" ||
    norm === "uniformatnumber" ||
    norm === "omniclasscode" ||
    norm === "omniclassnumber" ||
    norm === "classificationcode" ||
    norm === "classificationnumber"
  ) {
    return "code";
  }
  if (
    norm === "assemblydescription" ||
    norm === "uniformatdescription" ||
    norm === "uniformattitle" ||
    norm === "omniclasstitle" ||
    norm === "omniclassname" ||
    norm === "classificationname" ||
    norm === "classificationdescription" ||
    norm === "classificationtitle"
  ) {
    return "name";
  }

  // ── Revit "Type Mark" / "Mark" ──
  // In Revit, "Type Mark" identifies the type; "Mark" identifies the instance
  if (
    norm === "typemark" ||
    norm === "typeid"
  ) {
    return "mark";
  }

  // ── ArchiCAD Assembly / Classification ──
  if (
    norm === "archicadassembly" ||
    norm === "acassembly" ||
    norm === "archicadclassification" ||
    norm === "archicadid"
  ) {
    return "generic";
  }

  // ── Allplan / Nemetschek ──
  if (
    norm === "allplanassembly" ||
    norm === "allplanmark" ||
    norm === "nemetschekmark" ||
    norm === "allplanpositionmark"
  ) {
    return "mark";
  }

  // ── Advance Steel ──
  if (
    norm === "advancesteelassemblymark" ||
    norm === "asassemblymark" ||
    norm === "asmark" ||
    norm === "advancesteelmark" ||
    norm === "singlepartmark" ||
    norm === "mainpartmark"
  ) {
    return "mark";
  }
  if (
    norm === "advancesteelassemblyname" ||
    norm === "asassemblyname" ||
    norm === "advancesteelname"
  ) {
    return "name";
  }

  // ── GRAITEC / Bocad / ProSteel ──
  if (
    norm === "graitecassemblymark" ||
    norm === "bocadmark" ||
    norm === "prosteelmark" ||
    norm === "prosteelassembly"
  ) {
    return "mark";
  }

  // Regex fallback for unusual patterns (e.g. "Asm Pos", "Main_Part_Pos")
  if (/^ass?e?m(?:bly)?[\s_.-]?pos(?:ition)?$/i.test(cleanName)) return "pos";
  if (/^ass?e?m(?:bly)?[\s_.-]?mark$/i.test(cleanName)) return "mark";
  if (/^ass?e?m(?:bly)?[\s_.-]?name$/i.test(cleanName)) return "name";
  if (/^main[\s_.-]?part[\s_.-]?pos(?:ition)?$/i.test(cleanName)) return "pos";
  if (/^ass?e?m(?:bly)?[\s_.-]?pos(?:ition)?[\s_.-]?code$/i.test(cleanName)) return "code";
  if (/^pos(?:ition)?[\s_.-]?code$/i.test(cleanName)) return "code";
  if (/^ass?e?m(?:bly)?[\s_.-]?desc(?:ription)?$/i.test(cleanName)) return "name";
  if (/^type[\s_.-]?mark$/i.test(cleanName)) return "mark";
  if (/^single[\s_.-]?part[\s_.-]?mark$/i.test(cleanName)) return "mark";

  // Cast unit patterns (Tekla concrete cast unit naming)
  if (/^cast[\s_.-]?unit[\s_.-]?mark$/i.test(cleanName)) return "mark";
  if (/^cast[\s_.-]?unit[\s_.-]?pos(?:ition)?[\s_.-]?code$/i.test(cleanName)) return "code";
  if (/^cast[\s_.-]?unit[\s_.-]?pos(?:ition)?$/i.test(cleanName)) return "pos";
  if (/^cast[\s_.-]?unit[\s_.-]?name$/i.test(cleanName)) return "name";
  // Handle "assembly/cast unit" prefix forms (after slash-strip)
  if (/^(?:ass?e?m(?:bly)?[\s_./\\-]?)?cast[\s_.-]?unit[\s_.-]?mark$/i.test(cleanName)) return "mark";
  if (/^(?:ass?e?m(?:bly)?[\s_./\\-]?)?cast[\s_.-]?unit[\s_.-]?pos(?:it?ion)?[\s_.-]?code$/i.test(cleanName)) return "code";
  // Typo fallback: POSTION (missing I) in any pattern
  if (/^ass?e?m(?:bly)?[\s_.-]?post?ion[\s_.-]?code$/i.test(cleanName)) return "code";

  // ── Assembly Weight patterns (Tekla) ──
  if (/^weight[\s_.-]?net$/i.test(cleanName)) return "weight";
  if (/^net[\s_.-]?weight$/i.test(cleanName)) return "weight";
  if (/^ass?e?m(?:bly)?[\s_.-]?weight(?:[\s_.-]?net)?$/i.test(cleanName)) return "weight";
  if (/^cast[\s_.-]?unit[\s_.-]?weight(?:[\s_.-]?net)?$/i.test(cleanName)) return "weight";
  if (/^(?:ass?e?m(?:bly)?[\s_./\\-]?)?cast[\s_.-]?unit[\s_.-]?weight$/i.test(cleanName)) return "weight";
  if (/^total[\s_.-]?(?:assembly[\s_.-]?)?weight$/i.test(cleanName)) return "weight";

  // ── Classification system patterns (any software) ──
  if (/^classification[\s_.-]?(?:code|number|ref)$/i.test(cleanName)) return "code";
  if (/^classification[\s_.-]?(?:name|desc|title)$/i.test(cleanName)) return "name";
  if (/^uniformat[\s_.-]?(?:code|number|id)$/i.test(cleanName)) return "code";
  if (/^omniclass[\s_.-]?(?:code|number|id)$/i.test(cleanName)) return "code";
  if (/^uniclass[\s_.-]?(?:code|number|id)$/i.test(cleanName)) return "code";
  if (/^masterformat[\s_.-]?(?:code|number|id)$/i.test(cleanName)) return "code";

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
            // Note: node.name is the IFC entity name. Assembly properties
            // (assemblyPos, assemblyName, assemblyPosCode) will be enriched
            // later from the parsed object properties.
            assemblyNodeInfoMap.set(assemblyKey, {
              id: node.id,
              name: node.name || "",
              class: node.class || "",
              modelId: modelId,
              // These will be filled from parsed object properties later
              assemblyPos: "",
              assemblyName: "",
              assemblyPosCode: "",
              assemblyWeight: 0,    // WEIGHT_NET / CAST_UNIT_WEIGHT (kg)
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

// ══════════════════════════════════════════════════════════════════════════════
// ── Fetch properties directly from IfcElementAssembly containers ──
// ══════════════════════════════════════════════════════════════════════════════
// 
// PROBLEM: TC Viewer API does NOT implement "Values inherited from higher
//   level assembly". When you call getObjectProperties() for an IfcBeam child,
//   you get ONLY properties written directly on that IfcBeam.
//   ASSEMBLY_POS, ASSEMBLY_NAME, ASSEMBLY_POSITION_CODE are typically 
//   stored ONLY on the IfcElementAssembly container in Tekla IFC exports.
//
// SOLUTION: Explicitly fetch properties for EVERY IfcElementAssembly node
//   found in the hierarchy, extract assembly properties, then propagate
//   them to all children via enrichAssemblyFromHierarchy().
//
// This is the missing link that makes the extension understand
// "inherited values" — something TC web shows but doesn't expose via API.
// ══════════════════════════════════════════════════════════════════════════════
async function fetchAssemblyContainerProperties() {
  if (!viewerRef || assemblyNodeInfoMap.size === 0) return;

  console.log(`[AssemblyFetch] Fetching properties for ${assemblyNodeInfoMap.size} IfcElementAssembly containers...`);

  // Group assembly nodes by modelId for batch fetching
  const byModel = new Map(); // modelId → [{ key, nodeInfo }]
  for (const [key, nodeInfo] of assemblyNodeInfoMap) {
    const modelId = nodeInfo.modelId;
    if (!byModel.has(modelId)) byModel.set(modelId, []);
    byModel.get(modelId).push({ key, nodeInfo });
  }

  let totalFetched = 0;
  let enrichedCount = 0;
  let withPos = 0, withName = 0, withCode = 0;

  for (const [modelId, entries] of byModel) {
    // Extract object IDs for this model
    const objectIds = entries.map(e => e.nodeInfo.id);
    
    // Batch fetch (200 per batch for performance)
    const BATCH_SIZE = 200;
    for (let i = 0; i < objectIds.length; i += BATCH_SIZE) {
      const batchIds = objectIds.slice(i, i + BATCH_SIZE);
      const batchEntries = entries.slice(i, i + BATCH_SIZE);
      
      try {
        const propsArray = await viewerRef.getObjectProperties(modelId, batchIds);
        if (!propsArray) continue;

        for (let j = 0; j < propsArray.length; j++) {
          const props = propsArray[j];
          const entry = batchEntries[j];
          if (!props || !entry) continue;

          totalFetched++;
          let foundAny = false;

          // Parse ALL property sets from the container
          const propertySets = props.properties || [];
          for (const pSet of propertySets) {
            const pSetName = pSet.name || "";
            const properties = pSet.properties || [];
            for (const prop of properties) {
              const rawPropName = prop.name || "";
              const propValue = String(prop.value || "").trim();
              if (!propValue) continue;

              // Try classification with propName alone first, then with pSet/propName
              let asmClass = classifyAssemblyProperty(rawPropName);
              if (!asmClass && pSetName) {
                asmClass = classifyAssemblyProperty(`${pSetName}/${rawPropName}`);
              }
              if (!asmClass) continue;

              if ((asmClass === "pos" || asmClass === "mark") && !entry.nodeInfo.assemblyPos) {
                entry.nodeInfo.assemblyPos = propValue;
                withPos++;
                foundAny = true;
              }
              if (asmClass === "mark" && !entry.nodeInfo.assemblyName) {
                entry.nodeInfo.assemblyName = propValue;
                withName++;
                foundAny = true;
              }
              if (asmClass === "name" && !entry.nodeInfo.assemblyName) {
                entry.nodeInfo.assemblyName = propValue;
                withName++;
                foundAny = true;
              }
              if (asmClass === "code" && !entry.nodeInfo.assemblyPosCode) {
                entry.nodeInfo.assemblyPosCode = propValue;
                withCode++;
                foundAny = true;
              }
              if (asmClass === "weight") {
                const asmW = parseQuantityNumber(propValue);
                if (!isNaN(asmW) && asmW > 0 && asmW > (entry.nodeInfo.assemblyWeight || 0)) {
                  entry.nodeInfo.assemblyWeight = asmW;
                  foundAny = true;
                }
              }

              // Also check for weight properties by direct name matching
              // (catches WEIGHT_NET, NetWeight, GrossWeight on assembly containers)
              const propNameLower = rawPropName.toLowerCase().replace(/[\s_.\-]/g, "");
              if (!asmClass && (
                propNameLower === "weightnet" ||
                propNameLower === "netweight" ||
                propNameLower === "grossweight" ||
                propNameLower === "weight" ||
                propNameLower === "mass" ||
                propNameLower === "netmass" ||
                propNameLower === "grossmass"
              )) {
                const w = parseQuantityNumber(propValue);
                if (!isNaN(w) && w > 0 && w > (entry.nodeInfo.assemblyWeight || 0)) {
                  entry.nodeInfo.assemblyWeight = w;
                  foundAny = true;
                }
              }
            }
          }

          // Also extract from product info
          if (props.product) {
            if (!entry.nodeInfo.assemblyName && props.product.name) {
              entry.nodeInfo.assemblyName = props.product.name;
              withName++;
              foundAny = true;
            }
          }

          if (foundAny) {
            enrichedCount++;
            // Update the assemblyNodeInfoMap
            assemblyNodeInfoMap.set(entry.key, entry.nodeInfo);
          }
        }
      } catch (e) {
        console.warn(`[AssemblyFetch] Batch fetch failed for model ${modelId}:`, e);
      }
    }
  }

  console.log(
    `[AssemblyFetch] Fetched ${totalFetched}/${assemblyNodeInfoMap.size} containers. Enriched: ${enrichedCount}`
  );

  // ── FALLBACK: Use IfcElementAssembly IFC entity name as assemblyPos ──
  // In Tekla IFC exports, the IfcElementAssembly node name IS the assembly mark
  // (e.g., "B-1", "C-2", "PLATE-1"). Even when ASSEMBLY_POS is not exported
  // as an explicit property, the hierarchy node name contains this information.
  // This fallback ensures children can still be grouped by assembly.
  let fallbackCount = 0;
  for (const [key, nodeInfo] of assemblyNodeInfoMap) {
    if (!nodeInfo.assemblyPos && nodeInfo.name && nodeInfo.name.trim()) {
      // Use the IFC entity name as assemblyPos fallback
      nodeInfo.assemblyPos = nodeInfo.name.trim();
      fallbackCount++;
      // Also set assemblyName if empty
      if (!nodeInfo.assemblyName) {
        nodeInfo.assemblyName = nodeInfo.name.trim();
      }
    }
  }
  if (fallbackCount > 0) {
    console.log(
      `[AssemblyFetch] ✓ Used IFC entity name as ASSEMBLY_POS fallback for ${fallbackCount}/${assemblyNodeInfoMap.size} containers`
    );
  }
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
    // NOW ENHANCED: nodeInfo contains actual ASSEMBLY_POS/NAME/CODE fetched from the container
    const assemblyKey = assemblyMembershipMap.get(objectKey);
    if (assemblyKey) {
      const nodeInfo = assemblyNodeInfoMap.get(assemblyKey);
      if (nodeInfo) {
        // Priority 1: Use ASSEMBLY_POS fetched directly from the container via API
        if (nodeInfo.assemblyPos && nodeInfo.assemblyPos.trim()) {
          obj.assemblyPos = nodeInfo.assemblyPos;
        }
        // Priority 2: Use assemblyPos from the parsed container object (if it's in allObjects)
        else {
          const assemblyObj = objectMap.get(assemblyKey);
          if (assemblyObj && assemblyObj.assemblyPos && assemblyObj.assemblyPos.trim()) {
            obj.assemblyPos = assemblyObj.assemblyPos;
          }
        }

        // Use enriched assemblyName (from container API or parsed container object)
        if (!obj.assemblyName) {
          const assemblyObj = objectMap.get(assemblyKey);
          if (nodeInfo.assemblyName && nodeInfo.assemblyName.trim()) {
            obj.assemblyName = nodeInfo.assemblyName;
          } else if (assemblyObj && assemblyObj.assemblyName && assemblyObj.assemblyName.trim()) {
            obj.assemblyName = assemblyObj.assemblyName;
          }
        }
        // Use enriched assemblyPosCode (from container API)
        if (!obj.assemblyPosCode && nodeInfo.assemblyPosCode) {
          obj.assemblyPosCode = nodeInfo.assemblyPosCode;
        }
        obj.isTekla = true;
        if (obj.assemblyPos || obj.assemblyName || obj.assemblyPosCode) {
          enrichedFromAssembly++;
          continue;
        }
      }
    }

    // Strategy 2: Use direct parent assembly node from hierarchy.
    // Do NOT use structural parent names as synthetic assembly values.
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
        // Assembly parent — inherit explicit assembly properties only
        const parentObj = objectMap.get(`${obj.modelId}:${parentInfo.id}`);
        if (parentObj && parentObj.assemblyPos && parentObj.assemblyPos.trim()) {
          obj.assemblyPos = parentObj.assemblyPos;
        }
        if (parentObj && !obj.assemblyName && parentObj.assemblyName) obj.assemblyName = parentObj.assemblyName;
        if (parentObj && !obj.assemblyPosCode && parentObj.assemblyPosCode) obj.assemblyPosCode = parentObj.assemblyPosCode;
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

    // Strategy 4 intentionally removed:
    // No cross-fill from assemblyName/assembly to assemblyPos to avoid false groups.

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
    assemblyWeight: 0,    // WEIGHT_NET / CAST_UNIT_WEIGHT / ASSEMBLY.WEIGHT from Tekla (kg)
    assemblyWeightSource: "", // "ifc" = from IFC property on assembly container
    group: "",
    type: "",
    material: "",
    volume: 0,
    weight: 0,
    area: 0,
    netArea: 0,            // Net surface area (excludes openings/cuts)
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
    partRole: "",         // Classified role: mainPart, secondaryPart, bolt, accessory, standalone
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
    // rawProperties removed for performance
    // ── Density & Weight Source tracking ──
    density: 0,           // kg/m³ — the density used for weight calculation
    densityLabel: "",     // Human-readable label: "Thép", "Bê tông", "Gỗ", "Nhôm"
    weightSource: "",     // "ifc" = from IFC property, "calculated" = Volume × Density
    // ── Source Application Detection ──
    sourceApp: "",        // "Tekla" | "Revit" | "ArchiCAD" | "Allplan" | "AdvanceSteel" | "ETABS" | "Bentley" | ""
    // ── Revit-specific Properties ──
    revitCategory: "",    // Category (e.g., "Structural Framing", "Columns", "Walls")
    revitFamily: "",      // Family (e.g., "W Shapes-Column", "Basic Wall")
    revitType: "",        // Type Name (e.g., "W14X48", "Generic - 200mm")
    revitFamilyAndType: "", // Family and Type combined
    revitLevel: "",       // Level (e.g., "Level 1", "Floor 3")
    revitMark: "",        // Mark (instance identifier in Revit)
    revitPhase: "",       // Phase Created
    revitWorkset: "",     // Workset
    // ── ArchiCAD-specific Properties ──
    archicadLayer: "",    // Layer
    archicadID: "",       // Element ID
    archicadRenovation: "", // Renovation Status
    // ── Generic Multi-Software Properties ──
    classification: "",   // Classification system code (UniFormat, OmniClass, Uniclass, etc.)
    classificationName: "", // Classification description/name
    level: "",            // Level/storey (from any software)
    description: "",      // Description (from any software)
    tag: "",              // Tag / Mark / Label (from any software)
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

    // Detect source application origin by property set name
    const setNameNorm = setName.replace(/[\s_.\-]/g, "");
    if (
      setName.includes("tekla") ||
      setNameNorm === "teklaquantity" ||
      setNameNorm === "teklacommon" ||
      setNameNorm === "teklabim" ||
      setNameNorm === "teklaassembly" ||
      setNameNorm.startsWith("psettekla")
    ) {
      result.isTekla = true;
      if (!result.sourceApp) result.sourceApp = "Tekla";
    }
    // Revit detection
    if (
      setName.includes("revit") ||
      setNameNorm.startsWith("psetrevit") ||
      setName === "identity data" ||
      setName === "structural" ||
      setName === "dimensions" ||
      setName === "constraints" ||
      setName === "mechanical" ||
      setName === "electrical" ||
      setName === "plumbing" ||
      setName === "energy analysis" ||
      setName === "phasing" ||
      setName === "ifc parameters" ||
      setName === "other" ||
      setName === "construction" ||
      setName === "analytical properties"
    ) {
      if (!result.sourceApp || result.sourceApp === "") result.sourceApp = "Revit";
    }
    // ArchiCAD detection
    if (
      setName.includes("archicad") ||
      setNameNorm.startsWith("acpset") ||
      setName.includes("graphisoft") ||
      setNameNorm === "gspropertygroup" ||
      setNameNorm.startsWith("archicad")
    ) {
      if (!result.sourceApp) result.sourceApp = "ArchiCAD";
    }
    // Allplan / Nemetschek detection
    if (
      setName.includes("allplan") ||
      setName.includes("nemetschek") ||
      setNameNorm.startsWith("allplan")
    ) {
      if (!result.sourceApp) result.sourceApp = "Allplan";
    }
    // Advance Steel detection
    if (
      setName.includes("advance steel") ||
      setName.includes("advancesteel") ||
      setNameNorm.startsWith("as") && setNameNorm.includes("steel")
    ) {
      if (!result.sourceApp) result.sourceApp = "AdvanceSteel";
    }
    // ETABS / SAP2000 / CSI detection
    if (
      setName.includes("etabs") ||
      setName.includes("sap2000") ||
      setName.includes("csi") ||
      setNameNorm.startsWith("etabs") ||
      setNameNorm.startsWith("sap2000")
    ) {
      if (!result.sourceApp) result.sourceApp = "ETABS";
    }
    // Bentley / MicroStation / OpenBuildings detection
    if (
      setName.includes("bentley") ||
      setName.includes("microstation") ||
      setName.includes("openbuildings") ||
      setName.includes("prosteel") ||
      setName.includes("prostructures")
    ) {
      if (!result.sourceApp) result.sourceApp = "Bentley";
    }
    // STAAD.Pro detection
    if (setName.includes("staad")) {
      if (!result.sourceApp) result.sourceApp = "STAAD";
    }
    // SolidWorks detection
    if (setName.includes("solidworks") || setNameNorm.startsWith("sw") && setNameNorm.includes("property")) {
      if (!result.sourceApp) result.sourceApp = "SolidWorks";
    }
    // Rhino / Grasshopper detection
    if (setName.includes("rhino") || setName.includes("grasshopper") || setName.includes("geometrygym")) {
      if (!result.sourceApp) result.sourceApp = "Rhino";
    }
    // GRAITEC / Bocad detection
    if (setName.includes("graitec") || setName.includes("bocad")) {
      if (!result.sourceApp) result.sourceApp = "GRAITEC";
    }
    // Qto_ standard quantity property sets (IFC standard — used by ALL software)
    const isQtoPropertySet = setNameNorm.startsWith("qto") || setName.startsWith("qto_");

    // Tekla detection from assembly properties is done in the main property loop below

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
        // Classify the property — try propName alone first, then pSetName/propName
        let asmClass = classifyAssemblyProperty(rawPropName);
        if (!asmClass && pSet.name) {
          asmClass = classifyAssemblyProperty(`${pSet.name}/${rawPropName}`);
        }

        if (asmClass === "pos" && !result.assemblyPos) {
          result.assemblyPos = asmVal;
        } else if (asmClass === "mark") {
          // ASSEMBLY_MARK / cast unit mark → sets BOTH assemblyPos AND assemblyName
          if (!result.assemblyPos) {
            result.assemblyPos = asmVal;
          }
          if (!result.assemblyName) {
            result.assemblyName = asmVal;
          }
        } else if (asmClass === "name" && !result.assemblyName) {
          result.assemblyName = asmVal;
        } else if (asmClass === "code" && !result.assemblyPosCode) {
          result.assemblyPosCode = asmVal;
        } else if (asmClass === "weight") {
          const asmW = parseQuantityNumber(asmVal);
          if (!isNaN(asmW) && asmW > 0 && asmW > result.assemblyWeight) {
            result.assemblyWeight = asmW;
            result.assemblyWeightSource = "ifc";
          }
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
        if (!isNaN(w) && w > 0 && w > result.weight) {
          result.weight = w;
          result.weightSource = "ifc";
        }
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
        // Track net area separately (property names containing "net")
        const isNetArea = normalizedArea.startsWith("net") ||
          propName.startsWith("net") ||
          propName === "net surface area" ||
          propName === "net area";
        if (isNetArea && !isNaN(a) && a > result.netArea) {
          result.netArea = a;
        }
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
          propName === "typename" ||
          propName === "predefinedtype" ||
          propNameNorm === "elementtype")
      ) {
        result.type = String(propValue || "");
      }

      // ── Revit-specific Property Extraction ──
      if (setName === "identity data" || setName.includes("revit") || setNameNorm.startsWith("psetrevit")) {
        if (propName === "category" && !result.revitCategory) {
          result.revitCategory = String(propValue || "");
        }
        if ((propName === "family" || propNameNorm === "familyname") && !result.revitFamily) {
          result.revitFamily = String(propValue || "");
        }
        if ((propName === "family and type" || propNameNorm === "familyandtype") && !result.revitFamilyAndType) {
          result.revitFamilyAndType = String(propValue || "");
        }
        if ((propName === "type" || propNameNorm === "typename" || propName === "type name") && !result.revitType) {
          result.revitType = String(propValue || "");
        }
        if ((propName === "mark" || propNameNorm === "instancemark") && !result.revitMark) {
          result.revitMark = String(propValue || "");
        }
        if ((propName === "level" || propNameNorm === "referencelevel" || propName === "schedule level") && !result.revitLevel) {
          result.revitLevel = String(propValue || "");
          if (!result.level) result.level = result.revitLevel;
        }
        if ((propName === "workset" || propNameNorm === "worksetname") && !result.revitWorkset) {
          result.revitWorkset = String(propValue || "");
        }
        if ((propName === "phase created" || propNameNorm === "phasecreated") && !result.revitPhase) {
          result.revitPhase = String(propValue || "");
        }
      }

      // ── Revit Assembly Code / Description (can appear in multiple psets) ──
      if (propNameNorm === "assemblycode" && !result.classification) {
        result.classification = String(propValue || "");
      }
      if (propNameNorm === "assemblydescription" && !result.classificationName) {
        result.classificationName = String(propValue || "");
      }

      // ── Category detection (Revit, ArchiCAD, any software) ──
      if (!result.revitCategory && propName === "category") {
        result.revitCategory = String(propValue || "");
      }

      // ── ArchiCAD-specific Property Extraction ──
      if (setName.includes("archicad") || setNameNorm.startsWith("acpset")) {
        if ((propName === "layer" || propNameNorm === "archicadlayer") && !result.archicadLayer) {
          result.archicadLayer = String(propValue || "");
        }
        if ((propName === "element id" || propNameNorm === "elementid" || propNameNorm === "archicadid") && !result.archicadID) {
          result.archicadID = String(propValue || "");
        }
        if ((propNameNorm === "renovationstatus" || propName === "renovation status") && !result.archicadRenovation) {
          result.archicadRenovation = String(propValue || "");
        }
      }

      // ── Generic Level/Storey detection (any software) ──
      if (!result.level && (
        propName === "level" ||
        propName === "storey" ||
        propName === "floor" ||
        propNameNorm === "referencelevel" ||
        propNameNorm === "baselevel" ||
        propNameNorm === "buildingstorey" ||
        propName === "tầng"
      )) {
        result.level = String(propValue || "");
      }

      // ── Generic Description (any software) ──
      if (!result.description && (
        propName === "description" ||
        propName === "mô tả" ||
        propNameNorm === "longdescription"
      )) {
        result.description = String(propValue || "");
      }

      // ── Generic Tag / Mark (any software) ──
      if (!result.tag && (
        propName === "tag" ||
        propNameNorm === "tagnumber" ||
        propNameNorm === "elementtag" ||
        (propName === "mark" && setName !== "identity data")
      )) {
        result.tag = String(propValue || "");
      }

      // ── Classification systems (UniFormat, OmniClass, Uniclass, MasterFormat) ──
      if (!result.classification && (
        propNameNorm === "classificationcode" ||
        propNameNorm === "classificationreference" ||
        propNameNorm === "uniformat" ||
        propNameNorm === "uniformatcode" ||
        propNameNorm === "omniclass" ||
        propNameNorm === "omniclassnumber" ||
        propNameNorm === "uniclass" ||
        propNameNorm === "uniclasscode" ||
        propNameNorm === "masterformat" ||
        propNameNorm === "masterformatcode"
      )) {
        result.classification = String(propValue || "");
      }
      if (!result.classificationName && (
        propNameNorm === "classificationname" ||
        propNameNorm === "classificationdescription" ||
        propNameNorm === "classificationtitle" ||
        propNameNorm === "uniformatdescription" ||
        propNameNorm === "omniclasstitle" ||
        propNameNorm === "uniclasstitle" ||
        propNameNorm === "masterformattitle"
      )) {
        result.classificationName = String(propValue || "");
      }

      // ── Qto_ standard quantity extraction (IFC standard — any software) ──
      if (isQtoPropertySet) {
        // Volume from Qto_ sets (e.g., Qto_BeamBaseQuantities/NetVolume)
        if (propNameNorm === "netvolume" || propNameNorm === "grossvolume" || propNameNorm === "volume") {
          const v = parseQuantityNumber(propValue);
          if (!isNaN(v) && v > result.volume) result.volume = v;
        }
        // Weight from Qto_ sets
        if (propNameNorm === "netweight" || propNameNorm === "grossweight" || propNameNorm === "weight" || propNameNorm === "mass") {
          const w = parseQuantityNumber(propValue);
          if (!isNaN(w) && w > 0 && w > result.weight) {
            result.weight = w;
            result.weightSource = "ifc";
          }
        }
        // Area from Qto_ sets
        if (propNameNorm === "netsurfacearea" || propNameNorm === "grosssurfacearea" ||
            propNameNorm === "netarea" || propNameNorm === "grossarea" ||
            propNameNorm === "area" || propNameNorm === "outersurfacearea" ||
            propNameNorm === "netsidearea" || propNameNorm === "grosssidearea" ||
            propNameNorm === "netfloorarea" || propNameNorm === "grossfloorarea") {
          const a = parseQuantityNumber(propValue);
          if (!isNaN(a) && a > result.area) result.area = a;
          // Track net area separately from Qto_ sets
          if (propNameNorm.startsWith("net") && !isNaN(a) && a > result.netArea) {
            result.netArea = a;
          }
        }
        // Length from Qto_ sets
        if (propNameNorm === "length" || propNameNorm === "netlength" ||
            propNameNorm === "grosslength" || propNameNorm === "height" ||
            propNameNorm === "width" || propNameNorm === "depth" ||
            propNameNorm === "perimeter") {
          const l = parseQuantityNumber(propValue);
          if (!isNaN(l) && l > result.length) result.length = l;
        }
      }

      // ── Pset_*Common property extraction (IFC standard — any software) ──
      // These standard property sets contain common properties for each element type
      if (setNameNorm.startsWith("pset") && setNameNorm.endsWith("common")) {
        if (propNameNorm === "reference" && !result.referenceName) {
          result.referenceName = String(propValue || "");
        }
        if (propNameNorm === "status" && !result.description) {
          result.description = String(propValue || "");
        }
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

  // Fallback: use product description as assembly (generic) if still empty
  if (!result.assembly && props.product && props.product.description) {
    const desc = props.product.description.trim();
    if (desc && desc !== result.name) {
      result.assembly = desc;
    }
  }

  // Keep Tekla assembly fields strict:
  // - assemblyPos      <- ASSEMBLY_POS / ASSEMBLY_MARK only
  // - assemblyName     <- ASSEMBLY_NAME only
  // - assemblyPosCode  <- ASSEMBLY_POSITION_CODE only
  // Avoid cross-filling between these fields to prevent false grouping.

  // Fallback name
  if (!result.name) result.name = `Object ${props.id}`;

  // Calculate weight from volume if not provided
  // Fixed density for all objects: 7850 kg/m³
  {
    const density = 7850;
    const densityLabel = "Thép";
    // Store density info on every object for transparency
    result.density = density;
    result.densityLabel = densityLabel;
    if (result.weight === 0 && result.volume > 0) {
      result.weight = result.volume * density;
      result.weightSource = "calculated";
    }
    // If weight came from IFC but no weightSource set yet, mark it
    if (result.weight > 0 && !result.weightSource) {
      result.weightSource = "ifc";
    }
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
          (o.productName && o.productName.toLowerCase().includes(q)) ||
          // Multi-software properties
          (o.sourceApp && o.sourceApp.toLowerCase().includes(q)) ||
          (o.revitCategory && o.revitCategory.toLowerCase().includes(q)) ||
          (o.revitFamily && o.revitFamily.toLowerCase().includes(q)) ||
          (o.revitType && o.revitType.toLowerCase().includes(q)) ||
          (o.revitFamilyAndType && o.revitFamilyAndType.toLowerCase().includes(q)) ||
          (o.revitLevel && o.revitLevel.toLowerCase().includes(q)) ||
          (o.revitMark && o.revitMark.toLowerCase().includes(q)) ||
          (o.archicadLayer && o.archicadLayer.toLowerCase().includes(q)) ||
          (o.classification && o.classification.toLowerCase().includes(q)) ||
          (o.classificationName && o.classificationName.toLowerCase().includes(q)) ||
          (o.level && o.level.toLowerCase().includes(q)) ||
          (o.description && o.description.toLowerCase().includes(q)) ||
          (o.tag && o.tag.toLowerCase().includes(q)),
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

// ── Check if groupBy mode should use assembly container grouping ──
// Assembly grouping uses IfcElementAssembly containers as intermediate level:
//   Level 1: Assembly value (name/pos/code)
//   Level 2: IfcElementAssembly containers (grouping only — no weight)
//   Level 3: Children within each container (actual quantities)
function isAssemblyGroupingMode(groupBy) {
  return groupBy === "assemblyName" || groupBy === "assemblyPos" || groupBy === "assemblyPosCode";
}

// ── Get assembly field key from groupBy ──
function getAssemblyFieldKeyForTree(groupBy) {
  switch (groupBy) {
    case "assemblyName": return "assemblyName";
    case "assemblyPos": return "assemblyPos";
    case "assemblyPosCode": return "assemblyPosCode";
    default: return null;
  }
}

// ── Get assembly group icon ──
function getAssemblyGroupIcon(groupBy) {
  switch (groupBy) {
    case "assemblyName": return "🏗️";
    case "assemblyPos": return "📍";
    case "assemblyPosCode": return "🔖";
    default: return "📦";
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Build assembly container groups for Object Tree ──
// Structure:
//   Level 1: Assembly value (name/pos/code)
//     Level 2: IfcElementAssembly containers (📦) — listing only, no weight
//       Level 3: Children within each container (actual objects)
//     Direct children (not in any IfcElementAssembly container)
//
// Uses 3 strategies to find child→container mapping:
//   Strategy 1: assemblyMembershipMap (from ElementAssembly hierarchy API)
//   Strategy 2: hierarchyParentMap (from SpatialHierarchy API)
//   Strategy 3: savedAssemblyContainers matched by assembly property values
//
// IMPORTANT: IfcElementAssembly containers are for listing/grouping ONLY.
// Actual weight/volume/area totals always come from the children.
// ══════════════════════════════════════════════════════════════════════════════
function buildAssemblyContainerGroupsForTree(objects, groupBy) {
  const fieldKey = getAssemblyFieldKeyForTree(groupBy);
  if (!fieldKey) return null;

  // ── Build comprehensive child→container lookup ──
  // Uses multiple strategies to maximize coverage
  const childToContainerKey = new Map(); // objKey → containerKey
  const containerInfoLookup = new Map(); // containerKey → { name, id, modelId, ... }

  // Strategy 1: assemblyMembershipMap (from ElementAssembly hierarchy API)
  for (const [childKey, containerKey] of assemblyMembershipMap) {
    if (childKey === containerKey) continue; // skip self-references
    childToContainerKey.set(childKey, containerKey);
    // Get container info from assemblyNodeInfoMap
    const nodeInfo = assemblyNodeInfoMap.get(containerKey);
    if (nodeInfo && !containerInfoLookup.has(containerKey)) {
      containerInfoLookup.set(containerKey, {
        key: containerKey,
        id: nodeInfo.id,
        modelId: nodeInfo.modelId,
        name: nodeInfo.name || `Container ${nodeInfo.id}`,
        ifcClass: nodeInfo.class || "IfcElementAssembly",
        assemblyPos: nodeInfo.assemblyPos || "",
        assemblyName: nodeInfo.assemblyName || "",
        assemblyPosCode: nodeInfo.assemblyPosCode || "",
        assemblyWeight: nodeInfo.assemblyWeight || 0,
      });
    }
  }

  // Strategy 2: hierarchyParentMap (from SpatialHierarchy API)
  // For children not yet mapped, check if their spatial parent is an IfcElementAssembly
  for (const obj of objects) {
    const objKey = `${obj.modelId}:${obj.id}`;
    if (childToContainerKey.has(objKey)) continue; // already mapped

    const parentInfo = hierarchyParentMap.get(objKey);
    if (parentInfo) {
      const parentCls = (parentInfo.class || "").toLowerCase();
      if (parentCls === "ifcelementassembly" || parentCls.includes("elementassembly")) {
        const parentKey = `${parentInfo.modelId}:${parentInfo.id}`;
        childToContainerKey.set(objKey, parentKey);
        if (!containerInfoLookup.has(parentKey)) {
          containerInfoLookup.set(parentKey, {
            key: parentKey,
            id: parentInfo.id,
            modelId: parentInfo.modelId,
            name: parentInfo.name || `Container ${parentInfo.id}`,
            ifcClass: parentInfo.class || "IfcElementAssembly",
            assemblyPos: "",
            assemblyName: "",
            assemblyPosCode: "",
          });
        }
      }
    }
  }

  // Strategy 3: savedAssemblyContainers matched by assembly property values
  // Build container info from saved IfcElementAssembly objects (have full parsed properties)
  for (const container of savedAssemblyContainers) {
    const containerKey = `${container.modelId}:${container.id}`;
    if (!containerInfoLookup.has(containerKey)) {
      containerInfoLookup.set(containerKey, {
        key: containerKey,
        id: container.id,
        modelId: container.modelId,
        name: container.name || `Container ${container.id}`,
        ifcClass: container.ifcClass || "IfcElementAssembly",
        assemblyPos: container.assemblyPos || "",
        assemblyName: container.assemblyName || "",
        assemblyPosCode: container.assemblyPosCode || "",
      });
    } else {
      // Enrich existing entry with saved object's parsed properties (more complete)
      const existing = containerInfoLookup.get(containerKey);
      if (!existing.assemblyPos && container.assemblyPos) existing.assemblyPos = container.assemblyPos;
      if (!existing.assemblyName && container.assemblyName) existing.assemblyName = container.assemblyName;
      if (!existing.assemblyPosCode && container.assemblyPosCode) existing.assemblyPosCode = container.assemblyPosCode;
      if (existing.name === `Container ${existing.id}` && container.name) existing.name = container.name;
    }

    // For children still unmapped: match by assemblyChildrenMap
    const childIds = assemblyChildrenMap.get(containerKey);
    if (childIds) {
      for (const childId of childIds) {
        const childKey = `${container.modelId}:${childId}`;
        if (!childToContainerKey.has(childKey)) {
          childToContainerKey.set(childKey, containerKey);
        }
      }
    }
  }

  console.log(
    `[AssemblyGrouping] child→container mappings: ${childToContainerKey.size}, ` +
    `container info entries: ${containerInfoLookup.size}, ` +
    `saved containers: ${savedAssemblyContainers.length}`
  );

  // ── Build the grouped result ──
  const assemblyGroups = {};

  for (const obj of objects) {
    const assemblyValue = obj[fieldKey] || "(Không xác định)";

    // Ensure the assembly group exists
    if (!assemblyGroups[assemblyValue]) {
      assemblyGroups[assemblyValue] = {
        name: assemblyValue,
        containers: new Map(),
        orphans: [],
      };
    }

    const group = assemblyGroups[assemblyValue];
    const objKey = `${obj.modelId}:${obj.id}`;
    const containerKey = childToContainerKey.get(objKey);

    if (containerKey) {
      // Create container entry if not yet in this group
      if (!group.containers.has(containerKey)) {
        const info = containerInfoLookup.get(containerKey) || {
          key: containerKey, id: 0, modelId: obj.modelId,
          name: "Container", ifcClass: "IfcElementAssembly",
          assemblyPos: "", assemblyName: "", assemblyPosCode: "",
        };
        group.containers.set(containerKey, {
          info: info,
          children: [],
        });
      }
      group.containers.get(containerKey).children.push(obj);
    } else {
      // Object doesn't belong to any IfcElementAssembly container
      group.orphans.push(obj);
    }
  }

  return assemblyGroups;
}

// ── Render a single tree item HTML ──
function renderTreeItemHtml(obj, groupBy) {
  const uid = `${obj.modelId}:${obj.id}`;
  const isSelected = selectedIds.has(uid);
  const displayLabel = getObjectDisplayName(obj);
  const tooltip = buildTooltip(obj);
  let html = `<div class="tree-item${isSelected ? " selected" : ""}" data-uid="${escHtml(uid)}" data-model-id="${escHtml(obj.modelId)}" data-object-id="${obj.id}">`;
  html += `<input type="checkbox" class="tree-item-checkbox" ${isSelected ? "checked" : ""} />`;
  html += `<span class="tree-item-name" title="${escHtml(tooltip)}">${escHtml(displayLabel)}</span>`;

  // IFC Class badge
  const ifcClassBadge = getIfcClassBadge(obj.ifcClass);
  if (ifcClassBadge) {
    html += `<span class="tree-item-badge ifc-class" title="${escHtml(obj.ifcClass)}">${ifcClassBadge}</span>`;
  }

  // Tekla Structures badge
  if (obj.isTekla) {
    html += `<span class="tree-item-badge tekla" title="Vẽ bằng Tekla Structures">🏗️</span>`;
  }

  // Assembly badges — show which container this child belongs to
  // Only show when NOT already grouped by that field (avoid redundancy)
  if (groupBy !== "assemblyPos" && groupBy !== "assemblyPosCode" && obj.assemblyPos && obj.assemblyPos !== "(Không xác định)") {
    html += `<span class="tree-item-badge asm-pos" title="Assembly Pos: ${escHtml(obj.assemblyPos)}">${escHtml(obj.assemblyPos)}</span>`;
  }
  if (groupBy !== "assemblyPosCode" && groupBy !== "assemblyPos" && obj.assemblyPosCode && obj.assemblyPosCode !== "(Không xác định)") {
    html += `<span class="tree-item-badge asm-code" title="Assembly Code: ${escHtml(obj.assemblyPosCode)}">${escHtml(obj.assemblyPosCode)}</span>`;
  }

  // Show parent container info when available
  const containerInfo = getAssemblyContainerForObject(obj);
  if (containerInfo && groupBy !== "assemblyPos" && groupBy !== "assemblyPosCode") {
    // Show container relationship badge
    const containerLabel = containerInfo.assemblyPos || containerInfo.assemblyName || `Container ${containerInfo.id}`;
    html += `<span class="tree-item-badge asm-container" title="Parent Container: ${escHtml(containerLabel)}">🔗 ${escHtml(containerLabel.substring(0, 15))}</span>`;
  }

  // Profile badge
  if (obj.profile) {
    html += `<span class="tree-item-badge profile">${escHtml(obj.profile)}</span>`;
  } else if (obj.type) {
    html += `<span class="tree-item-badge">${escHtml(obj.type)}</span>`;
  }
  html += `</div>`;
  return html;
}

// ── Cascade Toggle: collapse/expand with inner levels ──
// When collapsing: also collapse all inner sub-levels
// When expanding: only expand the clicked level (inner levels stay as-is)
window._cascadeToggle = function(el, containerClass) {
  const container = el.closest('.' + containerClass);
  if (!container) return;
  
  const wasCollapsed = container.classList.contains('collapsed');
  container.classList.toggle('collapsed');
  
  // If we just collapsed (wasCollapsed=false → now collapsed=true),
  // also collapse all inner sub-levels
  if (!wasCollapsed) {
    container.querySelectorAll('.tree-subgroup').forEach(g => g.classList.add('collapsed'));
    container.querySelectorAll('.tree-sub2group').forEach(g => g.classList.add('collapsed'));
  }
};

// ── Tree Rendering ──
function renderTree() {
  const container = document.getElementById("object-tree");
  const groupBy = document.getElementById("group-by-select").value;

  if (filteredObjects.length === 0) {
    container.innerHTML = "";
    showPlaceholder();
    return;
  }

  // Check if assembly container grouping applies
  const useAssemblyGrouping = isAssemblyGroupingMode(groupBy);

  let html = "";

  if (useAssemblyGrouping) {
    // ══════════════════════════════════════════════════════════════════════════
    // ── Assembly container grouping ──
    // Structure:
    //   Level 1: Assembly value (name/pos/code)
    //     Level 2: IfcElementAssembly containers (📦) — grouping only
    //       Level 3: Children (actual objects)
    //     Direct children (not in IfcElementAssembly)
    // ══════════════════════════════════════════════════════════════════════════
    const assemblyGroups = buildAssemblyContainerGroupsForTree(filteredObjects, groupBy);
    const groupIcon = getAssemblyGroupIcon(groupBy);
    const sortedGroupKeys = Object.keys(assemblyGroups).sort();

    for (const groupKey of sortedGroupKeys) {
      const group = assemblyGroups[groupKey];

      // Collect ALL items in this assembly group (from containers + orphans)
      const allGroupItems = [];
      for (const [, containerEntry] of group.containers) {
        allGroupItems.push(...containerEntry.children);
      }
      allGroupItems.push(...group.orphans);

      const allGroupUids = allGroupItems.map(o => `${o.modelId}:${o.id}`);
      const allChecked = allGroupUids.length > 0 && allGroupUids.every(uid => selectedIds.has(uid));
      const someChecked = allGroupUids.some(uid => selectedIds.has(uid));

      // Calculate group weight (sum of children)
      let groupWeight = 0;
      for (const item of allGroupItems) {
        groupWeight += item.weight || 0;
      }

      // Find assembly-level weight from containers (WEIGHT_NET / CAST_UNIT_WEIGHT)
      let assemblyContainerWeight = 0;
      for (const [, containerEntry] of group.containers) {
        if (containerEntry.info && containerEntry.info.assemblyWeight > 0) {
          assemblyContainerWeight += containerEntry.info.assemblyWeight;
        }
      }

      const fmtW = (w) => w >= 1000 ? (w / 1000).toFixed(2) + " tấn" : w.toFixed(2) + " kg";
      let weightLabel = fmtW(groupWeight);
      if (assemblyContainerWeight > 0 && Math.abs(assemblyContainerWeight - groupWeight) > 0.01) {
        weightLabel += ` (Asm: ${fmtW(assemblyContainerWeight)})`;
      }

      // Level 1: Assembly value header
      html += `<div class="tree-group" data-group="${escHtml(groupKey)}">`;
      html += `<div class="tree-group-header">`;
      html += `<input type="checkbox" class="tree-group-checkbox" ${allChecked ? "checked" : ""} ${!allChecked && someChecked ? 'data-indeterminate="true"' : ""} title="Chọn/bỏ chọn nhóm" />`;
      html += `<span class="tree-toggle" onclick="_cascadeToggle(this,'tree-group')">▼</span>`;
      html += `<span class="tree-group-name" onclick="_cascadeToggle(this,'tree-group')">${groupIcon} ${escHtml(groupKey)}</span>`;
      html += `<span class="tree-group-count" onclick="_cascadeToggle(this,'tree-group')">${allGroupItems.length}</span>`;
      html += `<span class="tree-group-weight" onclick="_cascadeToggle(this,'tree-group')" title="Tổng khối lượng nhóm">⚖️ ${weightLabel}</span>`;
      html += `</div>`;
      html += `<div class="tree-items">`;

      // Level 2: IfcElementAssembly containers
      const sortedContainerKeys = Array.from(group.containers.keys()).sort((a, b) => {
        const nameA = group.containers.get(a).info.name || "";
        const nameB = group.containers.get(b).info.name || "";
        return nameA.localeCompare(nameB);
      });

      for (const containerKey of sortedContainerKeys) {
        const containerEntry = group.containers.get(containerKey);
        const containerName = containerEntry.info.name || `Container ${containerEntry.info.id}`;
        const children = containerEntry.children;

        const containerUids = children.map(o => `${o.modelId}:${o.id}`);
        const containerAllChecked = containerUids.length > 0 && containerUids.every(uid => selectedIds.has(uid));
        const containerSomeChecked = containerUids.some(uid => selectedIds.has(uid));

        html += `<div class="tree-subgroup" data-subgroup="${escHtml(containerKey)}">`;
        html += `<div class="tree-subgroup-header">`;
        html += `<input type="checkbox" class="tree-subgroup-checkbox" ${containerAllChecked ? "checked" : ""} ${!containerAllChecked && containerSomeChecked ? 'data-indeterminate="true"' : ""} title="Chọn/bỏ chọn container" />`;
        html += `<span class="tree-subgroup-toggle" onclick="_cascadeToggle(this,'tree-subgroup')">▼</span>`;
        html += `<span class="tree-subgroup-name" onclick="_cascadeToggle(this,'tree-subgroup')">📦 ${escHtml(containerName)}</span>`;
        html += `<span class="tree-subgroup-count" onclick="_cascadeToggle(this,'tree-subgroup')">${children.length}</span>`;
        // Show assembly weight from container if available
        if (containerEntry.info && containerEntry.info.assemblyWeight > 0) {
          const cw = containerEntry.info.assemblyWeight;
          const cwLabel = cw >= 1000 ? (cw / 1000).toFixed(2) + " tấn" : cw.toFixed(2) + " kg";
          html += `<span class="tree-group-weight" onclick="_cascadeToggle(this,'tree-subgroup')" title="Khối lượng assembly (WEIGHT_NET)">⚖️ ${cwLabel}</span>`;
        }
        html += `</div>`;
        html += `<div class="tree-subitems">`;

        // Level 3: Children
        for (const obj of children) {
          html += renderTreeItemHtml(obj, groupBy);
        }

        html += `</div></div>`; // close tree-subitems + tree-subgroup
      }

      // Render direct children (not in any IfcElementAssembly container)
      for (const obj of group.orphans) {
        html += renderTreeItemHtml(obj, groupBy);
      }

      html += `</div></div>`; // close tree-items + tree-group
    }
  } else {
    // ── Standard single-level grouping ──
    const groups = {};
    for (const obj of filteredObjects) {
      const key = getGroupKey(obj, groupBy) || "(Không xác định)";
      if (!groups[key]) groups[key] = [];
      groups[key].push(obj);
    }

    const sortedKeys = Object.keys(groups).sort();

    for (const key of sortedKeys) {
      const items = groups[key];
      const allGroupUids = items.map(o => `${o.modelId}:${o.id}`);
      const allChecked = allGroupUids.every(uid => selectedIds.has(uid));
      const someChecked = allGroupUids.some(uid => selectedIds.has(uid));

      html += `<div class="tree-group" data-group="${escHtml(key)}">`;
      html += `<div class="tree-group-header">`;
      html += `<input type="checkbox" class="tree-group-checkbox" ${allChecked ? "checked" : ""} ${!allChecked && someChecked ? 'data-indeterminate="true"' : ""} title="Chọn/bỏ chọn nhóm" />`;
      html += `<span class="tree-toggle" onclick="this.closest('.tree-group').classList.toggle('collapsed')">▼</span>`;
      html += `<span class="tree-group-name" onclick="this.closest('.tree-group').classList.toggle('collapsed')">${escHtml(key)}</span>`;
      html += `<span class="tree-group-count" onclick="this.closest('.tree-group').classList.toggle('collapsed')">${items.length}</span>`;
      html += `</div>`;
      html += `<div class="tree-items">`;

      for (const obj of items) {
        html += renderTreeItemHtml(obj, groupBy);
      }

      html += `</div></div>`;
    }
  }

  container.innerHTML = html;

  // Count groups for display
  const groupCount = container.querySelectorAll(".tree-group").length;
  const subGroupCount = container.querySelectorAll(".tree-subgroup").length;
  const sub2GroupCount = container.querySelectorAll(".tree-sub2group").length;
  const totalGroups = groupCount + (subGroupCount > 0 ? subGroupCount : 0) + (sub2GroupCount > 0 ? sub2GroupCount : 0);
  document.getElementById("groups-count").textContent = `${groupCount} nhóm${subGroupCount > 0 ? ` (${subGroupCount} sub` + (sub2GroupCount > 0 ? `, ${sub2GroupCount} pos` : "") + `)` : ""}`;

  // Set indeterminate state for ALL level checkboxes (can't set via HTML attribute)
  container.querySelectorAll('[data-indeterminate="true"]').forEach((cb) => {
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

      pushSelectionState(); // Save state for undo
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

  // Bind subgroup checkbox events (Level 2 — select/deselect all items in subgroup)
  const allSubgroups = Array.from(container.querySelectorAll(".tree-subgroup"));
  allSubgroups.forEach((subEl) => {
    const subCb = subEl.querySelector(".tree-subgroup-checkbox");
    if (!subCb) return;

    subCb.addEventListener("click", (e) => {
      e.stopPropagation(); // prevent toggle of parent
      const treeContainer = document.getElementById("object-tree");
      const savedScroll = treeContainer.scrollTop;

      pushSelectionState(); // Save state for undo
      const doSelect = subCb.checked;

      if (e.shiftKey && lastClickedSubgroupEl !== null) {
        const lastIndex = allSubgroups.indexOf(lastClickedSubgroupEl);
        const currentIndex = allSubgroups.indexOf(subEl);
        if (lastIndex >= 0 && currentIndex >= 0) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const shiftDoSelect = lastSubgroupClickAction === "select";
          subCb.checked = shiftDoSelect;

          for (let i = start; i <= end; i++) {
            const g = allSubgroups[i];
            const gCb = g.querySelector(".tree-subgroup-checkbox");
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
          updateGroupCheckboxStates();
          updateSummary();
          notifySelectionChanged();
          applyHighlightColors();
          syncSelectionToViewer();
          treeContainer.scrollTop = savedScroll;
          return;
        }
      }

      const items = subEl.querySelectorAll(".tree-item");
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

      subCb.indeterminate = false;
      lastClickedSubgroupEl = subEl;
      lastSubgroupClickAction = doSelect ? "select" : "deselect";
      selectionFromPanel = true;
      updateGroupCheckboxStates();
      updateSummary();
      notifySelectionChanged();
      applyHighlightColors();
      syncSelectionToViewer();
      treeContainer.scrollTop = savedScroll;
    });
  });

  // Bind sub2group checkbox events (Level 3 — select/deselect all items in sub2group)
  const allSub2groups = Array.from(container.querySelectorAll(".tree-sub2group"));
  allSub2groups.forEach((sub2El) => {
    const sub2Cb = sub2El.querySelector(".tree-sub2group-checkbox");
    if (!sub2Cb) return;

    sub2Cb.addEventListener("click", (e) => {
      e.stopPropagation(); // prevent toggle of parent
      const treeContainer = document.getElementById("object-tree");
      const savedScroll = treeContainer.scrollTop;

      pushSelectionState(); // Save state for undo
      const doSelect = sub2Cb.checked;

      if (e.shiftKey && lastClickedSub2groupEl !== null) {
        const lastIndex = allSub2groups.indexOf(lastClickedSub2groupEl);
        const currentIndex = allSub2groups.indexOf(sub2El);
        if (lastIndex >= 0 && currentIndex >= 0) {
          const start = Math.min(lastIndex, currentIndex);
          const end = Math.max(lastIndex, currentIndex);
          const shiftDoSelect = lastSub2groupClickAction === "select";
          sub2Cb.checked = shiftDoSelect;

          for (let i = start; i <= end; i++) {
            const g = allSub2groups[i];
            const gCb = g.querySelector(".tree-sub2group-checkbox");
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
          updateGroupCheckboxStates();
          updateSummary();
          notifySelectionChanged();
          applyHighlightColors();
          syncSelectionToViewer();
          treeContainer.scrollTop = savedScroll;
          return;
        }
      }

      const items = sub2El.querySelectorAll(".tree-item");
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

      sub2Cb.indeterminate = false;
      lastClickedSub2groupEl = sub2El;
      lastSub2groupClickAction = doSelect ? "select" : "deselect";
      selectionFromPanel = true;
      updateGroupCheckboxStates();
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

      pushSelectionState(); // Save state for undo
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
// Works for all levels: tree-group, tree-subgroup, tree-sub2group
function updateGroupCheckboxStates() {
  // Update Level 3 (sub2group) first — bottom up
  document.querySelectorAll(".tree-sub2group").forEach((el) => {
    const cb = el.querySelector(".tree-sub2group-checkbox");
    if (!cb) return;
    const items = el.querySelectorAll(".tree-item");
    const total = items.length;
    let checked = 0;
    items.forEach((item) => {
      if (selectedIds.has(item.dataset.uid)) checked++;
    });
    cb.checked = checked === total;
    cb.indeterminate = checked > 0 && checked < total;
  });

  // Update Level 2 (subgroup)
  document.querySelectorAll(".tree-subgroup").forEach((el) => {
    const cb = el.querySelector(".tree-subgroup-checkbox");
    if (!cb) return;
    const items = el.querySelectorAll(".tree-item");
    const total = items.length;
    let checked = 0;
    items.forEach((item) => {
      if (selectedIds.has(item.dataset.uid)) checked++;
    });
    cb.checked = checked === total;
    cb.indeterminate = checked > 0 && checked < total;
  });

  // Update Level 1 (group) — top level
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

  pushSelectionState(); // Save state for undo

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






// ── Collapse / Expand All Groups ──
function collapseAll() {
  // Collapse ALL levels: group, subgroup, sub2group
  document.querySelectorAll(".tree-group").forEach((g) => g.classList.add("collapsed"));
  document.querySelectorAll(".tree-subgroup").forEach((g) => g.classList.add("collapsed"));
  document.querySelectorAll(".tree-sub2group").forEach((g) => g.classList.add("collapsed"));
  // Browser may clamp scrollTop to the new max position (often the bottom).
  // Force reset to top immediately after reflow.
  shouldScrollToTop = true;
  requestAnimationFrame(() => {
    const treeContainer = document.getElementById("object-tree");
    if (treeContainer) treeContainer.scrollTop = 0;
    shouldScrollToTop = false;
  });
  console.log("[ObjectExplorer] Collapse all triggered (all levels), will scroll to top");
}

function expandAll() {
  // Expand ALL levels: group, subgroup, sub2group
  document.querySelectorAll(".tree-group").forEach((g) => g.classList.remove("collapsed"));
  document.querySelectorAll(".tree-subgroup").forEach((g) => g.classList.remove("collapsed"));
  document.querySelectorAll(".tree-sub2group").forEach((g) => g.classList.remove("collapsed"));
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
// Build an expanded model map that includes BOTH selected objects
// AND their parent IfcElementAssembly containers (for assembly selection).
// When any child of an assembly is selected, ALL siblings in the same
// assembly are also included — giving full "assembly selection" isolation.
function buildModelMapWithAssemblyContainers() {
  const map = {};

  // Helper to add an ID to the map
  function addToMap(modelId, objectId) {
    if (!map[modelId]) map[modelId] = new Set();
    if (!isNaN(objectId)) map[modelId].add(objectId);
  }

  // Collect all assembly container keys that have at least one selected child
  const touchedAssemblyKeys = new Set();

  // Step 1: Add all selected child object IDs + detect touched assemblies
  for (const uid of selectedIds) {
    const idx = uid.indexOf(":");
    const modelId = uid.substring(0, idx);
    const objectId = parseInt(uid.substring(idx + 1));
    addToMap(modelId, objectId);

    // If this child belongs to an assembly, mark the assembly as touched
    const assemblyKey = assemblyMembershipMap.get(uid);
    if (assemblyKey) {
      touchedAssemblyKeys.add(assemblyKey);
    }
  }

  // Step 2: For each touched assembly, add the container ID + ALL child IDs
  for (const assemblyKey of touchedAssemblyKeys) {
    const asmIdx = assemblyKey.indexOf(":");
    const asmModelId = assemblyKey.substring(0, asmIdx);
    const asmObjectId = parseInt(assemblyKey.substring(asmIdx + 1));

    // Add the assembly container itself
    addToMap(asmModelId, asmObjectId);

    // Add ALL children of this assembly (siblings of the selected child)
    const childIds = assemblyChildrenMap.get(assemblyKey);
    if (childIds) {
      for (const childId of childIds) {
        addToMap(asmModelId, childId);
      }
    }
  }

  // Step 3: Property-based assembly matching
  // For selected objects that have assemblyPos/assemblyName but are NOT in
  // assemblyMembershipMap, find other objects in the SAME assembly by
  // matching property values, and include their assembly containers.
  const selectedAssemblyPosValues = new Set();
  const selectedAssemblyNameValues = new Set();

  // Build lookup map for O(1) access
  const objLookup = new Map();
  for (const obj of allObjects) {
    objLookup.set(`${obj.modelId}:${obj.id}`, obj);
  }

  for (const uid of selectedIds) {
    const obj = objLookup.get(uid);
    if (!obj) continue;

    // Collect assembly values from ALL selected objects (not just unmapped ones)
    // This ensures we match assembly siblings even when some are mapped and some aren't
    if (obj.assemblyPos && obj.assemblyPos !== "(Không xác định)") {
      selectedAssemblyPosValues.add(obj.assemblyPos);
    }
    if (obj.assemblyName && obj.assemblyName !== "(Không xác định)") {
      selectedAssemblyNameValues.add(obj.assemblyName);
    }
  }


  // For each unmatched assembly value, find ALL other objects with the same value
  // AND find matching assembly containers from assemblyNodeInfoMap
  if (selectedAssemblyPosValues.size > 0 || selectedAssemblyNameValues.size > 0) {
    // Add matching objects from allObjects
    for (const obj of allObjects) {
      const uid = `${obj.modelId}:${obj.id}`;
      if (selectedIds.has(uid)) continue; // already added

      const posMatch = obj.assemblyPos && selectedAssemblyPosValues.has(obj.assemblyPos);
      const nameMatch = obj.assemblyName && selectedAssemblyNameValues.has(obj.assemblyName);

      if (posMatch || nameMatch) {
        addToMap(obj.modelId, obj.id);

        // Also include the assembly container for this matched object
        const asmKey = assemblyMembershipMap.get(uid);
        if (asmKey) {
          touchedAssemblyKeys.add(asmKey);
          const asmIdx2 = asmKey.indexOf(":");
          addToMap(asmKey.substring(0, asmIdx2), parseInt(asmKey.substring(asmIdx2 + 1)));
        }
      }
    }

    // Add matching assembly containers from assemblyNodeInfoMap
    for (const [containerKey, nodeInfo] of assemblyNodeInfoMap) {
      const posMatch = nodeInfo.assemblyPos && selectedAssemblyPosValues.has(nodeInfo.assemblyPos);
      const nameMatch = nodeInfo.assemblyName && selectedAssemblyNameValues.has(nodeInfo.assemblyName);

      if (posMatch || nameMatch) {
        addToMap(nodeInfo.modelId, nodeInfo.id);
        touchedAssemblyKeys.add(containerKey);

        // Also add ALL children of this matching container
        const childIds = assemblyChildrenMap.get(containerKey);
        if (childIds) {
          for (const childId of childIds) {
            addToMap(nodeInfo.modelId, childId);
          }
        }
      }
    }
  }

  // Step 4: Reverse lookup — check ALL assembly containers to see if any
  // of their children are selected (catches cases missed by Step 1)
  for (const [containerKey, childIds] of assemblyChildrenMap) {
    if (touchedAssemblyKeys.has(containerKey)) continue; // already processed

    let hasSelectedChild = false;
    const nodeInfo = assemblyNodeInfoMap.get(containerKey);
    const containerModelId = nodeInfo ? nodeInfo.modelId : "";

    for (const childId of childIds) {
      const childUid = `${containerModelId}:${childId}`;
      if (selectedIds.has(childUid)) {
        hasSelectedChild = true;
        break;
      }
    }

    if (hasSelectedChild && containerModelId) {
      // Add the container itself
      const containerIdx = containerKey.indexOf(":");
      const containerId = parseInt(containerKey.substring(containerIdx + 1));
      addToMap(containerModelId, containerId);

      // Add ALL children of this container
      for (const childId of childIds) {
        addToMap(containerModelId, childId);
      }
    }
  }

  // Step 5: Include saved assembly containers that match by assembly properties
  // These IfcElementAssembly entities were removed from allObjects but their
  // entity IDs are still valid in the viewer — needed for isolate to work correctly
  for (const container of savedAssemblyContainers) {
    const containerUid = `${container.modelId}:${container.id}`;

    // Check if any selected object belongs to this container
    const containerChildIds = assemblyChildrenMap.get(containerUid);
    if (containerChildIds) {
      for (const childId of containerChildIds) {
        if (selectedIds.has(`${container.modelId}:${childId}`)) {
          addToMap(container.modelId, container.id);
          break;
        }
      }
    }

    // Also check by matching assemblyPos/assemblyName
    if (container.assemblyPos && selectedAssemblyPosValues.has(container.assemblyPos)) {
      addToMap(container.modelId, container.id);
    }
    if (container.assemblyName && selectedAssemblyNameValues.has(container.assemblyName)) {
      addToMap(container.modelId, container.id);
    }
  }

  // Step 6: Convert Sets to Arrays for API compatibility
  const result = {};
  for (const [modelId, idSet] of Object.entries(map)) {
    result[modelId] = Array.from(idSet);
  }

  console.log(`[ObjectExplorer] buildModelMapWithAssemblyContainers: ${selectedIds.size} selected → ${Object.values(result).reduce((s, a) => s + a.length, 0)} total IDs (${touchedAssemblyKeys.size} assembly containers touched)`);

  return result;
}

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

  // Use expanded model map that includes assembly containers + all assembly siblings
  const modelMap = buildModelMapWithAssemblyContainers();
  const totalIds = Object.values(modelMap).reduce((sum, ids) => sum + ids.length, 0);

  if (totalIds === 0) {
    console.warn("[ObjectExplorer] No valid entity IDs to isolate");
    return;
  }

  const modelEntities = Object.entries(modelMap).map(([modelId, ids]) => ({
    modelId,
    entityIds: ids,
  }));

  console.log(`[ObjectExplorer] Attempting isolate: ${selectedIds.size} selected → ${totalIds} total entities across ${modelEntities.length} model(s)`);

  try {
    // Primary: isolateEntities uses IModelEntities[] with { modelId, entityIds }
    await viewerRef.isolateEntities(modelEntities);
    isolateActive = true;
    btn.classList.add("active");
    console.log(`[ObjectExplorer] ✓ Isolated successfully: ${totalIds} entities (${selectedIds.size} selected + ${totalIds - selectedIds.size} assembly-related)`);
  } catch (e) {
    console.warn("[ObjectExplorer] isolateEntities failed, trying fallback 1 (setObjectState):", e);

    // Fallback 1: hide all, then show selected + assembly containers using objectRuntimeIds
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
      console.log(`[ObjectExplorer] ✓ Fallback 1 isolate succeeded: ${totalIds} entities`);
    } catch (e2) {
      console.warn("[ObjectExplorer] Fallback 1 failed, trying fallback 2 (entityIds):", e2);

      // Fallback 2: try using entityIds format for setObjectState
      try {
        await viewerRef.setObjectState(undefined, { visible: false });
        await viewerRef.setObjectState(
          { modelObjectIds: modelEntities },
          { visible: true },
        );
        isolateActive = true;
        btn.classList.add("active");
        console.log(`[ObjectExplorer] ✓ Fallback 2 isolate succeeded: ${totalIds} entities`);
      } catch (e3) {
        console.error("[ObjectExplorer] All isolate methods failed:", e3);
      }
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

  // Assembly container info — show which assembly this child belongs to
  if (obj.assemblyName) parts.push(`🏗️ ASSEMBLY_NAME: ${obj.assemblyName}`);
  if (obj.assemblyPos) {
    parts.push(`📍 ASSEMBLY_POS: ${obj.assemblyPos}`);
  }
  if (obj.assemblyPosCode) {
    parts.push(`🔖 ASSEMBLY_CODE: ${obj.assemblyPosCode}`);
  }

  // Assembly group stats (simplified - no O(n²) filter)
  if (obj.assemblyPos) {
    parts.push(`[🏗️ Nhóm: ${obj.assemblyPos}]`);
  }

  if (obj.material) parts.push(`Vật liệu: ${obj.material}`);
  
  // Physical properties — same format as Statistics tab
  if (obj.volume > 0) parts.push(`V: ${obj.volume.toFixed(6)} m³`);
  if (obj.area > 0) parts.push(`A: ${obj.area.toFixed(4)} m²`);
  if (obj.weight > 0) {
    let weightStr = `W: ${obj.weight >= 1000 ? (obj.weight / 1000).toFixed(2) + " tấn" : obj.weight.toFixed(2) + " kg"}`;
    if (obj.weightSource === "ifc") {
      weightStr += ` (từ IFC)`;
    }
    parts.push(weightStr);
  }
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
    pushSelectionState(); // Save state for undo
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
          // Auto-expand ALL parent containers if collapsed (so the element can be scrolled to).
          let didExpand = false;
          const parentGroup = targetEl.closest(".tree-group");
          if (parentGroup && parentGroup.classList.contains("collapsed")) {
            parentGroup.classList.remove("collapsed");
            didExpand = true;
          }
          const parentSubgroup = targetEl.closest(".tree-subgroup");
          if (parentSubgroup && parentSubgroup.classList.contains("collapsed")) {
            parentSubgroup.classList.remove("collapsed");
            didExpand = true;
          }
          const parentSub2group = targetEl.closest(".tree-sub2group");
          if (parentSub2group && parentSub2group.classList.contains("collapsed")) {
            parentSub2group.classList.remove("collapsed");
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

// ── Reset ──
async function resetAll() {
  selectedIds.clear();
  isolateActive = false;
  lastClickedItem = null;
  lastClickedGroupEl = null;
  lastClickedSubgroupEl = null;
  lastClickedSub2groupEl = null;

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
  // Calculate total project stats from ALL filtered objects
  let projectVolume = 0, projectWeight = 0, projectArea = 0;
  for (const obj of filteredObjects) {
    projectVolume += obj.volume || 0;
    projectWeight += obj.weight || 0;
    projectArea += obj.area || 0;
  }

  // Format functions — same as steelStatistics.js
  const fmtVol = (v) => v.toFixed(6) + " m³";
  const fmtArea = (a) => a.toFixed(4) + " m²";
  const fmtWeight = (w) => w >= 1000 ? (w / 1000).toFixed(2) + " tấn" : w.toFixed(2) + " kg";
  // Display total objects count + project totals
  document.getElementById("total-objects-count").textContent =
    `${filteredObjects.length} objects | V: ${fmtVol(projectVolume)} | W: ${fmtWeight(projectWeight)} | A: ${fmtArea(projectArea)}`;

  document.getElementById("selected-objects-count").textContent =
    `${selectedIds.size} đã chọn`;

  // Calculate and display stats for selected objects
  const selStatsEl = document.getElementById("selected-stats");
  const statsDivider = document.getElementById("stats-divider");

  if (selectedIds.size > 0) {
    let totalVolume = 0, totalWeight = 0, totalArea = 0;
    let matchCount = 0;
    for (const obj of allObjects) {
      const uid = `${obj.modelId}:${obj.id}`;
      if (selectedIds.has(uid)) {
        totalVolume += obj.volume || 0;
        totalWeight += obj.weight || 0;
        totalArea += obj.area || 0;
        matchCount++;
      }
    }

    const statsText = `V: ${fmtVol(totalVolume)} | W: ${fmtWeight(totalWeight)} | A: ${fmtArea(totalArea)}`;

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
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Notify statistics module of selection change ──
function notifySelectionChanged() {

  window.dispatchEvent(
    new CustomEvent("selection-changed", {
      detail: { selectedIds: Array.from(selectedIds), count: selectedIds.size },
    }),
  );
}
