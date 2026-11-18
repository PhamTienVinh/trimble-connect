import { defineConfig } from "vite";

export default defineConfig({
  base: './',
  resolve: {
    preserveSymlinks: true,
  },
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
