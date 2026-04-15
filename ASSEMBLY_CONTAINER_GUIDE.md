# Assembly Container Identification & Filtering Guide

## Overview

This document describes the enhanced assembly container identification system that allows you to:
1. **Identify which assembly container a child object belongs to**
2. **Group children by their assembly containers** (ASSEMBLY_NAME, ASSEMBLY_POS, ASSEMBLY_POSITION_CODE)
3. **Recognize IfcElementAssembly hierarchy** for proper containment relationships
4. **Trace children to their parent assembly containers**

## Core Concepts

### Assembly Hierarchy in IFC

In IFC models exported from Tekla Structures, assemblies are organized using **IfcElementAssembly** containers:

```
IfcElementAssembly (Container)
├── name: "BEAM-1"
├── ASSEMBLY_POS: "B1"
├── ASSEMBLY_NAME: "Main Beam"
├── ASSEMBLY_POSITION_CODE: "01"
└── Children (members):
    ├── IfcBeam (member)
    ├── IfcPlate (member)
    └── IfcMechanicalFastener (bolt)
```

### Three Levels of Assembly Identification

1. **Container Level**: IfcElementAssembly node (direct parent)
2. **Tekla Properties Level**: Assembly properties (POS, NAME, CODE)
3. **Inheritance Level**: Properties inherited from parent to children

## API Functions

### 1. Get Assembly Container for Object

```javascript
// Get parent IfcElementAssembly container info for a child
const container = getAssemblyContainerForObject(obj);
// Returns:
// {
//   id: number,
//   modelId: string,
//   name: string,
//   ifcClass: "IfcElementAssembly",
//   assemblyPos: string,
//   assemblyName: string,
//   assemblyPosCode: string
// }
```

### 2. Get Enhanced Assembly Information

```javascript
// Get comprehensive assembly hierarchy info
const enhanced = getEnhancedAssemblyInfo(obj);
// Returns:
// {
//   containerType: "IfcElementAssembly" | "inherited" | "none",
//   directParentId: number,
//   directParentKey: string,
//   parentInfo: {...},
//   assemblyChain: [{level, name, assemblyPos, ...}],
//   siblingCount: number,
//   hierarchicalPath: string
// }
```

### 3. Build Assembly Hierarchy Analysis

```javascript
// Get comprehensive statistical analysis
const analysis = buildAssemblyHierarchyAnalysis();
// Returns:
// {
//   totalObjects: number,
//   summary: {
//     totalContainers: number,
//     objectsInContainers: number,
//     objectsWithInheritedAssembly: number,
//     objectsWithoutAssembly: number
//   },
//   containers: [...],
//   byAssemblyPos: {...},
//   byAssemblyName: {...},
//   byAssemblyCode: {...}
// }
```

### 4. Get Objects by Assembly Value

```javascript
// Get all children with specific ASSEMBLY_POS, NAME, or CODE
const children = getObjectsByAssemblyValue("pos", "B1");
// Returns array of objects with matching assembly value

// Also works with:
getObjectsByAssemblyValue("name", "Main Beam");
getObjectsByAssemblyValue("code", "01");
```

### 5. Get Unique Assembly Values

```javascript
// Get all unique ASSEMBLY_POS values for filtering
const posValues = getUniqueAssemblyValues("pos");
// ["B1", "B2", "B3", ...]

// Also works with:
getUniqueAssemblyValues("name");
getUniqueAssemblyValues("code");
```

### 6. Trace Object to Assembly Container

```javascript
// Complete trace from child to assembly container
const trace = traceObjectToAssemblyContainer(obj);
// Returns:
// {
//   object: {id, modelId, name, ifcClass},
//   assemblyProperties: {assemblyPos, assemblyName, assemblyPosCode},
//   ifcElementAssemblyParent: {...},
//   groupedWith: [...],  // siblings
//   relatedByPos: [...],  // other objects with same POS
//   relatedByName: [...], // other objects with same NAME
//   relatedByCode: [...]  // other objects with same CODE
// }
```

## Debug Functions (Console)

Use these functions in the browser console to analyze assembly relationships:

### 1. Show Enhanced Assembly Info for Selected Object

```javascript
window._debugEnhancedAssemblyInfo()
```

**Output**: Shows complete assembly hierarchy chain for selected object(s)

