// electron-builder afterPack hook.
//
// Runs once the app directory is assembled but BEFORE the dmg/zip artifacts are
// built, so anything changed here ends up inside the shipped packages.

const fs = require('fs')
const path = require('path')
const { fixHelpers } = require('./fix-node-pty-helper')

/** Locate the `Resources` directory of the packed app for the current platform. */
function resolveResourcesDir(context) {
  const { appOutDir, electronPlatformName, packager } = context
  if (electronPlatformName === 'darwin') {
    const appName = packager?.appInfo?.productFilename
    const candidates = []
    if (appName) candidates.push(path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources'))
    // Fall back to whatever .app is actually there — the product name and the
    // bundle name can drift (dev vs stable channel, test builds, …).
    try {
      for (const entry of fs.readdirSync(appOutDir)) {
        if (entry.endsWith('.app')) {
          candidates.push(path.join(appOutDir, entry, 'Contents', 'Resources'))
        }
      }
    } catch {}
    return candidates.find(p => fs.existsSync(p)) || null
  }
  const resources = path.join(appOutDir, 'resources')
  return fs.existsSync(resources) ? resources : null
}

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context

  // Restore the executable bit on node-pty's spawn-helper. The npm tarball ships
  // it mode 0644, and without the rebuild step nothing compiles a corrected copy,
  // so every terminal would fail with "posix_spawnp failed" at runtime.
  const resources = resolveResourcesDir(context)
  if (!resources) {
    throw new Error(`could not locate Resources dir under ${appOutDir}`)
  }

  // Only POSIX builds use spawn-helper; Windows goes through conpty instead, so
  // an absent helper there is expected rather than a packaging failure.
  const needsHelper = electronPlatformName === 'darwin' || electronPlatformName === 'linux'
  const { fixed, checked } = fixHelpers(resources)
  for (const f of fixed) {
    console.log(`  • +x ${path.relative(appOutDir, f)}`)
  }
  if (checked === 0) {
    if (needsHelper) {
      // Not fatal on its own, but it means no terminal will work in this build.
      throw new Error(
        `node-pty spawn-helper not found under ${resources} — the packaged app would fail every pty:create with "posix_spawnp failed"`
      )
    }
  } else if (!fixed.length) {
    console.log(`  • node-pty spawn-helper already executable (${checked} checked)`)
  }

  // Linux: remove chrome-sandbox to avoid SUID sandbox errors
  if (electronPlatformName === 'linux') {
    const sandboxPath = path.join(appOutDir, 'chrome-sandbox')
    if (fs.existsSync(sandboxPath)) {
      fs.unlinkSync(sandboxPath)
      console.log('  • removed chrome-sandbox from Linux package')
    }
  }
}
