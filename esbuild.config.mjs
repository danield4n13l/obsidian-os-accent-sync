import esbuild from "esbuild";
import process from "process";
import fs from "fs";

const prod = process.argv[2] === "production";

function copyManifestPlugin() {
  return {
    name: "copy-manifest",
    setup(build) {
      build.onEnd(() => {
        if (!fs.existsSync("build")) {
          fs.mkdirSync("build", { recursive: true });
        }
        if (fs.existsSync("manifest.json")) {
          fs.copyFileSync("manifest.json", "build/manifest.json");
        }
        if (fs.existsSync("styles.css")) {
          fs.copyFileSync("styles.css", "build/styles.css");
        }
      });
    }
  };
}

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "child_process",
    "fs",
    "path",
    "os"
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "build/main.js",
  plugins: [copyManifestPlugin()]
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