### 2. Trace Object to Assembly Container

```javascript
window._debugTraceToContainer()
```

**Output**: Shows path from selected object to its assembly container

### 3. Show Complete Assembly Hierarchy Analysis

```javascript
window._debugAssemblyAnalysis()
```

**Output**: Statistical analysis of all containers, groupings, and relationships

### 4. Get Children by Assembly Value

```javascript
window._debugGetAssemblyChildren("pos", "B1")
// or
window._debugGetAssemblyChildren("name", "Main Beam")
// or
window._debugGetAssemblyChildren("code", "01")
```

**Output**: List all objects with matching assembly value

### 5. List Unique Assembly Values

```javascript
window._debugListAssemblyValues("pos")
// or
window._debugListAssemblyValues("name")
// or
window._debugListAssemblyValues("code")
```

**Output**: All unique values for given field

### Existing Debug Functions

```javascript
// Show all IfcElementAssembly containers
window._debugAllContainers()

// Show children of specific container
window._debugContainerChildren(modelId, containerId)

// Show assembly statistics
window._debugAssemblyContainers()

// Show selected objects' assembly relationship
window._debugAssemblyContainers()
```

## Practical Examples

### Example 1: Select a Beam, Find Its Assembly Container

```javascript
// 1. User clicks on a beam in the 3D view
// 2. Run in console:
window._debugTraceToContainer()

// Output shows:
// - The beam's ASSEMBLY_POS (e.g., "B1")
// - Parent IfcElementAssembly container info
// - All siblings in same container
// - Total weight/volume of container
```

### Example 2: Get All Objects in Assembly "B1"

```javascript
// Get all objects with ASSEMBLY_POS = "B1"
const b1Objects = getObjectsByAssemblyValue("pos", "B1");

// Select them all
b1Objects.forEach(obj => {
  selectedIds.add(`${obj.modelId}:${obj.id}`);
});

// Visualize them in 3D
// (implementation depends on your UI)
```

### Example 3: Build Filter Options for Assembly Selection

```javascript
// Get all unique ASSEMBLY_POS values for dropdown
const positions = getUniqueAssemblyValues("pos");

// Build HTML select
const select = document.createElement("select");
positions.forEach(pos => {
  const option = document.createElement("option");
  option.textContent = pos;
  option.value = pos;
  select.appendChild(option);
});

// When user selects "B1":
select.addEventListener("change", (e) => {
  const selected = getObjectsByAssemblyValue("pos", e.target.value);
  // Update UI to show these objects
});
```

## Assembly Container Relationships

### Direct Parent (IfcElementAssembly)

```
Child Object
└── assemblyMembershipMap["modelId:objectId"]
    └── assemblyNodeInfoMap["modelId:containerId"]
        └── Parent Container Info (POS, NAME, CODE)
```

When `getAssemblyContainerForObject(child)` is called:
1. Look up child in `assemblyMembershipMap` → get container key
2. Look up container key in `assemblyNodeInfoMap` → get container properties
3. Return container info with ASSEMBLY_POS, NAME, CODE

### Inherited Properties

```
Child Object
├── assemblyPos: (inherited from parent or Tekla properties)
├── assemblyName: (inherited from parent)
└── assemblyPosCode: (inherited from parent)
```

If child is not a direct member of IfcElementAssembly:
- Properties are inherited from parent Tekla assembly properties
- Use `traceObjectToAssemblyContainer()` to understand the relationship

## IfcElementAssembly Recognition

### Identifying IfcElementAssembly Containers

```javascript
// In the object explorer, IfcElementAssembly nodes are:
const isContainer = obj.ifcClass === "IfcElementAssembly" || 
                    obj.ifcClass.includes("ElementAssembly");

// They can be identified by:
// - Direct presence in assemblyChildrenMap
// - Having multiple children
// - assemblyNodeInfoMap entries
```

### Assembly Container Properties

```javascript
// Each IfcElementAssembly has:
{
  id: number,              // IFC object ID
  name: string,            // IFC entity name (e.g., "BEAM-1")
  ifcClass: "IfcElementAssembly",
  
  // Tekla assembly properties (enriched from container):
  assemblyPos: string,     // Position number (e.g., "B1")
  assemblyName: string,    // Assembly name (e.g., "Main Beam")
  assemblyPosCode: string, // Position code (e.g., "01")
  
  // Relationship info:
  isAssemblyParent: true,
  children: [...]          // Child object IDs
}
```

