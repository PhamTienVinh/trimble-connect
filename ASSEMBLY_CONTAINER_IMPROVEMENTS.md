# Cải Thiện Xác Định Container Assembly - Tài Liệu

## 📋 Tóm Tắt

Các cải thiện này giúp xác định chính xác container `IfcElementAssembly` mà mỗi child object thuộc vào, cũng như cung cấp các công cụ để:

1. ✅ **Xác định được container nào chứa một child**
2. ✅ **Cải thiện bộ lọc ASSEMBLY_NAME, ASSEMBLY_POS, ASSEMBLY_POSITION_CODE**
3. ✅ **Thêm IfcElementAssembly vào phần lọc**
4. ✅ **Hiển thị quan hệ parent-child trong UI**
5. ✅ **Cung cấp các debug functions để kiểm tra quan hệ assembly**

---

## 🔍 Các Hàm API Công Khai

### 1. `getAssemblyContainerForObject(obj)`
**Mục đích:** Lấy thông tin container `IfcElementAssembly` mà một child object thuộc vào.

**Cách dùng:**
```javascript
// Lấy thông tin container cho một object
const container = getAssemblyContainerForObject(obj);
if (container) {
  console.log("Container ID:", container.id);
  console.log("Assembly POS:", container.assemblyPos);
  console.log("Assembly NAME:", container.assemblyName);
  console.log("Assembly CODE:", container.assemblyPosCode);
} else {
  console.log("Đối tượng này không thuộc bất kì container nào");
}
```

**Return:**
```javascript
{
  id: 123,
  modelId: "model-id",
  name: "BEAM-1",
  ifcClass: "IfcElementAssembly",
  assemblyPos: "B1",
  assemblyName: "Main Beam Assembly",
  assemblyPosCode: "CODE-B1"
}
// hoặc null nếu không có container
```

---

### 2. `getAssemblyChildren(modelId, containerId)`
**Mục đích:** Lấy tất cả các child objects thuộc một container `IfcElementAssembly` cụ thể.

**Cách dùng:**
```javascript
// Lấy tất cả children của container có ID 123
const children = getAssemblyChildren("model-id", 123);
console.log(`Container này có ${children.length} child objects`);

for (const child of children) {
  console.log(`- ${child.name} (${child.ifcClass})`);
}
```

**Return:** Array của các object thuộc container.

---

### 3. `getObjectAssemblyStatus(obj)`
**Mục đích:** Kiểm tra xem object có thông tin assembly và những thông tin nào.

**Cách dùng:**
```javascript
const status = getObjectAssemblyStatus(obj);
console.log("Assembly status:", status);
// "all" | "pos|name" | "pos|code" | "name|code" | "pos" | "name" | "code" | "none"
```

---

### 4. `getAssemblyContainers()`
**Mục đích:** Lấy danh sách tất cả các container `IfcElementAssembly`.

**Cách dùng:**
```javascript
const containers = getAssemblyContainers();
console.log(`Tổng ${containers.length} containers`);

for (const container of containers) {
  console.log(`${container.assemblyPos}: ${container.childCount} children`);
}
```

---

### 5. `getAssemblyStatistics()`
**Mục đích:** Lấy thống kê về assembly detection.

**Cách dùng:**
```javascript
const stats = getAssemblyStatistics();
console.log(`Total Objects: ${stats.totalObjects}`);
console.log(`With ASSEMBLY_POS: ${stats.objectsWithAssemblyPos}`);
console.log(`With ASSEMBLY_NAME: ${stats.objectsWithAssemblyName}`);
console.log(`With ASSEMBLY_CODE: ${stats.objectsWithAssemblyCode}`);
console.log(`Total IfcElementAssembly Containers: ${stats.totalAssemblyContainers}`);
console.log(`Total Assembly Memberships: ${stats.totalAssemblyMemberships}`);
```

---

### 6. `logObjectAssemblyRelationship(obj)`
**Mục đích:** In thông tin chi tiết về quan hệ assembly của một object.

