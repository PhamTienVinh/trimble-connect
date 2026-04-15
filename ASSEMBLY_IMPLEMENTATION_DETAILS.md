# Cấu Trúc Triển Khai - Assembly Container Detection

## 📐 Thiết Kế Kiến Trúc

### 1. **Data Flow - Luồng Dữ Liệu**

```
┌─────────────────────────────────────────────────────────────┐
│                    IFC File Load                            │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│         buildAssemblyHierarchyMap(models)                   │
│                                                             │
│  - Query IFC hierarchy for SpatialHierarchy                │
│  - Query IFC hierarchy for ElementAssembly                 │
│  - Walk hierarchy tree                                     │
│  - Build hierarchyParentMap: child → parent                │
│  - Build assemblyMembershipMap: child → assembly container │
│  - Build assemblyChildrenMap: container → children Set     │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│     fetchAssemblyContainerProperties()                      │
│                                                             │
│  - Fetch properties for ALL IfcElementAssembly nodes       │
│  - Extract ASSEMBLY_POS, ASSEMBLY_NAME, CODE              │
│  - Populate assemblyNodeInfoMap with container props       │
│  - Store: id, name, assemblyPos, assemblyName, code       │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│     enrichAssemblyFromHierarchy()                           │
│                                                             │
│  - For each child missing assembly info                    │
│  - Check assemblyMembershipMap for parent container        │
│  - Get parent props from assemblyNodeInfoMap               │
│  - Propagate to child: assemblyPos, assemblyName, code     │
│  - Re-assign assemblyInstanceId                            │
└─────────────────────┬───────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│         PUBLIC API: Assembly Detection Functions            │
│                                                             │
│  ✓ getAssemblyContainerForObject(obj)                      │
│  ✓ getAssemblyChildren(modelId, containerId)              │
│  ✓ getObjectAssemblyStatus(obj)                           │
│  ✓ getAssemblyContainers()                                │
│  ✓ getAssemblyStatistics()                                │
│  ✓ logObjectAssemblyRelationship(obj)                     │
└─────────────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────────┐
│          Runtime: Debug & Inspection Console               │
│                                                             │
│  window._debugAssemblyContainers()                         │
│  window._debugAllContainers()                              │
│  window._debugContainerChildren(modelId, id)              │
└─────────────────────────────────────────────────────────────┘
```

---

## 🗂️ Các Global Maps

### `assemblyMembershipMap: Map<string, string>`
**Key:** `"modelId:childId"`  
**Value:** `"modelId:parentContainerId"`  
**Dùng cho:** Tìm parent container của một child

```javascript
// Example:
assemblyMembershipMap.set("model-1:456", "model-1:123");
// Nghĩa: Object ID 456 thuộc container ID 123 (cùng model-1)
```

### `assemblyChildrenMap: Map<string, Set<number>>`
**Key:** `"modelId:containerId"`  
**Value:** `Set([childId1, childId2, ...])`  
**Dùng cho:** Lấy tất cả children của một container

```javascript
// Example:
assemblyChildrenMap.set("model-1:123", new Set([456, 457, 458]));
// Nghĩa: Container 123 có 3 children: 456, 457, 458
```

### `assemblyNodeInfoMap: Map<string, Object>`
**Key:** `"modelId:containerId"`  
**Value:** `{ id, name, class, assemblyPos, assemblyName, assemblyPosCode }`  
**Dùng cho:** Lấy thông tin container (ASSEMBLY_POS, NAME, CODE)

```javascript
// Example:
assemblyNodeInfoMap.set("model-1:123", {
  id: 123,
  name: "BEAM-1",
  class: "IfcElementAssembly",
  assemblyPos: "B1",
  assemblyName: "Main Beam Assembly",
  assemblyPosCode: "CODE-B1"
});
```

### `hierarchyParentMap: Map<string, Object>`
**Key:** `"modelId:childId"`  
**Value:** `{ id, name, class, modelId }`  
**Dùng cho:** Tìm parent node trong spatial hierarchy

---

## 🔄 Các Giai Đoạn Xây Dựng

### Giai Đoạn 1: `buildAssemblyHierarchyMap(models)`

```javascript
async function buildAssemblyHierarchyMap(models) {
  // 1. Clear previous maps
  assemblyMembershipMap.clear();
  assemblyChildrenMap.clear();
  assemblyNodeInfoMap.clear();
  hierarchyParentMap.clear();

  // 2. For each model
  for (const model of models) {
    // 3. Get spatial hierarchy
    const spatialRootNodes = await viewerRef.getHierarchyChildren(
      modelId, [0], HierarchyType.SpatialHierarchy, true
    );
    // Walk to build hierarchyParentMap

    // 4. Get element assembly hierarchy
    const assemblyRootNodes = await viewerRef.getHierarchyChildren(
      modelId, [0], HierarchyType.ElementAssembly, true
    );
    // Walk to build:
    // - assemblyNodeInfoMap (stores node info)
    // - assemblyChildrenMap (container → children)
    // - assemblyMembershipMap (child → container)
  }
}
```

