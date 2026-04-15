# Assembly Container Filtering - Implementation Examples

## Quick Start: Using Assembly Container Information

This guide shows practical code examples for implementing assembly container filtering in your UI.

## 1. Display Assembly Container Information for Selected Object

### Console Command

```javascript
// Select a beam/plate/bolt in 3D view, then run:
window._debugTraceToContainer()
```

**Output Example**:
```
╔════════════════════════════════════════════════════════════╗
║ TRACE TO ASSEMBLY CONTAINER: "Beam-001"                   ║
╠════════════════════════════════════════════════════════════╣
║ Object Properties:
║   ID: 12345 | Model: model-001
║   IFC Class: IfcBeam
╠════════════════════════════════════════════════════════════╣
║ Assembly Properties:
║   ASSEMBLY_POS: "B1"
║   ASSEMBLY_NAME: "Main Beam Assembly"
║   ASSEMBLY_CODE: "01"
╠════════════════════════════════════════════════════════════╣
║ Parent IfcElementAssembly Container:
║   ID: 54321
║   Name: "BEAM-GROUP-1"
║   POS: "B1"
║   NAME: "Main Beam Assembly"
║   CODE: "01"
║ Siblings in container (15):
║   - Beam-001 (IfcBeam)
║   - Beam-002 (IfcBeam)
║   - Connection-001 (IfcPlate)
║   - ...
```

## 2. Build Assembly Filter UI

### HTML Template

```html
<div id="assembly-filters">
  <label>Filter by ASSEMBLY_POS:</label>
  <select id="filter-assembly-pos">
    <option value="">-- All Assemblies --</option>
  </select>
  
  <label>Filter by ASSEMBLY_NAME:</label>
  <select id="filter-assembly-name">
    <option value="">-- All Names --</option>
  </select>
  
  <label>Filter by ASSEMBLY_CODE:</label>
  <select id="filter-assembly-code">
    <option value="">-- All Codes --</option>
  </select>
  
  <button id="btn-clear-filters">Clear Filters</button>
</div>
```

### JavaScript Implementation

```javascript
// Initialize assembly filters
function initAssemblyFilters() {
  // Populate ASSEMBLY_POS dropdown
  const posSelect = document.getElementById("filter-assembly-pos");
  const positions = getUniqueAssemblyValues("pos");
  positions.forEach(pos => {
    const option = document.createElement("option");
    option.value = pos;
    option.textContent = `${pos} (${getObjectsByAssemblyValue("pos", pos).length} objects)`;
    posSelect.appendChild(option);
  });
  
  // Populate ASSEMBLY_NAME dropdown
  const nameSelect = document.getElementById("filter-assembly-name");
  const names = getUniqueAssemblyValues("name");
  names.forEach(name => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = `${name} (${getObjectsByAssemblyValue("name", name).length} objects)`;
    nameSelect.appendChild(option);
  });
  
  // Populate ASSEMBLY_CODE dropdown
  const codeSelect = document.getElementById("filter-assembly-code");
  const codes = getUniqueAssemblyValues("code");
  codes.forEach(code => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = `${code} (${getObjectsByAssemblyValue("code", code).length} objects)`;
    codeSelect.appendChild(option);
  });
  
  // Event listeners
  posSelect.addEventListener("change", applyAssemblyFilters);
  nameSelect.addEventListener("change", applyAssemblyFilters);
  codeSelect.addEventListener("change", applyAssemblyFilters);
  
  document.getElementById("btn-clear-filters").addEventListener("click", clearAssemblyFilters);
}

// Apply filters
function applyAssemblyFilters() {
  const pos = document.getElementById("filter-assembly-pos").value;
  const name = document.getElementById("filter-assembly-name").value;
  const code = document.getElementById("filter-assembly-code").value;
  
  let filtered = allObjects;
  
  if (pos) {
    filtered = filtered.filter(obj => obj.assemblyPos === pos);
  }
  if (name) {
    filtered = filtered.filter(obj => obj.assemblyName === name);
  }
  if (code) {
    filtered = filtered.filter(obj => obj.assemblyPosCode === code);
  }
  
  // Update UI with filtered objects
  updateObjectList(filtered);
  
  // Highlight in 3D
  selectedIds.clear();
  filtered.forEach(obj => {
    selectedIds.add(`${obj.modelId}:${obj.id}`);
  });
  updateViewer();
}

function clearAssemblyFilters() {
  document.getElementById("filter-assembly-pos").value = "";
  document.getElementById("filter-assembly-name").value = "";
  document.getElementById("filter-assembly-code").value = "";
  
  updateObjectList(allObjects);
  selectedIds.clear();
  updateViewer();
}

// Initialize on page load
initAssemblyFilters();
```

## 3. Display Assembly Container Hierarchy

### Show Container Info for Selected Object

