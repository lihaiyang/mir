// Patch @electron/node-gyp's execFile to raise maxBuffer.
//
// On the windows-2022/latest runners GitHub now ships a VS2026 image whose
// PowerShell vswhere output exceeds node-gyp's default 1MB maxBuffer, throwing
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER and breaking electron-rebuild of native
// modules (node-pty). Merge a large maxBuffer into the options object rather
// than inserting a new positional argument (which shifts the callback and
// throws ERR_INVALID_ARG_TYPE).
//
// Run after `npm ci` in CI only.
const fs = require("fs");

const target = require.resolve("@electron/node-gyp/lib/util.js");
let src = fs.readFileSync(target, "utf8");

const marker = "/* patch-node-gyp applied */";
if (src.includes(marker)) {
  console.log("patch-node-gyp: already patched, skipping");
  process.exit(0);
}

const original =
  "const execFile = async (...args) => new Promise((resolve) => {\n" +
  "  const child = cp.execFile(...args, (...a) => resolve(a))\n" +
  "  child.stdin.end()\n" +
  "})";

// node: cp.execFile(file[, args][, options][, callback]).
// Normalize the spread args, inject maxBuffer into options, then dispatch.
const replacement =
  "const execFile = async (file, ...rest) => new Promise((resolve) => {\n" +
  "  let cmdArgs, opts, cb\n" +
  "  for (const a of rest) {\n" +
  "    if (Array.isArray(a)) cmdArgs = a\n" +
  "    else if (typeof a === 'function') cb = a\n" +
  "    else if (a && typeof a === 'object') opts = a\n" +
  "  }\n" +
  "  opts = Object.assign({ maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' }, opts || {})\n" +
  "  const callback = (...r) => resolve(r)\n" +
  "  const child = cmdArgs\n" +
  "    ? cp.execFile(file, cmdArgs, opts, callback)\n" +
  "    : cp.execFile(file, opts, callback)\n" +
  "  child.stdin.end()\n" +
  "})";

if (!src.includes(original)) {
  console.error("patch-node-gyp: could not find execFile block to patch in " + target);
  process.exit(1);
}

src = src.replace(original, marker + "\n" + replacement);
fs.writeFileSync(target, src);
console.log("patch-node-gyp: merged maxBuffer into execFile options in " + target);
