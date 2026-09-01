import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // The entry point awaits the menu before it can build a world, and
    // top-level await needs a modern target. The game already requires Pointer
    // Events and a current Canvas2D, so nothing older could run it anyway.
    target: "es2022",
  },
  server: {
    // Honour an externally assigned port so the dev server can coexist with
    // whatever else is already holding Vite's default.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
  },
});
