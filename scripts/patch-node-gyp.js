// Patch @electron/node-gyp's execFile to raise maxBuffer.
//
// On the windows-2022/latest runners GitHub now ships a VS2026 image whose
// PowerShell vswhere output exceeds node-gyp's default 1MB maxBuffer, throwing
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER and breaking electron-rebuild of native
// modules (node-pty). Bumping maxBuffer lets detection succeed.
//
// Run after `npm ci` in CI only.
const fs = require("fs");

const target = require.resolve("@electron/node-gyp/lib/util.js");
let src = fs.readFileSync(target, "utf8");

const needle = "cp.execFile(...args, (...a) => resolve(a))";
const replacement = "cp.execFile(...args, { maxBuffer: 50 * 1024 * 1024 }, (...a) => resolve(a))";

if (src.includes(replacement)) {
  console.log("patch-node-gyp: already patched, skipping");
} else if (src.includes(needle)) {
  src = src.replace(needle, replacement);
  fs.writeFileSync(target, src);
  console.log("patch-node-gyp: raised execFile maxBuffer to 50MB in " + target);
} else {
  console.error("patch-node-gyp: could not find execFile call to patch in " + target);
  process.exit(1);
}
