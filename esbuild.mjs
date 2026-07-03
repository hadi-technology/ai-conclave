// esbuild bundle config for the Conclave extension.
// Bundles src/extension.ts -> dist/extension.js, with "vscode" external
// (provided by the extension host at runtime). Targets Node (the extension host).
import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** The extension host bundle (Node, "vscode" external). */
/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info"
};

/** The webview bundle (browser, no Node/vscode). Kept SEPARATE from the
 *  extension bundle and loaded in the sandboxed webview via a nonce'd script. */
/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ["src/webview/app.ts"],
  bundle: true,
  outfile: "dist/webview/app.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  logLevel: "info"
};

if (watch) {
  const ext = await esbuild.context(extensionOptions);
  const web = await esbuild.context(webviewOptions);
  await Promise.all([ext.watch(), web.watch()]);
  console.log("[esbuild] watching (extension + webview)…");
} else {
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
  console.log("[esbuild] build complete (extension + webview)");
}
