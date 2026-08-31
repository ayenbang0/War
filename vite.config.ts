import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Honour an externally assigned port so the dev server can coexist with
    // whatever else is already holding Vite's default.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
  },
});
