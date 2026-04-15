#!/usr/bin/env node
# 🚀 QUICK START GUIDE - Assembly Container Detection

## 📌 Acesso Rápido

### 1. **Arquivo Principal**
```
src/objectExplorer.js → Todas as funções implementadas aqui
```

### 2. **Documentação**
```
FINAL_SUMMARY.md ..................... Resumo completo (COMECE AQUI!)
ASSEMBLY_CONTAINER_IMPROVEMENTS.md ... Guia detalhado com exemplos
ASSEMBLY_IMPLEMENTATION_DETAILS.md ... Detalhes técnicos
CHANGES_SUMMARY.md ................... Resumo das mudanças
QUICK_REFERENCE.md .................. Este arquivo
```

---

## 💻 Como Usar

### Cenário 1: Descobrir qual container pertence a um objeto

**No Console Browser (F12):**
```javascript
// Selecione um objeto na árvore e execute:
window._debugAssemblyContainers();

// Você verá:
// ✓ ID do objeto selecionado
// ✓ ID do container pai
// ✓ ASSEMBLY_POS, NAME, CODE
// ✓ Objetos irmãos no mesmo container
```

**No Código:**
```javascript
import { getAssemblyContainerForObject } from './objectExplorer.js';

const container = getAssemblyContainerForObject(myObject);
console.log(`Container: ${container.assemblyPos}`);
```

---

### Cenário 2: Listar todos os containers & suas crianças

**No Console Browser:**
```javascript
window._debugAllContainers();

// Lista: ID | ASSEMBLY_POS | NAME | CODE | Qty Children | Exemplos de filhos
```

**No Código:**
```javascript
import { getAssemblyContainers } from './objectExplorer.js';

const containers = getAssemblyContainers();
for (const c of containers) {
  console.log(`${c.assemblyPos}: ${c.childCount} crianças`);
}
```

---

### Cenário 3: Pegar todas as crianças de um container

**No Console:**
```javascript
// Primeira, encontre o container ID
window._debugAllContainers();
// → Encontre algo como "B1 | Container ID: 123"

// Depois use:
window._debugContainerChildren("model-1", 123);
```

**No Código:**
```javascript
import { getAssemblyChildren } from './objectExplorer.js';

const children = getAssemblyChildren("model-1", 123);
for (const child of children) {
  console.log(`- ${child.name} | POS: ${child.assemblyPos}`);
}
```

---

### Cenário 4: Verificar se um objeto tem informações de assembly

**No Código:**
```javascript
import { getObjectAssemblyStatus } from './objectExplorer.js';

const status = getObjectAssemblyStatus(myObject);
// Retorna: "pos" | "name" | "code" | "all" | "none"

if (status === "none") {
  console.log("Objeto não tem informações de assembly!");
} else {
  console.log(`Status de assembly: ${status}`);
}
```

---

### Cenário 5: Obter estatísticas gerais

**No Código:**
```javascript
import { getAssemblyStatistics } from './objectExplorer.js';

const stats = getAssemblyStatistics();
console.log(`Total: ${stats.totalObjects} objetos`);
console.log(`Com POS: ${stats.objectsWithAssemblyPos}`);
console.log(`Containers: ${stats.totalAssemblyContainers}`);
```

---

## 📋 Referência de Todas as Funções

| Função | Input | Output | Uso |
|--------|-------|--------|-----|
| `getAssemblyContainerForObject(obj)` | Um objeto | Container info \| null | Descobrir container de um objeto |
| `getAssemblyChildren(modelId, id)` | Model ID + Container ID | Array de objetos | Listar crianças de um container |
| `getObjectAssemblyStatus(obj)` | Um objeto | "pos"\|"name"\|"code"\|"all"\|"none" | Verificar se tem assembly info |
| `getAssemblyContainers()` | Nenhum | Array de containers | Listar todos os containers |
| `getAssemblyStatistics()` | Nenhum | Objeto stats | Obter estatísticas |
| `logObjectAssemblyRelationship(obj)` | Um objeto | Console output | Imprimir relações |

