import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Shiki and Cytoscape are loaded with dynamic `import()` by the components that need them,
// so the bundler emits them as separate lazy chunks automatically (no manual chunking).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // API_PROXY_TARGET lets a second API instance (another port) be used during development.
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4000" },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 900,
  },
});
