import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["ah.ts"],
  outDir: "dist",
  clean: false,
  dts: false,
  outExtensions: () => ({ js: ".js" }),
  // vite only builds the client bundles when running from source; the
  // package ships them prebuilt. ws's native speedups are optional. node-pty
  // is native, so it's a real dependency. Everything else is a dev
  // dependency, bundled in, except skepsis, which finds its page's files
  // next to its own
  deps: {
    neverBundle: [
      "vite",
      "bufferutil",
      "utf-8-validate",
      "@lydell/node-pty",
      "@oxide/skepsis",
    ],
    onlyBundle: false,
  },
})
