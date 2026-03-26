import { defineConfig } from "vite";

export default defineConfig({
  base: "/trimble-connect/",
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
