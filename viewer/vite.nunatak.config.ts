import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: {
    port: 5180,
    proxy: { "/api": "http://127.0.0.1:7766" },
  },
  build: {
    outDir: "../nunatak/web",
    emptyOutDir: true,
    rollupOptions: { input: "nunatak.html" },
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
