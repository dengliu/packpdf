const path = require('path');
const fs = require('fs');

function getResourcesPath() {
  // In packaged app: process.resourcesPath points to Resources/
  // In dev: use the bin/ directory relative to project root
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'bin', 'gs'))) {
    return path.join(process.resourcesPath, 'bin');
  }
  // Dev mode: bin/<platform>-<arch>/
  const devBin = path.join(__dirname, '..', 'bin', `${process.platform}-${process.arch}`);
  if (fs.existsSync(path.join(devBin, 'gs'))) {
    return devBin;
  }
  return null;
}

function getGsPath() {
  const binDir = getResourcesPath();
  if (binDir) {
    return path.join(binDir, 'gs');
  }
  // Last resort: system gs
  return 'gs';
}

function getGsEnv() {
  const binDir = getResourcesPath();
  if (!binDir) return {};

  const env = {};
  // Set GS_LIB so Ghostscript can find its init files and resources
  const sharePaths = [];
  const shareGsDir = path.join(binDir, 'share', 'ghostscript');
  if (fs.existsSync(shareGsDir)) {
    const versions = fs.readdirSync(shareGsDir);
    for (const v of versions) {
      const resDir = path.join(shareGsDir, v, 'Resource');
      const libDir = path.join(shareGsDir, v, 'lib');
      if (fs.existsSync(resDir)) sharePaths.push(resDir);
      if (fs.existsSync(libDir)) sharePaths.push(libDir);
    }
  }
  const glibDir = path.join(binDir, 'glib');
  if (fs.existsSync(glibDir)) {
    sharePaths.push(glibDir);
  }

  if (sharePaths.length > 0) {
    env.GS_LIB = sharePaths.join(':');
  }

  // Set DYLD_LIBRARY_PATH for bundled dylibs
  const libDir = path.join(binDir, 'lib');
  if (fs.existsSync(libDir)) {
    env.DYLD_LIBRARY_PATH = libDir;
  }

  return env;
}

module.exports = { getGsPath, getGsEnv, getResourcesPath };