```javascript
function showSelectedObjectContainer() {
  if (selectedIds.size === 0) return;
  
  const uid = selectedIds.values().next().value;
  const obj = allObjects.find(o => `${o.modelId}:${o.id}` === uid);
  if (!obj) return;
  
  // Get container info
  const container = getAssemblyContainerForObject(obj);
  
  if (container) {
    console.log(`
      Selected: "${obj.name}"
      Container: "${container.name}" (ID: ${container.id})
      ASSEMBLY_POS: ${container.assemblyPos}
      ASSEMBLY_NAME: ${container.assemblyName}
      ASSEMBLY_CODE: ${container.assemblyPosCode}
    `);
    
    // Get all siblings
    const siblings = getAssemblyChildren(obj.modelId, container.id);
    console.log(`Siblings (${siblings.length}):`);
    siblings.forEach(s => {
      console.log(`  - ${s.name} (${s.ifcClass})`);
    });
  } else {
    console.log(`"${obj.name}" is not part of any IfcElementAssembly container`);
  }
}
```

## 4. Select All Objects in Assembly Container

### Group Selection by Container

```javascript
function selectAssemblyContainerGroup() {
  if (selectedIds.size === 0) return;
  
  // Get first selected object
  const uid = selectedIds.values().next().value;
  const obj = allObjects.find(o => `${o.modelId}:${o.id}` === uid);
  if (!obj) return;
  
  // Get container
  const container = getAssemblyContainerForObject(obj);
  if (!container) {
    console.log("Not in any assembly container");
    return;
  }
  
  // Get all children
  const children = getAssemblyChildren(obj.modelId, container.id);
  
  // Select all
  selectedIds.clear();
  children.forEach(child => {
    selectedIds.add(`${obj.modelId}:${child.id}`);
  });
  
  updateViewer();
  console.log(`Selected ${children.length} objects from container "${container.name}"`);
}
```

## 5. Display Assembly Hierarchy Tree

### Build Tree Structure

```javascript
function buildAssemblyHierarchyTree() {
  const analysis = buildAssemblyHierarchyAnalysis();
  const html = [];
  
  html.push('<div id="assembly-tree">');
  
  for (const container of analysis.containers) {
    html.push(`
      <details>
        <summary>
          🏗️ ${container.name}
          <small>(${container.childCount} children | ${container.totalWeight.toFixed(0)}kg)</small>
        </summary>
        <div class="assembly-info">
          <p><strong>ASSEMBLY_POS:</strong> ${container.assemblyPos}</p>
          <p><strong>ASSEMBLY_NAME:</strong> ${container.assemblyName}</p>
          <p><strong>ASSEMBLY_CODE:</strong> ${container.assemblyPosCode}</p>
          <p><strong>Weight:</strong> ${container.totalWeight.toFixed(2)}kg</p>
          <p><strong>Volume:</strong> ${container.totalVolume.toFixed(6)}m³</p>
          <h4>Members (${container.children.length}):</h4>
          <ul>
    `);
    
    for (const child of container.children) {
      html.push(`
        <li onclick="selectObject('${child.id}', '${child.modelId}')">
          ${child.name} <small>(${child.ifcClass})</small>
        </li>
      `);
    }
    
    html.push(`
          </ul>
        </div>
      </details>
    `);
  }
  
  html.push('</div>');
  
  return html.join('');
}

// Insert into page
document.getElementById("assembly-tree-container").innerHTML = buildAssemblyHierarchyTree();
```

### CSS for Tree

```css
#assembly-tree details {
  margin-bottom: 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 8px;
}

#assembly-tree summary {
  cursor: pointer;
  font-weight: bold;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

#assembly-tree summary:hover {
  background-color: #f0f0f0;
}

.assembly-info {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #eee;
  font-size: 12px;
}

.assembly-info ul {
  list-style-type: none;
  padding-left: 0;
}

.assembly-info li {
  padding: 4px 8px;
  cursor: pointer;
  margin: 2px 0;
  border-radius: 3px;
}

.assembly-info li:hover {
  background-color: #e0e0e0;
}
```

## 6. Trace Child Object to Container

### Interactive Trace Visualization

```javascript
function visualizeObjectTrace() {
  if (selectedIds.size === 0) return;
  
  const uid = selectedIds.values().next().value;
  const obj = allObjects.find(o => `${o.modelId}:${o.id}` === uid);
  if (!obj) return;
  
  const trace = traceObjectToAssemblyContainer(obj);
  
  const html = `
    <div class="trace-visualization">
      <h3>Assembly Trace: ${obj.name}</h3>
      
      <div class="trace-level">
        <strong>📌 Object:</strong>
        <p>${obj.name} (${obj.ifcClass})</p>
        <p>ID: ${obj.id}</p>
      </div>
      
      <div class="trace-arrow">↓</div>
      
      <div class="trace-level">
        <strong>📋 Assembly Properties:</strong>
        <p>ASSEMBLY_POS: <em>${trace.assemblyProperties.assemblyPos}</em></p>
        <p>ASSEMBLY_NAME: <em>${trace.assemblyProperties.assemblyName}</em></p>
        <p>ASSEMBLY_CODE: <em>${trace.assemblyProperties.assemblyPosCode}</em></p>
      </div>
      
      ${trace.ifcElementAssemblyParent ? `
        <div class="trace-arrow">↓</div>
        
        <div class="trace-level">
          <strong>🏗️ Parent IfcElementAssembly:</strong>
          <p>Name: ${trace.ifcElementAssemblyParent.name}</p>
          <p>ID: ${trace.ifcElementAssemblyParent.id}</p>
          <p>Members: ${trace.groupedWith.length}</p>
        </div>
      ` : `
        <div class="trace-arrow">⚠️</div>
        <div class="trace-level">
          <p><em>Not part of direct IfcElementAssembly container</em></p>
          <p><em>Assembly properties are inherited</em></p>
        </div>
      `}
      
      ${trace.groupedWith.length > 0 ? `
        <div class="trace-level">
          <strong>👥 Siblings in Container:</strong>
          <ul>
            ${trace.groupedWith.map(s => `<li>${s.name} (${s.ifcClass})</li>`).join('')}
          </ul>
        </div>
      ` : ''}
    </div>
  `;
  
  document.getElementById("trace-container").innerHTML = html;
}
```

