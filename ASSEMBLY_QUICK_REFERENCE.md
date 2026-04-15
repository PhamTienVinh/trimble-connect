# Assembly Container API - Quick Reference

## Core Functions

### `getAssemblyContainerForObject(obj)`
**Get parent IfcElementAssembly container**
```javascript
const container = getAssemblyContainerForObject(beam);
// { id, modelId, name, ifcClass, assemblyPos, assemblyName, assemblyPosCode }
```

### `getEnhancedAssemblyInfo(obj)`
**Get complete assembly hierarchy information**
```javascript
const enhanced = getEnhancedAssemblyInfo(beam);
// { containerType, directParentId, parentInfo, assemblyChain, hierarchicalPath }
```

### `buildAssemblyHierarchyAnalysis()`
**Analyze entire assembly hierarchy**
```javascript
const analysis = buildAssemblyHierarchyAnalysis();
// { totalObjects, summary, containers, byAssemblyPos, byAssemblyName, byAssemblyCode }
```

### `getObjectsByAssemblyValue(field, value)`
**Find all objects with specific assembly value**
```javascript
// Get all beams in assembly "B1"
const beams = getObjectsByAssemblyValue("pos", "B1");

// Other fields:
getObjectsByAssemblyValue("name", "Main Beam");
getObjectsByAssemblyValue("code", "01");
```

### `getUniqueAssemblyValues(field)`
**Get sorted list of unique assembly values (for filters)**
```javascript
const positions = getUniqueAssemblyValues("pos");
// ["B1", "B2", "B3", ...]

// Other fields:
getUniqueAssemblyValues("name");
getUniqueAssemblyValues("code");
```

### `getAssemblyChildren(modelId, containerId)`
**Get all children of a container**
```javascript
const children = getAssemblyChildren("model-001", 12345);
// [beam1, beam2, plate1, bolt1, ...]
```

### `getAssemblyContainers()`
**Get all IfcElementAssembly containers**
```javascript
const containers = getAssemblyContainers();
// [{id, name, assemblyPos, assemblyName, assemblyPosCode, childCount}, ...]
```

### `traceObjectToAssemblyContainer(obj)`
**Trace object to its assembly container**
```javascript
const trace = traceObjectToAssemblyContainer(beam);
// {
//   object: {id, name, ifcClass},
//   assemblyProperties: {assemblyPos, assemblyName, assemblyPosCode},
//   ifcElementAssemblyParent: {...},
//   groupedWith: [...],    // siblings
//   relatedByPos: [...],   // other objects with same POS
//   relatedByName: [...],  // other objects with same NAME
//   relatedByCode: [...]   // other objects with same CODE
// }
```

## Debug Functions (Console)

### `window._debugTraceToContainer()`
Show trace for selected object(s)
```javascript
// 1. Select object in 3D
// 2. Run in console:
window._debugTraceToContainer()
```

### `window._debugEnhancedAssemblyInfo()`
Show enhanced assembly info for selected object(s)
```javascript
window._debugEnhancedAssemblyInfo()
```

### `window._debugAssemblyAnalysis()`
Show complete assembly hierarchy analysis
```javascript
window._debugAssemblyAnalysis()
```

### `window._debugGetAssemblyChildren(field, value)`
List all objects with specific assembly value
```javascript
window._debugGetAssemblyChildren("pos", "B1")
window._debugGetAssemblyChildren("name", "Main Beam")
window._debugGetAssemblyChildren("code", "01")
```

### `window._debugListAssemblyValues(field)`
List all unique assembly values
```javascript
window._debugListAssemblyValues("pos")
window._debugListAssemblyValues("name")
window._debugListAssemblyValues("code")
```

### Existing Debug Functions
```javascript
window._debugAllContainers()           // Show all containers
window._debugContainerChildren(modelId, id)  // Show container children
window._debugAssemblyContainers()      // Show container statistics
```

## Common Patterns

### Pattern 1: Filter Objects by Assembly POS

```javascript
// Get all unique positions
const positions = getUniqueAssemblyValues("pos");

// Build dropdown
positions.forEach(pos => {
  const option = document.createElement("option");
  option.value = pos;
  option.textContent = pos;
  select.appendChild(option);
});

// On selection
select.addEventListener("change", (e) => {
  const filtered = getObjectsByAssemblyValue("pos", e.target.value);
  // Update UI...
});
```

### Pattern 2: Select All in Container

```javascript
// Get first selected object
const uid = selectedIds.values().next().value;
const obj = allObjects.find(o => `${o.modelId}:${o.id}` === uid);

// Get container
const container = getAssemblyContainerForObject(obj);
if (container) {
  // Get all children
  const children = getAssemblyChildren(obj.modelId, container.id);
  
  // Select all
  selectedIds.clear();
  children.forEach(child => {
    selectedIds.add(`${obj.modelId}:${child.id}`);
  });
}
```