**Output:** Tất cả 3 maps được populate

---

### Giai Đoạn 2: `fetchAssemblyContainerProperties()`

```javascript
async function fetchAssemblyContainerProperties() {
  // 1. For each entry in assemblyNodeInfoMap
  for (const [key, nodeInfo] of assemblyNodeInfoMap) {
    // 2. Fetch properties for this container
    const propsArray = await viewerRef.getObjectProperties(modelId, [nodeInfo.id]);
    
    // 3. Parse assembly properties from response
    // Look for: ASSEMBLY_POS, ASSEMBLY_NAME, ASSEMBLY_POSITION_CODE
    
    // 4. Update nodeInfo with found values
    nodeInfo.assemblyPos = foundPos;
    nodeInfo.assemblyName = foundName;
    nodeInfo.assemblyPosCode = foundCode;
  }
}
```

**Output:** `assemblyNodeInfoMap` enriched với ASSEMBLY_POS, NAME, CODE

---

### Giai Đoạn 3: `enrichAssemblyFromHierarchy()`

```javascript
async function enrichAssemblyFromHierarchy() {
  for (const obj of allObjects) {
    if (obj.assemblyPos) continue;  // Already has info
    
    const objectKey = `${obj.modelId}:${obj.id}`;
    
    // Strategy 1: Check assemblyMembershipMap
    const assemblyKey = assemblyMembershipMap.get(objectKey);
    if (assemblyKey) {
      const nodeInfo = assemblyNodeInfoMap.get(assemblyKey);
      // Propagate container's assemblyPos/Name/Code to child
      obj.assemblyPos = nodeInfo.assemblyPos;
      obj.assemblyName = nodeInfo.assemblyName;
      obj.assemblyPosCode = nodeInfo.assemblyPosCode;
      continue;
    }
    
    // Strategy 2: Check hierarchyParentMap
    // ... other strategies
  }
}
```

**Output:** Tất cả objects có assemblyPos/Name/Code populated từ container

---

## 🎯 Cách Xác Định Container

### Phương Pháp 1: Từ `assemblyMembershipMap` (MỘT CHIỀU)
```javascript
const childKey = "model-1:456";
const containerKey = assemblyMembershipMap.get(childKey);
// → "model-1:123"

const containerInfo = assemblyNodeInfoMap.get(containerKey);
// → { id: 123, assemblyPos: "B1", ... }
```

### Phương Pháp 2: Từ Object Properties
```javascript
if (obj.assemblyPos && obj.assemblyName) {
  // Object có assembly info → biết được nó thuộc assembly nào
  // Nhưng không biết ID của container (chỉ biết properties)
  console.log(`Object thuộc assembly: ${obj.assemblyPos}`);
}
```

### Phương Pháp 3: Làm Ngược - Từ Container Lấy Children
```javascript
const containerKey = "model-1:123";
const childIds = assemblyChildrenMap.get(containerKey);
// → Set([456, 457, 458])

for (const childId of childIds) {
  const child = allObjects.find(o => o.modelId === modelId && o.id === childId);
  console.log(`Child: ${child.name}`);
}
```

---

## 📝 Các Hàm Public & Cách Dùng

### `getAssemblyContainerForObject(obj)`

```javascript
/**
 * IMPLEMENTS: Xác định được container nào chứa object
 * USE CASE: Khi click vào 1 child, hiểu nó thuộc container nào
 */
export function getAssemblyContainerForObject(obj) {
  const objectKey = `${obj.modelId}:${obj.id}`;
  const assemblyKey = assemblyMembershipMap.get(objectKey);  // ← Một chiều
  
  if (!assemblyKey) return null;
  
  const nodeInfo = assemblyNodeInfoMap.get(assemblyKey);  // ← Lấy info
  return {  // ← Trả về container info
    id: nodeInfo.id,
    assemblyPos: nodeInfo.assemblyPos,
    // ...
  };
}
```

### `getAssemblyChildren(modelId, containerId)`

```javascript
/**
 * IMPLEMENTS: Lấy tất cả children của 1 container
 * USE CASE: Hiển thị danh sách các parts trong 1 assembly
 */
export function getAssemblyChildren(modelId, containerId) {
  const containerKey = `${modelId}:${containerId}`;
  const childIds = assemblyChildrenMap.get(containerKey);  // ← Lấy IDs
  
  if (!childIds) return [];
  
  // Tìm objects với những IDs đó
  const children = [];
  for (const childId of childIds) {
    const obj = allObjects.find(o => o.modelId === modelId && o.id === childId);
    if (obj) children.push(obj);
  }
  return children;
}
```

