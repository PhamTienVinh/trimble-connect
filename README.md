# TC Object Explorer — Trimble Connect 3D Extension

Trimble Connect 3D Extension giúp tìm kiếm, lọc và highlight đối tượng trong 3D view, đồng thời thống kê thể tích & khối lượng thép và xuất Excel.

## ✨ Tính năng

### 🔍 Tìm kiếm & Highlight
- Tìm kiếm theo **tên đối tượng**, **assembly**, **loại cấu kiện**
- Highlight kết quả khớp trong danh sách
- **Select / Isolate / Reset** objects trong 3D Viewer
- Zoom đến cấu kiện cụ thể với nút highlight

### 📊 Thống kê thép & Xuất Excel
- Tự động phát hiện cấu kiện thép (theo material/type)
- Tính toán **thể tích (m³)** và **khối lượng (kg)** (`volume × density`)
- Bảng thống kê sortable + summary cards
- **Xuất Excel** 3 sheet: Chi tiết | Assembly | Loại cấu kiện
- Tùy chỉnh khối lượng riêng thép (mặc định 7850 kg/m³)

## 🚀 Demo nhanh

Mở file **`preview.html`** trực tiếp trong trình duyệt — chạy ngay không cần cài đặt, có 20 demo objects sẵn.

## 📦 Cài đặt & Chạy (Development)

```bash
npm install
npm run dev
```

Mở `http://localhost:3000`

## 🏗️ Build & Deploy

```bash
npm run build      # Output → dist/
```

### Deploy lên Trimble Connect

1. Host thư mục `dist/` lên **Netlify / Vercel / GitHub Pages**
2. Cập nhật URL trong `manifest.json`:
   ```json
   { "entry": "https://your-domain.com/index.html" }
   ```
3. Trong Trimble Connect: **Project Settings → Extensions → Add Extension**
4. Nhập URL manifest → Lưu → Mở 3D Viewer

## 🛠️ Tech Stack

- **Vite** — Build tool
- **trimble-connect-workspace-api** — Trimble Connect API
- **SheetJS (xlsx)** — Excel export
- **Vanilla JS + CSS** — No framework dependency

## 📁 Cấu trúc

```
├── index.html          ← Entry point
├── preview.html        ← Standalone demo
├── manifest.json       ← TC Extension manifest
├── package.json
├── vite.config.js
└── src/
    ├── main.js             ← API connection + tabs
    ├── objectExplorer.js   ← Search/Filter/Highlight
    ├── steelStatistics.js  ← Statistics + Export
    ├── excelExport.js      ← Excel utility
    └── styles.css          ← Dark theme
```

## 📄 License

MIT
