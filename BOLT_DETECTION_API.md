## Detailed Implementation Reference - Tekla Bolt Detection

### 1. Bolt Property Detection API

#### Function: `detectTeklaBoltProperties(props, modelId)`

**Input:**
```javascript
props: {
  id: number,                    // Object ID
  class: string,                 // IFC class
  product: { name: string },
  properties: [                  // Property sets
    {
      name: string,              // e.g., "Tekla Common", "Connection"
      properties: [              // Properties in set
        {
          name: string,          // Property name
          value: string|number,  // Property value
          type: PropertyType     // Data type
        }
      ]
    }
  ]
}
```

**Output:**
```javascript
{
  isTeklaBolt: boolean,          // True if any bolt property detected
  boltType: string,              // "M16 Bolt", "Foundation Bolt", etc.
  boltSize: string,              // "16mm", "M16", etc.
  boltGrade: string,             // "8.8", "10.9", "Grade 8", etc.
  washerType: string,            // "DIN125", "Spring Lock Washer", etc.
  washerCount: number,           // 0-N washers per bolt
  nutType: string,               // "DIN934", "Nylock", etc.
  nutCount: number,              // 0-N nuts per bolt
  tightened: boolean,            // Torque-tightened or preloaded
  comments: string,              // Installation notes
  allBoltProperties: object      // Raw property map {propName: value}
}
```

### 2. Property Name Matchers

The detection uses normalized property names (lowercase, no spaces/underscores):

**Bolt Type Patterns:**
- `bolttype`, `bolt_type`, `type` (in bolt property set)
- Example values: "M16", "Foundation Bolt", "Anchor Bolt"

**Bolt Size/Diameter:**
- `boltsize`, `bolt_size`, `bolt_diameter`, `diameter`
- Example values: "16mm", "M16", "5/8 inch"

**Bolt Grade:**
- `boltgrade`, `bolt_grade`, `grade` (in bolt context)
- Example values: "8.8", "10.9", "Grade 5"

**Washer Type:**
- `washertype`, `washer_type`, `washername`, `washer`
- Example values: "DIN125", "Spring Lock Washer", "USS"

**Washer Count:**
- `washercount`, `washer_count`, `numberofwashers`
- Example values: "1", "2", numeric

**Nut Type:**
- `nuttype`, `nut_type`, `nutname`
- Example values: "DIN934", "Nylock", "Castle Nut"

**Nut Count:**
- `nutcount`, `nut_count`, `numberofnuts`
- Example values: "1", "2", numeric

### 3. Processing Examples

#### Example 1: Simple Bolt Object
```
Property Set: "Tekla Common"
  - Property: "Bolt Type" = "M16"
  - Property: "Bolt Grade" = "8.8"
  - Property: "Washer Type" = "DIN125"
  - Property: "Washer Count" = "1"

Result:
{
  isTeklaBolt: true,
  boltType: "M16",
  boltGrade: "8.8",
  washerType: "DIN125",
  washerCount: 1
}
```

#### Example 2: Complex Connection
```
Property Set: "Connection Properties"
  - Property: "Connection Type" = "Bolted"
  - Property: "Bolt Size" = "M20"
  - Property: "Bolt Grade" = "10.9"
  - Property: "Number of Bolts" = "4"
  - Property: "Washer Type" = "USS"
  - Property: "Washer Per Bolt" = "2"
  - Property: "Nut Type" = "Nylock"
  - Property: "Nut Count" = "1"
  - Property: "Tightened" = "Yes"

Result:
{
  isTeklaBolt: true,
  boltSize: "M20",
  boltGrade: "10.9",
  washerType: "USS",
  washerCount: 2,
  nutType: "Nylock",
  nutCount: 1,
  tightened: true
}
```

### 4. Assembly Position Enrichment

#### Hierarchy Map Structure
```javascript
hierarchyParentMap:
  "modelId:childId" → {
    id: parentId,
    name: "Parent Assembly Name",
    class: "IfcElementAssembly",
    modelId: "modelId"
  }

assemblyNodeInfoMap:
  "modelId:assemblyId" → {
    id: assemblyId,
    name: "Assembly Name",
    class: "IfcElementAssembly",
    modelId: "modelId"
  }

assemblyMembershipMap:
  "modelId:childId" → "modelId:assemblyId"

assemblyChildrenMap:
  "modelId:assemblyId" → Set(childId1, childId2, ...)
```

#### Assembly Class Mapping
```javascript
classGroupMap: {
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
  // ... more mappings
}
```

