import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the bot under /v2 for side-by-side preview; /api calls are
// root-absolute so they hit the bot directly (no proxy needed in production).
export default defineConfig({
  base: "/v2/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
