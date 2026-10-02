import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Everything inlines into one HTML so the built viewer works from GitHub Pages
// and from file:// alike — a profile can be read on a disconnected machine.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "../docs/viewer",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