### 5. Object Display in UI

#### Tree Item with Bolt Badge
```html
<div class="tree-item selected">
  <input type="checkbox" class="tree-item-checkbox" checked />
  <span class="tree-item-name">M16 Boldwasher</span>
  <span class="tree-item-badge bolt">⚙️ Bolt</span>
  <span class="tree-item-badge">Fastener</span>
</div>
```

#### Enhanced Tooltip
```
Tên: M16 Bolt Assembly | Type: IfcMechanicalFastener | Assembly Pos: Connection-A | 
[TEKLA BOLT] | Bolt Type: M16 | Bolt Size: M16 | Bolt Grade: 8.8 | 
Washer: DIN125 (x1) | Nut: DIN934 (x1)
```

### 6. Statistics Integration

#### Grouping by Bolt Type
When grouping by bolt properties:
```
Statistics Table:
+----------------------+-----+--------+--------+--------+
| Nhóm (Bolt Type)     | Qty | Vol m³ | Area m²| Weight |
+----------------------+-----+--------+--------+--------+
| M16 Bolts            | 120 | 0.002  | 0.500  | 15.2   |
| M20 Bolts            | 80  | 0.004  | 0.800  | 24.5   |
| Foundation Bolts     | 20  | 0.010  | 1.200  | 78.5   |
| Fasteners (Other)    | 45  | 0.001  | 0.250  | 5.8    |
+----------------------+-----+--------+--------+--------+
| TỔNG CỘNG            | 265 | 0.017  | 2.750  | 124.0  |
+----------------------+-----+--------+--------+--------+
```

#### Filtering in Export
Bolts are included in all export operations, even without weight/area:
```javascript
// is3DObjectWithDimensions() now returns true for:
object.isTeklaBolt || object.weight > 0 || object.area > 0 || object.volume > 0
```

### 7. Deduplication Scoring

When multiple versions of same object found:
```javascript
// Score calculation
score = 
  (volume > 0 ? 3 : 0) +        // High importance
  (weight > 0 ? 2 : 0) +
  (area > 0 ? 2 : 0) +
  (assemblyPos ? 2 : 0) +
  (isTeklaBolt ? 2 : 0) +       // Bolt info important
  (profile ? 1 : 0) +
  (isTekla ? 1 : 0)

// Keeps entry with highest score
```

### 8. Debug Logging

Enable debug logs in browser console:
```javascript
// Assembly enrichment logs
[ObjectExplorer] Enriched from hierarchy: 45 from IfcElementAssembly, 
  78 from parent, 120 from IFC class, 30 from names

// Deduplication logs
[ObjectExplorer] Deduplicated: 1250 → 1000 objects 
  (removed 250 duplicates)

// Assembly assignment logs
[ASM] Object 12345: assemblyPos = "Assembly-A1" (from "ASSEMBLY_POS")
[ASM] Object 12346: assemblyPos = "Beams" (from IFC class)
```

### 9. Property Set Name Recognition

Property sets recognized as bolt-related:
- "Tekla Common"
- "Tekla.Assembly"
- "Tekla Structures"
- "Connection Properties"
- "Bolt Properties"
- "Fastener Properties"
- "Assembly*" (wildcard match)
- Contains "Bolt", "Fastener", "Connection", "Assembly"

### 10. Special Cases

#### No Traditional Dimensions
```javascript
// Bolt object found, but weight=0, area=0, volume=0
// Still included in statistics because isTeklaBolt=true
is3DObjectWithDimensions(boltObject) → true
```

#### Multiple Washers
```javascript
// Property: "Washer Count" = 2
// Means 2 washers per bolt
// Multiply by bolt count for total washer count in assembly
```

#### Tightening Information
```javascript
// Property: "Tightened" = "Yes"
// Indicates pre-tightened or torque-applied connection
// Useful for assembly procedure documentation
```

---

## Performance Considerations

1. **Property Scanning**: O(n) where n = total properties
2. **Name Normalization**: Minimal overhead (string operations)
3. **Deduplication**: O(n log n) with Map operations
4. **Hierarchy Traversal**: O(depth) per model
5. **Overall Impact**: <100ms for typical IFC files

## Future Enhancement Ideas

1. **Preload Calculation**: Compute bolt preload stress
2. **Cost Estimation**: Calculate fastener costs from properties
3. **Assembly Sequence**: Generate installation sequence from bolt/nut order
4. **Conflict Detection**: Identify bolt clearance conflicts
5. **Standard Compliance**: Validate against DIN/ISO/ASTM standards
