import { defineConfig } from "vite";

export default defineConfig({
  base: "/TC-Object-Explorer/",
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
