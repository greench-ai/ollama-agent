import { rm } from "node:fs/promises";
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

await rm("dist-electron", { recursive: true, force: true });

await build({
  ...common,
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
});

await build({
  ...common,
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
});

console.log("electron bundles written to dist-electron/");
