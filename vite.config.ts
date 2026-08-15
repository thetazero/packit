import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { execSync } from "node:child_process";
import { version } from "./package.json";

function buildVersion(): string {
  let hash = "dev";
  try {
    hash = execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    // not a git checkout (e.g. tarball build) — keep "dev"
  }
  const date = new Date().toISOString().slice(0, 10);
  return `v${version} · ${hash} · ${date}`;
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion()),
  },
  // Served from https://thetazero.github.io/packit/
  base: "/packit/",
  server: {
    host: true,
  },
  plugins: [
    // Self-signed HTTPS in dev so phones on the LAN can use the camera
    // (getUserMedia requires a secure context).
    basicSsl(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Fountain Transfer",
        short_name: "Fountain",
        description:
          "Air-gapped file transfer between machines via camera and QR codes, powered by fountain codes.",
        theme_color: "#0b1020",
        background_color: "#0b1020",
        display: "standalone",
        start_url: "/packit/",
        scope: "/packit/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,wasm,webmanifest}"],
        // The wasm codec pushes the bundle past workbox's 2 MiB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: "index.html",
      },
    }),
  ],
});