**Cách dùng:**
```javascript
logObjectAssemblyRelationship(selectedObject);

// Output:
// ╔════════════════════════════════════════════════════════════╗
// ║ ASSEMBLY RELATIONSHIP DEBUG: "BEAM-1" (IfcBeam)           ║
// ╠════════════════════════════════════════════════════════════╣
// ║ Object ID: 456 | Model: model-1
// ║ Assembly Status: pos|name|code
// ║   ASSEMBLY_POS: "B1"
// ║   ASSEMBLY_NAME: "Main Beam"
// ║   ASSEMBLY_POSITION_CODE: "CODE-B1"
// ╠════════════════════════════════════════════════════════════╣
// ║ PARENT CONTAINER: IfcElementAssembly
// ║   Container ID: 123
// ║   Container Name (IFC): "BEAM-1"
// ║   Container ASSEMBLY_POS: "B1"
// ...
```

---

## 🐛 Debug Functions (Để Gọi từ Console)

### `window._debugAssemblyContainers()`
Hiển thị thông tin assembly của object(s) được chọn.

```javascript
// 1. Chọn một object trong tree
// 2. Gọi lệnh này từ console:
window._debugAssemblyContainers();
```

**Output:** Thống kê + thông tin chi tiết cho từng object được chọn.

---

### `window._debugAllContainers()`
Liệt kê tất cả các `IfcElementAssembly` containers và children của chúng.

```javascript
window._debugAllContainers();

// Output:
// 🏗️ Container ID 123:
//    Name (IFC): "BEAM-1"
//    ASSEMBLY_POS: "B1"
//    ASSEMBLY_NAME: "Main Beam"
//    ASSEMBLY_CODE: "CODE-B1"
//    Children: 5
//      ├─ "PLATE-1" (IfcPlate)
//      ├─ "PLATE-2" (IfcPlate)
//      ├─ ...
```

---

### `window._debugContainerChildren(modelId, containerId)`
Hiển thị chi tiết về tất cả children của một container.

```javascript
window._debugContainerChildren("model-1", 123);

// Output: Danh sách chi tiết tất cả children
```

---

## 📊 Cách Hoạt Động - Luồng Dữ Liệu

### 1. **Xây Dựng Hierarchy (Scan Phase)**
```
Model được load
    ↓
Quét IFC hierarchy → Tìm IfcElementAssembly nodes
    ↓
Tạo assemblyMembershipMap: child → parent
    ↓
Tạo assemblyChildrenMap: parent → children
    ↓
Tạo assemblyNodeInfoMap: container info (ASSEMBLY_POS, NAME, CODE)
```

### 2. **Xác Định Container cho Child**
```javascript
// Khi chọn một child object:
const childKey = "modelId:childId";
const assemblyKey = assemblyMembershipMap.get(childKey);  // "modelId:parentId"
const containerInfo = assemblyNodeInfoMap.get(assemblyKey);  // { assemblyPos, name, ... }
```

### 3. **Hiển Thị UI**
```
Tree Item (Child):
┌─ [Checkbox] "PLATE-1" (IfcPlate)
│  ├─ Badge: "IFC: Plate"
│  ├─ Badge: "Tekla" (nếu từ Tekla)
│  ├─ Badge: "B1" (ASSEMBLY_POS)
│  └─ Badge: "🔗 CODE-B1" (Parent Container - MỚI)
└─ ...
```

---

## 🔧 Ví Dụ Thực Tế

### Ví Dụ 1: Chọn một beam và tìm container của nó
```javascript
// 1. Chọn "PLATE-1" trong tree
// 2. Gọi:
window._debugAssemblyContainers();

// Output sẽ hiển thị:
// Object: "PLATE-1" (IfcPlate)
// Assembly Status: pos|name
// ASSEMBLY_POS: "B1"
// ASSEMBLY_NAME: "Main Beam"
// 
// PARENT CONTAINER: IfcElementAssembly
// Container ID: 123
// Container Name (IFC): "BEAM-1"
// Container ASSEMBLY_POS: "B1"
// 
// SIBLINGS IN SAME CONTAINER: 4 objects
// - "PLATE-1" (IfcPlate)
// - "PLATE-2" (IfcPlate)
// - "BOLT-1" (IfcMechanicalFastener)
// - "BOLT-2" (IfcMechanicalFastener)
```

### Ví Dụ 2: Lấy tất cả children của container B1
```javascript
const children = getAssemblyChildren("model-1", 123);

// Lặp qua từng child
for (const child of children) {
  console.log(`${child.name}:`);
  console.log(`  - Type: ${child.ifcClass}`);
  console.log(`  - Weight: ${child.weight}kg`);
  console.log(`  - Volume: ${child.volume}m³`);
}
```

