import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: ["es2021", "chrome100", "safari13"],
    cssCodeSplit: false,
    modulePreload: false,
  },
  server: {
    port: 1420,
    strictPort: false,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_"],
  clearScreen: false,
});
