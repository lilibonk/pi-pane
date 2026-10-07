import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: { outDir: "web-dist", emptyOutDir: true, target: "es2022" },
});
