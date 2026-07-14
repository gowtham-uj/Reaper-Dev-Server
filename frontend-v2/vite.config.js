import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const backendUrl = (process.env.REAPER_DEV_BACKEND_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const deployBase = process.env.REAPER_V2_BASE || "/";

export default defineConfig({
  base: deployBase,
  plugins: [solid()],
  server: {
    host: "0.0.0.0",
    port: 5174,
    proxy: {
      "/api": { target: backendUrl, changeOrigin: true, secure: false, ws: true },
      "/terminal/ws": { target: backendUrl, changeOrigin: true, secure: false, ws: true }
    }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
