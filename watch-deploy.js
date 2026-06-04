import fs from 'fs';
import { exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let timeoutId = null;
let isRunning = false;
let pendingTrigger = false;

console.log("==================================================================");
console.log("🚀 BẮT ĐẦU TOOL TỰ ĐỘNG THEO DÕI THAY ĐỔI - BUILD - PUSH GITHUB 🚀");
console.log("==================================================================");
console.log("📁 Thư mục đang theo dõi: src/, index.html, manifest.json");
console.log("💡 Hướng dẫn: Mỗi khi bạn lưu file, tool sẽ tự động build và push lên GitHub.");
console.log("------------------------------------------------------------------");

function triggerDeploy() {
  if (isRunning) {
    pendingTrigger = true;
    return;
  }
  
  isRunning = true;
  pendingTrigger = false;
  
  const timeString = new Date().toLocaleTimeString();
  console.log(`\n[${timeString}] 🔍 Phát hiện thay đổi. Đang xử lý...`);
  
  console.log("🔨 1. Đang chạy lệnh build (npm run build)...");
  
  // Chạy npm run build qua cmd.exe để đảm bảo hoạt động tốt trên Windows
  exec('npm run build', { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      console.error("❌ Lỗi trong quá trình build project:");
      console.error(stdout || stderr || err.message);
      isRunning = false;
      return;
    }
    
    console.log("✅ Build thành công!");
    console.log("🚀 2. Đang tự động commit và push lên GitHub...");
    
    const timestamp = new Date().toLocaleString('vi-VN');
    const commitMsg = `Auto-deploy: ${timestamp}`;
    
    // Thực hiện git commit và push
    exec(`git add . && git commit -m "${commitMsg}" && git push origin main`, { cwd: __dirname }, (gitErr, gitStdout, gitStderr) => {
      if (gitErr) {
        console.error("❌ Lỗi khi tương tác với Git/GitHub:");
        console.error(gitStdout || gitStderr || gitErr.message);
      } else {
        console.log("✅ Đã push mã nguồn và bản build lên GitHub thành công!");
        console.log("✨ GitHub Actions đang deploy lên GitHub Pages...");
        console.log("🌐 Link Extension: https://phamtienvinh.github.io/trimble-connect/");
        console.log("⏳ Vui lòng đợi khoảng 1 phút để trang web cập nhật hoàn tất.");
      }
      
      isRunning = false;
      // Nếu có thay đổi khác phát sinh trong quá trình deploy, chạy tiếp
      if (pendingTrigger) {
        console.log("🔄 Phát hiện thay đổi mới tích lũy. Đang chạy lại luồng deploy...");
        triggerDeploy();
      }
    });
  });
}

function onChange(eventType, filename) {
  if (!filename) return;
  
  // Bỏ qua các file và thư mục không liên quan
  const isIgnored = filename.includes('dist') || 
                    filename.includes('node_modules') || 
                    filename.includes('.git') || 
                    filename.includes('watch-deploy.js') ||
                    filename.includes('package-lock.json');
                    
  if (isIgnored) return;
  
  clearTimeout(timeoutId);
  // Debounce 1.5 giây để tránh build liên tục khi lưu nhiều file cùng lúc
  timeoutId = setTimeout(triggerDeploy, 1500);
}

// Theo dõi thư mục src
const srcPath = path.join(__dirname, 'src');
if (fs.existsSync(srcPath)) {
  fs.watch(srcPath, { recursive: true }, onChange);
}

// Theo dõi index.html và manifest.json
const indexPath = path.join(__dirname, 'index.html');
if (fs.existsSync(indexPath)) {
  fs.watch(indexPath, onChange);
}

const manifestPath = path.join(__dirname, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  fs.watch(manifestPath, onChange);
}
