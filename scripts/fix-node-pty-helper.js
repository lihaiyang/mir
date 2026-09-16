// node-pty runs its `spawn-helper` executable via posix_spawnp. The prebuilt
// binaries published on npm store that helper WITHOUT the executable bit, so a
// package built from a plain `npm ci` — no local compile — ships a helper that
// cannot be spawned and every `pty:create` fails with:
//
//     Error: posix_spawnp failed.
//       at new UnixTerminal (.../node_modules/node-pty/lib/unixTerminal.js:92:24)
//
// `electron-rebuild` used to mask this by compiling `build/Release/spawn-helper`
// from source with a correct mode, and node-pty prefers `build/Release` over
// `prebuilds/<platform>-<arch>` when loading. Now that the rebuild step is gone,
// both copies must be fixed explicitly:
//
//   * `postinstall` → the copy in node_modules (dev mode)
//   * electron-builder `afterPack` → the copy inside the packaged app, which
//     lives under `Resources/app.asar.unpacked/node_modules/node-pty`
//
// Usage: node scripts/fix-node-pty-helper.js [rootDir]
//   With no argument the root defaults to the project directory. afterPack
//   passes the packaged `Resources` directory instead.

const fs = require('fs')
const path = require('path')

/** How deep to look for a `node-pty` directory when the usual paths don't hit. */
const MAX_DEPTH = 6

/** Recursively collect every file named `spawn-helper` under `dir`. */
function findHelpers(dir, found = [], depth = 0) {
  if (depth > MAX_DEPTH) return found
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      findHelpers(full, found, depth + 1)
    } else if (entry.name === 'spawn-helper') {
      found.push(full)
    }
  }
  return found
}

/** Find every `node-pty` package directory under `root`. */
function findNodePtyDirs(root) {
  const direct = [
    // node_modules layout (dev)
    path.join(root, 'node_modules', 'node-pty'),
    // afterPack layout: resources/app.asar.unpacked/node_modules/node-pty
    path.join(root, 'app.asar.unpacked', 'node_modules', 'node-pty'),
    // already inside node_modules
    path.join(root, 'node-pty')
  ]
  const hits = direct.filter(p => fs.existsSync(path.join(p, 'package.json')))
  if (hits.length) return hits

  // Fall back to a bounded search for a directory literally named `node-pty`.
  const found = []
  ;(function walk(dir, depth) {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === 'node-pty' && fs.existsSync(path.join(full, 'package.json'))) {
        found.push(full)
        continue
      }
      walk(full, depth + 1)
    }
  })(root, 0)
  return found
}

/**
 * Make every node-pty spawn-helper under `root` executable.
 * @param {string} root directory to search (project dir, node_modules, or Resources)
 * @returns {{ fixed: string[], checked: number }} paths changed and total helpers seen
 */
function fixHelpers(root) {
  const dirs = findNodePtyDirs(root)
  const helpers = dirs.flatMap(d => findHelpers(d))
  const fixed = []
  for (const helper of helpers) {
    try {
      const mode = fs.statSync(helper).mode & 0o777
      // Only touch the execute bits — never widen read/write beyond what the
      // file already had.
      const next = mode | 0o111
      if (next !== mode) {
        fs.chmodSync(helper, next)
        fixed.push(helper)
      }
    } catch (e) {
      console.warn(`[node-pty] could not chmod ${helper}: ${e.message}`)
    }
  }
  return { fixed, checked: helpers.length }
}

module.exports = { fixHelpers, findHelpers, findNodePtyDirs }

if (require.main === module) {
  const root = process.argv[2] || path.join(__dirname, '..')
  const { fixed, checked } = fixHelpers(root)
  for (const f of fixed) console.log(`[node-pty] +x ${path.relative(process.cwd(), f)}`)
  // Windows has no spawn-helper (node-pty uses conpty there), so silence is
  // correct on win32; anywhere else it means the packaging step lost node-pty.
  if (!checked && process.platform !== 'win32') {
    console.warn(`[node-pty] no spawn-helper found under ${root}`)
  }
}
