import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths, so the build works wherever it is served from,
  // including GitHub Pages under /War/.
  base: "./",
  build: {
    // The game requires Pointer Events and a current Canvas2D, so nothing
    // older than es2022 could run it anyway.
    target: "es2022",
    rollupOptions: {
      input: {
        // The game.
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // The browser end-to-end harness (src/e2e/). Shipped alongside the
        // game so a browser can run it on the published site; nothing links
        // to it from the game.
        e2e: fileURLToPath(new URL("./e2e.html", import.meta.url)),
      },
    },
  },
  server: {
    // Honour an externally assigned port so the dev server can coexist with
    // whatever else is already holding Vite's default.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
  },
});
