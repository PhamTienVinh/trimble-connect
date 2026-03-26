# DDC Statistics - Assembly & Tekla Bolt Fixes

## Overview
This document summarizes the fixes implemented to address two major issues:
1. Assembly_pos filtering producing "(Không xác định)" duplicates
2. Tekla Bolt components not being recognized and counted

---

## Problem 1: Assembly Position Filtering Issue

### Original Issue
- Many objects were falling into "(Không xác định)" (Undefined) category
- Same objects appeared in multiple assembly_pos groups
- Hierarchy enrichment was incomplete

### Root Causes
1. Objects without explicit `assemblyPos` property values fell back to undefined
2. Hierarchy traversal didn't capture all assembly relationships
3. No fallback strategy for objects lacking Tekla properties
4. Missing structural class-based grouping

### Solution Implemented

#### Enhanced Assembly Position Enrichment (5-Level Strategy)

The `enrichAssemblyFromHierarchy()` function now implements a comprehensive 5-level fallback strategy:

**Level 1: IfcElementAssembly Membership**
- Direct assembly relationship from IFC hierarchy
- Most reliable method for Tekla structures

**Level 2: Direct Parent Node Names**
- Uses spatial hierarchy parent relationships
- Applies to structural elements (Beams, Columns, Plates, etc.)

**Level 3: IFC Class-Based Grouping**
Maps common IFC classes to meaningful groups:
- IfcBeam → "Beams"
- IfcColumn → "Columns"
- IfcSlab → "Slabs"
- IfcWall → "Walls"
- IfcPlate → "Plates"
- IfcDiscreteAccessory → "Discrete Accessories"
- IfcFastener → "Fasteners"
- IfcMechanicalFastener → "Mechanical Fasteners"
- ... and more

**Level 4: Object Names**
- For assembly node objects, uses their own name

**Level 5: Secondary Assembly Properties**
- Falls back to assemblyName or assembly properties

#### Results
- Significantly reduces "(Không xác định)" categories
- All structural elements now have meaningful group assignments
- No more arbitrary undefined groupings

---

## Problem 2: Tekla Bolt Component Recognition

### Original Issue
- Tekla Bolt components weren't being identified
- Properties like washer type, count, bolt grade not extracted
- Bolts/fasteners not appearing in statistics table
- IFC object types for bolt components unclear

### Solution Implemented

#### New Tekla Bolt Detection System

Added new `detectTeklaBoltProperties()` function that:

**Identifies Bolt Properties:**
- `boltType` - Type of bolt (from Tekla properties)
- `boltSize` - Bolt diameter/size
- `boltGrade` - Material grade
- `washerType` - Type of washer (flat, spring, etc.)
- `washerCount` - Number of washers
- `nutType` - Type of nut
- `nutCount` - Number of nuts
- `boltTightened` - Tightening status
- `boltComments` - Associated comments

**Detection Strategy:**
1. Scans all property sets for bolt/fastener keywords
2. Looks for property names containing: "bolt", "washer", "nut", "fastener"
3. Extracts numeric quantities (count values)
4. Stores all bolt properties for display and statistics

**Display Enhancements:**
- Toklas Bolt objects show ⚙️ badge in tree view
- Tooltip shows complete bolt specifications
- Statistics now include bolt components

#### Object Parsing Updates
- Added bolt property fields to object representation
- `detectTeklaBoltProperties()` called during parsing
- Bolt information stored for statistics and export
- Objects marked as `isTeklaBolt` for filtering

#### Statistics Integration
- `is3DObjectWithDimensions()` updated to include bolt components
- Bolts counted in statistics even without traditional dimensions
- Can group by bolt properties in statistics table

---

## Code Changes Summary

### Modified Files
1. **src/objectExplorer.js**
   - Enhanced `enrichAssemblyFromHierarchy()` (~760 lines)
   - Added `detectTeklaBoltProperties()` (~130 lines)
   - Updated `parseObjectProperties()` (added bolt fields)
   - Enhanced UI display functions for bolt badges
   - Improved deduplication scoring

2. **src/steelStatistics.js**
   - Updated `is3DObjectWithDimensions()` to include bolts

### Key Functions

#### enrichAssemblyFromHierarchy()
```javascript
// 5-level strategy for assembly position assignment
// - IfcElementAssembly membership
// - Direct parent nodes
// - IFC class grouping
// - Object names
// - Secondary properties
```

#### detectTeklaBoltProperties()
```javascript
// Detects and extracts Tekla Bolt properties
// - Bolt type, size, grade
// - Washer information
// - Nut information
// - Tightening status
```

#### Updated Object Structure
```javascript
{
  // ... existing properties ...
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
  allBoltProperties: {},
}
```

---

## Testing Recommendations

1. **Assembly Grouping Tests:**
   - Load IFC file from Tekla
   - Group by "Assembly Pos"
   - Verify no objects in "(Không xác định)" unless intentional
   - Check that all structural elements are properly grouped

2. **Tekla Bolt Detection Tests:**
   - Load IFC with various bolt types
   - Verify ⚙️ badges appear on bolt objects
   - Check tooltip shows bolt properties
   - Verify statistics count bolt components
   - Export to Excel and verify bolt data

3. **Performance Tests:**
   - Large IFC files (1000+ objects)
   - Multiple models in one workspace
   - Verify hierarchy traversal completes in reasonable time

---

## Migration Guide

No database or API changes required. The changes are backward compatible:
- Existing assembly grouping still works
- New bolt detection is additive
- Statistics automatically include bolt data
- No user configuration needed

## Logging

The code includes debug logging:
```
[ObjectExplorer] Enriched from hierarchy: X from IfcElementAssembly, Y from parent, Z from IFC class, ...
[ObjectExplorer] Deduplicated: X → Y objects
[ASM] Object NNN: assemblyPos = "..." (from "...")
```

Check browser console for detailed enrichment information.

---

## Future Improvements

1. **Advanced Bolt Properties:**
   - Surface treatment/coating
   - Head shape specification
   - Thread type/length

2. **Connection Assembly:**
   - Group related bolts/connections
   - Visualize connection relationships

3. **Export Enhancement:**
   - Dedicated bolt section in Excel export
   - BOM (Bill of Materials) generation for fasteners

4. **Statistics Dashboard:**
   - Separate fastener statistics
   - Cost calculations based on bolt types
   - Material composition analysis

---

## Support & Debugging

If objects still fall into "(Không xác định)":
1. Check browser console for enrichment logs
2. Verify IFC file has hierarchy information
3. Check object property sets contain expected names
4. Review object IFC class in tooltip

For bolt detection issues:
1. Verify property set names (should contain "tekla", "bolt", etc.)
2. Check property names for bolt keywords
3. Review object's rawProperties in console
4. Confirm object's IFC class is bolt-related
