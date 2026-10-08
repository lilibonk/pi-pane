import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  // Grammars are lazy chunks; only the C++ one exceeds the default warning size.
  build: { outDir: "web-dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 1024 },
});
