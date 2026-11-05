import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const COORDINATOR = process.env.SWITCHYARD_DEV_COORDINATOR ?? "http://127.0.0.1:7400";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: "script-defer",
      // globPatterns already precaches public/ icons; avoid duplicate entries.
      includeManifestIcons: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
      manifest: {
        name: "Switchyard",
        short_name: "Switchyard",
        description: "Pi coding sessions, tasks and automations across your hosts",
        display: "standalone",
        start_url: "/",
        scope: "/",
        theme_color: "#f8fafc",
        background_color: "#f8fafc",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    proxy: {
      "/api": { target: COORDINATOR, changeOrigin: false },
      "/ws": { target: COORDINATOR, ws: true, changeOrigin: false },
      "/adapter-frames": { target: COORDINATOR, changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
