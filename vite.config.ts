import { defineConfig } from "vite";

/** The page, built into `dist/public`, which `dist/cli.js` serves beside the API. */
export default defineConfig({
  root: "src/ui",
  build: { target: "es2023", outDir: "../../dist/public", emptyOutDir: true },
});