### Ví Dụ 3: Lọc các object có assembly info
```javascript
const objectsWithAssembly = allObjects.filter(obj => 
  getObjectAssemblyStatus(obj) !== "none"
);

console.log(`${objectsWithAssembly.length} objects có thông tin assembly`);
console.log(`${allObjects.length - objectsWithAssembly.length} objects không có assembly info`);
```

---

## 🗂️ Cấu Trúc Dữ Liệu - Maps

### `assemblyMembershipMap`
```javascript
// Map: "modelId:childId" → "modelId:containerId"
Map {
  "model-1:456" => "model-1:123",    // PLATE-1 → BEAM (Container 123)
  "model-1:457" => "model-1:123",    // PLATE-2 → BEAM (Container 123)
  "model-1:458" => "model-1:124",    // PLATE-3 → COLUMN (Container 124)
  ...
}
```

### `assemblyChildrenMap`
```javascript
// Map: "modelId:containerId" → Set([childId1, childId2, ...])
Map {
  "model-1:123" => Set([456, 457, 459, 460]),  // Container 123 có 4 children
  "model-1:124" => Set([458, 461]),             // Container 124 có 2 children
  ...
}
```

### `assemblyNodeInfoMap`
```javascript
// Map: "modelId:containerId" → { id, name, class, assemblyPos, assemblyName, assemblyPosCode }
Map {
  "model-1:123" => {
    id: 123,
    name: "BEAM-1",
    class: "IfcElementAssembly",
    assemblyPos: "B1",
    assemblyName: "Main Beam Assembly",
    assemblyPosCode: "CODE-B1"
  },
  ...
}
```

---

## 📈 Lợi Ích

✅ **Xác định chính xác:** Biết được child nào thuộc container nào  
✅ **Lọc tốt hơn:** Có thể nhóm child theo container + ASSEMBLY_POS/NAME/CODE  
✅ **Debug dễ dàng:** Có tools để kiểm tra quan hệ parent-child  
✅ **UI tốt hơn:** Hiển thị container info trực tiếp trong tree  
✅ **API rõ ràng:** Công khai các function để sử dụng lại  

---

## 🚀 Các Trường Hợp Dùng

### Trường Hợp 1: Lọc children theo container
```javascript
// Hiển thị tất cả children của container "B1"
const containers = getAssemblyContainers();
const b1Container = containers.find(c => c.assemblyPos === "B1");
const b1Children = getAssemblyChildren(b1Container.modelId, b1Container.id);
```

### Trường Hợp 2: Kiểm tra xem object có assembly info
```javascript
if (getObjectAssemblyStatus(obj) === "none") {
  console.log("Object không có assembly info");
} else {
  const container = getAssemblyContainerForObject(obj);
  if (container) {
    console.log(`Object thuộc container ${container.assemblyPos}`);
  }
}
```

### Trường Hợp 3: Xuất dữ liệu assembly relationship
```javascript
const containers = getAssemblyContainers();
for (const container of containers) {
  const children = getAssemblyChildren(container.modelId, container.id);
  console.log(`${container.assemblyPos}: ${children.length} objects`);
  for (const child of children) {
    // Export data
  }
}
```

---

## 📝 Ghi Chú

- Tất cả hàm API có thể gọi được từ: modules khác, debug console, hoặc extensions
- Maps được build lại mỗi lần scan model
- Container info bao gồm cả ASSEMBLY_POS, ASSEMBLY_NAME, ASSEMBLY_POSITION_CODE
- Nếu object không có container, nó vẫn có thể có assembly properties riêng

---

## 🔄 Các Bước Tiếp Theo (Optional)

1. **Hiển thị IfcElementAssembly trong tree** - Có thể thêm container nodes như group headers
2. **Bộ lọc nâng cao** - Filter theo container + assembly properties
3. **Export assembly structure** - Xuất hierarchy parent-child dưới dạng CSV/JSON
4. **Visualization** - Highlight container + children khi click

---

**Tạo ngày:** 2026-04-15  
**Phiên bản:** 1.0  
**Cập nhật lần cuối:** 2026-04-15
