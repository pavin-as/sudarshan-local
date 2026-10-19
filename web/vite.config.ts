import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs separately (npm run dev in server/); in production the API server serves dist/.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8484" } },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});