---

## 🧩 Tích Hợp với Render Tree

### Hiển Thị Container Info trong UI

```javascript
function renderTreeItemHtml(obj, groupBy) {
  // ... existing code ...
  
  // NEW: Show parent container badge
  const containerInfo = getAssemblyContainerForObject(obj);
  if (containerInfo && groupBy !== "assemblyPos") {
    // Hiển thị badge cho container parent
    html += `<span class="tree-item-badge asm-container">
              🔗 ${containerInfo.assemblyPos}
            </span>`;
  }
  
  return html;
}
```

**Output trong UI:**
```
tree-item:
├─ [✓] "PLATE-1" (IfcPlate)
│  ├─ Badge: "B1" (ASSEMBLY_POS)
│  └─ Badge: "🔗 B1" (Parent Container) ← MỚI
├─ ...
```

---

## 🐛 Debug Path

### Flow khi gọi `window._debugAssemblyContainers()`

```
1. Get selected objects
   ↓
2. Compute stats using getAssemblyStatistics()
   - Count objects with assemblyPos/Name/Code
   - Count containers & memberships
   ↓
3. For each selected object:
   ↓
4. Call logObjectAssemblyRelationship(obj)
   ├─ Get container: getAssemblyContainerForObject(obj)
   ├─ Get status: getObjectAssemblyStatus(obj)
   ├─ Get siblings: getAssemblyChildren(modelId, containerId)
   ↓
5. Print formatted output
```

---

## 🔐 Data Consistency

### Bảo Đảm Consistency

1. **Xây dựng maps:** `buildAssemblyHierarchyMap()` → populate `assemblyMembershipMap`, `assemblyChildrenMap`
2. **Fetch properties:** `fetchAssemblyContainerProperties()` → enrich `assemblyNodeInfoMap`
3. **Propagate:** `enrichAssemblyFromHierarchy()` → set obj.assemblyPos/Name/Code
4. **Verify:** Tất cả 3 maps consistent:
   - Nếu child trong membershipMap, container phải trong nodeInfoMap
   - Nếu container trong childrenMap, phải trong nodeInfoMap

### Kiểm Tra

```javascript
// Verify consistency:
for (const [childKey, containerKey] of assemblyMembershipMap) {
  const nodeInfo = assemblyNodeInfoMap.get(containerKey);
  if (!nodeInfo) console.error(`Orphaned child: ${childKey}`);
  
  const childIds = assemblyChildrenMap.get(containerKey);
  if (!childIds) console.error(`Container without children map: ${containerKey}`);
}
```

---

## 📊 Tính Năng Tương Lai

### Có Thể Thêm:

1. **Display IfcElementAssembly Containers**
   - Thêm container nodes vào tree (như group headers)
   - Hiển thị tổng quantity của children

2. **Advanced Filtering**
   - Filter theo container + assembly properties
   - Filter theo parent-child relationship

3. **Export Assembly Structure**
   - CSV: Container | Child1 | Child2 | ...
   - JSON: Hierarchy structure
   - BOM (Bill of Materials)

4. **Visualization Improvements**
   - Highlight container + children khi hover
   - Show assembly path: Building → Storey → Assembly → Parts
   - Color coding cho different assembly levels

5. **Performance Optimization**
   - Cache container IDs
   - Index by assemblyPos for faster lookup
   - Lazy loading cho large hierarchies

---

## 🎯 Khi Nào Dùng Mỗi Hàm

| Hàm | Khi Nào Dùng | Input | Output |
|-----|-------------|-------|--------|
| `getAssemblyContainerForObject()` | Biết child, tìm container | object | container info \| null |
| `getAssemblyChildren()` | Biết container, tìm children | modelId, containerId | [objects] |
| `getObjectAssemblyStatus()` | Kiểm tra object có assembly info | object | "pos"\|"name"\|"code"\|"none" |
| `getAssemblyContainers()` | Liệt kê tất cả containers | - | [containers] |
| `getAssemblyStatistics()` | Thống kê toàn bộ | - | stats object |
| `logObjectAssemblyRelationship()` | Debug 1 object | object | console output |

---

## 📚 Tài Liệu Liên Quan

- `ASSEMBLY_CONTAINER_IMPROVEMENTS.md` - User guide
- `src/objectExplorer.js` - Implementation code
- Trimble Connect API docs - Hierarchy API

---

**Tạo:** 2026-04-15  
**Cục bộ:** e:/trimble-connect  
**Phiên bản:** 1.0