## Filtering Implementation

### Filter by Assembly Container

When building assembly-based filters in UI:

```javascript
// 1. Get all unique ASSEMBLY_POS values
const positions = getUniqueAssemblyValues("pos");

// 2. Create filter group
{
  groupName: "ASSEMBLY_POS",
  values: positions, // ["B1", "B2", "B3", ...]
  filterFunction: (obj, value) => obj.assemblyPos === value
}

// 3. Apply filter
const filtered = allObjects.filter(obj => 
  obj.assemblyPos === selectedPosition
);
```

### Filter by Assembly Name

```javascript
// Similar to POS, but using ASSEMBLY_NAME
const names = getUniqueAssemblyValues("name");

{
  groupName: "ASSEMBLY_NAME",
  values: names,
  filterFunction: (obj, value) => obj.assemblyName === value
}
```

### Filter by Assembly Code

```javascript
// Similar to NAME, but using ASSEMBLY_POSITION_CODE
const codes = getUniqueAssemblyValues("code");

{
  groupName: "ASSEMBLY_POSITION_CODE",
  values: codes,
  filterFunction: (obj, value) => obj.assemblyPosCode === value
}
```

## Statistical Information

### Assembly Detection Statistics

```javascript
const stats = getAssemblyStatistics();
// Returns:
// {
//   totalObjects: 1500,
//   objectsWithAssemblyPos: 1200,
//   objectsWithAssemblyName: 1100,
//   objectsWithAssemblyCode: 950,
//   totalAssemblyContainers: 45,
//   totalAssemblyMemberships: 1200
// }
```

### Container Statistics

```javascript
const analysis = buildAssemblyHierarchyAnalysis();
analysis.containers.forEach(container => {
  console.log(`
    Container: ${container.name}
    Children: ${container.childCount}
    Total Weight: ${container.totalWeight}kg
    Total Volume: ${container.totalVolume}m³
  `);
});
```

## Troubleshooting

### No Assembly Information Found

If `getAssemblyContainers()` returns empty:
1. Check IFC file was exported from Tekla with assembly properties
2. Verify Additional Property Sets include ASSEMBLY_POS, ASSEMBLY_NAME
3. Run `window._debugAssemblyAnalysis()` to check statistics

### Objects Not Grouped Into Containers

If `assemblyMembershipMap` is empty:
1. Run `window._debugAllContainers()` to list containers
2. Check if model has IfcElementAssembly elements
3. Verify hierarchy was built with correct HierarchyType.ElementAssembly

### Partial Assembly Property Coverage

If some children don't have ASSEMBLY_POS:
1. They may be in "(Không xác định)" group
2. Run `window._debugEnhancedAssemblyInfo()` to check container type
3. Verify enrichment from hierarchy worked correctly

## API Reference Summary

| Function | Purpose | Returns |
|----------|---------|---------|
| `getAssemblyContainerForObject(obj)` | Get parent container | Container info or null |
| `getAssemblyChildren(modelId, containerId)` | Get children of container | Array of child objects |
| `getAssemblyContainers()` | Get all containers | Array of container info |
| `getAssemblyStatistics()` | Get detection statistics | Statistics object |
| `getObjectAssemblyStatus(obj)` | Check object's assembly info | "pos"\|"name"\|"code"\|"all"\|"none" |
| `getEnhancedAssemblyInfo(obj)` | Get complete hierarchy info | Enhanced info object |
| `buildAssemblyHierarchyAnalysis()` | Get full analysis | Analysis object |
| `getObjectsByAssemblyValue(field, value)` | Find objects by value | Array of matching objects |
| `getUniqueAssemblyValues(field)` | Get unique values | Array of unique values |
| `traceObjectToAssemblyContainer(obj)` | Complete trace | Trace object |
| `logObjectAssemblyRelationship(obj)` | Log relationship (console) | - |

## Notes

- All functions work with both direct IfcElementAssembly membership and inherited properties
- Assembly values are case-sensitive
- "(Không xác định)" means "Not Determined" in Vietnamese - indicates missing data
- Use `modelId:objectId` format for unique object identification
- Assembly container information is cached - call `scanObjects()` to refresh