### Pattern 3: Get Assembly Statistics

```javascript
const stats = getAssemblyStatistics();
console.log(`
  Total objects: ${stats.totalObjects}
  With POS: ${stats.objectsWithAssemblyPos}
  With NAME: ${stats.objectsWithAssemblyName}
  With CODE: ${stats.objectsWithAssemblyCode}
  Containers: ${stats.totalAssemblyContainers}
`);
```

### Pattern 4: Analyze Assembly Hierarchy

```javascript
const analysis = buildAssemblyHierarchyAnalysis();

analysis.containers.forEach(container => {
  console.log(`
    ${container.name}
    POS: ${container.assemblyPos}
    Children: ${container.childCount}
    Weight: ${container.totalWeight}kg
  `);
});
```

## Data Return Types

### Container Info Object
```javascript
{
  id: number,
  modelId: string,
  name: string,
  ifcClass: string,
  assemblyPos: string,
  assemblyName: string,
  assemblyPosCode: string,
  childCount: number
}
```

### Enhanced Assembly Info Object
```javascript
{
  containerType: "IfcElementAssembly" | "inherited" | "none",
  directParentId: number,
  directParentKey: string,
  parentInfo: ContainerInfo,
  assemblyChain: Array,
  siblingCount: number,
  hierarchicalPath: string
}
```

### Analysis Object
```javascript
{
  timestamp: string,
  totalObjects: number,
  summary: {
    totalContainers: number,
    objectsInContainers: number,
    objectsWithInheritedAssembly: number,
    objectsWithoutAssembly: number
  },
  containers: Array<Container>,
  byAssemblyPos: { [pos: string]: Group },
  byAssemblyName: { [name: string]: Group },
  byAssemblyCode: { [code: string]: Group }
}
```

### Trace Object
```javascript
{
  object: { id, modelId, name, ifcClass },
  assemblyProperties: { assemblyPos, assemblyName, assemblyPosCode },
  ifcElementAssemblyParent: ContainerInfo | null,
  groupedWith: Array,
  relatedByPos: Array,
  relatedByName: Array,
  relatedByCode: Array
}
```

## Quick Tests

```javascript
// Test 1: Check if model has assemblies
getAssemblyContainers().length > 0

// Test 2: Get all assembly values
getUniqueAssemblyValues("pos").length

// Test 3: Find objects in container
getObjectsByAssemblyValue("pos", "B1").length

// Test 4: Get complete analysis
const a = buildAssemblyHierarchyAnalysis();
a.summary.totalContainers

// Test 5: Trace selected object
selectedIds.size > 0 ? window._debugTraceToContainer() : null
```

## Performance Notes

- `buildAssemblyHierarchyAnalysis()`: ~100ms for 1000+ objects
- `getObjectsByAssemblyValue()`: O(n) where n = total objects
- `getUniqueAssemblyValues()`: O(n) but result is cached
- All other functions: O(1) or O(k) where k = container size

## Export Functions

All functions are exported from `objectExplorer.js`:

```javascript
import {
  getAssemblyContainerForObject,
  getEnhancedAssemblyInfo,
  buildAssemblyHierarchyAnalysis,
  getObjectsByAssemblyValue,
  getUniqueAssemblyValues,
  getAssemblyChildren,
  getAssemblyContainers,
  getAssemblyStatistics,
  getObjectAssemblyStatus,
  traceObjectToAssemblyContainer,
  logObjectAssemblyRelationship
} from "./objectExplorer.js";
```

## Integration Checklist

- [ ] Import functions in your module
- [ ] Populate filter dropdowns with `getUniqueAssemblyValues()`
- [ ] Handle filter changes with `getObjectsByAssemblyValue()`
- [ ] Show container info with `getAssemblyContainerForObject()`
- [ ] Display hierarchy with `buildAssemblyHierarchyAnalysis()`
- [ ] Test with debug functions in console
- [ ] Optimize caching for large models
- [ ] Error handling for null/undefined

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No containers found | Check `getAssemblyContainers().length` or run `window._debugAssemblyAnalysis()` |
| Objects not grouped | Verify IFC has IfcElementAssembly, run `window._debugAllContainers()` |
| Missing POS values | Check Tekla export settings, run `window._debugListAssemblyValues("pos")` |
| Null container | Object may not be in IfcElementAssembly, check `getEnhancedAssemblyInfo()` |
| Performance slow | Cache analysis result, avoid repeated `buildAssemblyHierarchyAnalysis()` calls |

## See Also

- **ASSEMBLY_CONTAINER_GUIDE.md** - Complete API documentation
- **ASSEMBLY_FILTERING_EXAMPLES.md** - Implementation examples
- **ASSEMBLY_IMPLEMENTATION_SUMMARY.md** - Architecture overview
