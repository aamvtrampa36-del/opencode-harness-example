import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      // effect, which OpenCode is built on, ships the Scalar API reference
      // UI as one script that Vite's import analysis cannot parse. OpenCode
      // never serves it here, so it is stubbed out.
      name: "empty-httpapi-scalar",
      enforce: "pre",
      load: (id) =>
        id.includes("/effect/dist/unstable/httpapi/internal/httpApiScalar.js")
          ? 'export const javascript = "";'
          : null
    },
    agents(),
    react(),
    cloudflare({
      config: (worker) => {
        // CI has no Cloudflare token. Disable remote-only bindings for the
        // local runtime smoke test; production and dev remain unchanged.
        if (process.env.CI_LOCAL_SMOKE === "1") {
          delete worker.ai;
          delete worker.worker_loaders;
        }
      }
    }),
    tailwindcss()
  ],
  resolve: {
    // One React for the app and the workspace packages it imports.
    dedupe: ["react", "react-dom"]
  }
});