---

## 🔧 Debug Functions (Console)

```javascript
// Mostrar informações do objeto selecionado
window._debugAssemblyContainers();

// Listar TODOS os containers com filhos amostrados
window._debugAllContainers();

// Ver TODAS as crianças de um container específico
window._debugContainerChildren("model-1", 123);
```

---

## 🎨 Visual Identify no Tree

Quando você vê um objeto como este:

```
"PLATE-1" (IfcPlate)
├─ B1 (ASSEMBLY_POS)
├─ CODE-B1 (ASSEMBLY_POSITION_CODE)  
└─ 🔗 B1 (Parent Container) ← NOVO!
```

O badge "🔗 B1" mostra qual container ele pertence.

---

## ⚡ Quick Copy-Paste Snippets

### Snippet 1: Log o container de um objeto
```javascript
const obj = selectedObjects[0];
const c = getAssemblyContainerForObject(obj);
console.log(`${obj.name} → Container: ${c?.assemblyPos}`);
```

### Snippet 2: Contar children por container
```javascript
const containers = getAssemblyContainers();
containers.forEach(c => {
  console.log(`${c.assemblyPos}: ${c.childCount} parts`);
});
```

### Snippet 3: Encontrar containers com mais de X crianças
```javascript
const containers = getAssemblyContainers();
const large = containers.filter(c => c.childCount > 5);
large.forEach(c => console.log(c.assemblyPos));
```

### Snippet 4: Exportar como CSV
```javascript
const containers = getAssemblyContainers();
let csv = "POS,Name,Code,ChildCount\n";
containers.forEach(c => {
  csv += `${c.assemblyPos},${c.assemblyName},${c.assemblyPosCode},${c.childCount}\n`;
});
console.log(csv);
```

---

## 🐛 Troubleshooting

### Problema: `getAssemblyContainerForObject()` retorna null

**Causa:** Objeto não está em um IfcElementAssembly container

**Solução:**
```javascript
// Verificar status
const status = getObjectAssemblyStatus(obj);
if (status === "none") {
  console.log("Objeto não tem assembly info");
}

// Log completo
logObjectAssemblyRelationship(obj);
```

### Problema: Container retorna 0 children

**Causa:** Container não tem crianças ou ID está errado

**Solução:**
```javascript
// Listar todos os containers
window._debugAllContainers();

// Verificar o ID correto
const containers = getAssemblyContainers();
const c = containers.find(x => x.assemblyPos === "B1");
console.log(`Container B1 ID: ${c.id}`);
```

### Problema: Debug function não aparece

**Causa:** objectExplorer.js não foi recarregado

**Solução:**
```javascript
// Hard refresh no browser
Ctrl + Shift + R  (ou Cmd + Shift + R no Mac)

// Ou verifique se objectExplorer carregou
console.log(typeof window._debugAssemblyContainers);
// Deve ser: function
```

---

## 📖 Próximos Passos

1. **Comece com:** `FINAL_SUMMARY.md`
2. **Depois leia:** `ASSEMBLY_CONTAINER_IMPROVEMENTS.md`
3. **Para detalhes técnicos:** `ASSEMBLY_IMPLEMENTATION_DETAILS.md`
4. **Use as funções:** Copie os snippets acima

---

## 🎯 Checklist de Uso

- [ ] Carregou modelo com IfcElementAssembly
- [ ] Clicou em um objeto na árvore
- [ ] Viu o badge "🔗 Container"
- [ ] Abriu o Console (F12)
- [ ] Executou `window._debugAssemblyContainers()`
- [ ] Viu o output com container info
- [ ] Chamou `getAssemblyChildren()` com um container ID
- [ ] Verificou que retornou os children corretos

---

## 🚀 Status

✅ Implementação Completa  
✅ Funções Públicas Exportadas  
✅ Debug Functions Disponíveis  
✅ Documentação Completa  
✅ Pronto para Produção  

---

**Última Atualização:** 2026-04-15  
**Versão:** 1.0  
**Suporte:** Veja as 4 documentações (MD) para assistência
