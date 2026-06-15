// Remove chrome-sandbox from Linux packages to avoid SUID sandbox errors
const fs = require('fs');
const path = require('path');

exports.default = async function (context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'linux') return;
  
  const sandboxPath = path.join(appOutDir, 'chrome-sandbox');
  if (fs.existsSync(sandboxPath)) {
    fs.unlinkSync(sandboxPath);
    console.log('  • removed chrome-sandbox from Linux package');
  }
};