### CSS for Trace

```css
.trace-visualization {
  border: 2px solid #4CAF50;
  border-radius: 8px;
  padding: 16px;
  background-color: #f9f9f9;
  font-family: monospace;
}

.trace-level {
  background-color: white;
  border-left: 4px solid #4CAF50;
  padding: 12px;
  margin: 8px 0;
  border-radius: 4px;
}

.trace-arrow {
  text-align: center;
  color: #4CAF50;
  font-weight: bold;
  margin: 8px 0;
}

.trace-level strong {
  color: #333;
}

.trace-level em {
  color: #666;
  background-color: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
}
```

## 7. Export Assembly Hierarchy to JSON

### Generate Report

```javascript
function exportAssemblyHierarchy() {
  const analysis = buildAssemblyHierarchyAnalysis();
  
  const report = {
    timestamp: analysis.timestamp,
    statistics: analysis.summary,
    containers: analysis.containers.map(c => ({
      id: c.id,
      name: c.name,
      ifcClass: c.ifcClass,
      assemblyPos: c.assemblyPos,
      assemblyName: c.assemblyName,
      assemblyPosCode: c.assemblyPosCode,
      childCount: c.childCount,
      children: c.children,
      totalWeight: c.totalWeight,
      totalVolume: c.totalVolume,
      totalArea: c.totalArea
    })),
    groupings: {
      byPos: Object.entries(analysis.byAssemblyPos).map(([pos, group]) => ({
        value: pos,
        count: group.stats.count,
        weight: group.stats.weight,
        volume: group.stats.volume
      })),
      byName: Object.entries(analysis.byAssemblyName).map(([name, group]) => ({
        value: name,
        count: group.stats.count
      })),
      byCode: Object.entries(analysis.byAssemblyCode).map(([code, group]) => ({
        value: code,
        count: group.stats.count
      }))
    }
  };
  
  // Download as JSON
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `assembly-hierarchy-${new Date().toISOString()}.json`;
  a.click();
}
```

## Key Functions Reference

| Use Case | Function | Example |
|----------|----------|---------|
| Get parent container | `getAssemblyContainerForObject(obj)` | `const cont = getAssemblyContainerForObject(beam);` |
| Get all children | `getAssemblyChildren(modelId, id)` | `const kids = getAssemblyChildren("m1", 123);` |
| Find by POS value | `getObjectsByAssemblyValue("pos", "B1")` | `const beams = getObjectsByAssemblyValue("pos", "B1");` |
| Get unique values | `getUniqueAssemblyValues("pos")` | `const positions = getUniqueAssemblyValues("pos");` |
| Complete analysis | `buildAssemblyHierarchyAnalysis()` | `const analysis = buildAssemblyHierarchyAnalysis();` |
| Trace to container | `traceObjectToAssemblyContainer(obj)` | `const trace = traceObjectToAssemblyContainer(beam);` |

## Debugging Tips

### Console Commands

```javascript
// View complete assembly analysis
window._debugAssemblyAnalysis()

// Show enhanced info for selected object
window._debugEnhancedAssemblyInfo()

// Trace selected object to container
window._debugTraceToContainer()

// List objects by assembly value
window._debugGetAssemblyChildren("pos", "B1")

// List all unique assembly values
window._debugListAssemblyValues("pos")

// Show all containers
window._debugAllContainers()

// Show container children
window._debugContainerChildren(modelId, containerId)
```

### Performance Tips

- Cache `buildAssemblyHierarchyAnalysis()` result if calling multiple times
- Use `getUniqueAssemblyValues()` to populate dropdowns (already sorted)
- For large models, paginate the object list display
- Store selected container ID to reduce re-queries

## Integration with Filtering UI

The assembly container information integrates with your existing filter system:

```javascript
// Your existing filter logic
filteredObjects = applyFilters(allObjects, selectedFilters);

// Add assembly filter
if (selectedFilters.assemblyPos) {
  filteredObjects = filteredObjects.filter(obj => 
    obj.assemblyPos === selectedFilters.assemblyPos
  );
}

// Or use the new helper
if (selectedFilters.assemblyPos) {
  filteredObjects = getObjectsByAssemblyValue("pos", selectedFilters.assemblyPos);
}
```
