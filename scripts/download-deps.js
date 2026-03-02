const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { createWriteStream } = require('fs');

const PLATFORM = process.platform;
const ARCH = process.arch;

if (PLATFORM !== 'darwin') {
  console.error('This script currently only supports macOS');
  process.exit(1);
}

const BIN_DIR = path.join(__dirname, '..', 'bin', `${PLATFORM}-${ARCH}`);
const LIB_DIR = path.join(BIN_DIR, 'lib');

// Ghostscript and all its runtime dependencies
const HOMEBREW_DEPS = [
  'ghostscript',
  'fontconfig',
  'freetype',
  'jbig2dec',
  'libidn',
  'libpng',
  'libtiff',
  'little-cms2',
  'openjpeg',
  'tesseract',
  'libarchive',
  'leptonica',
  // Transitive dependencies
  'expat',
  'gettext',
  'jpeg-turbo',
  'xz',
  'zstd',
  'lz4',
  'giflib',
  'webp',
  'libb2',
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function followRedirects(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { ...headers },
    };
    const request = https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        const redirectHeaders = new URL(redirectUrl).hostname === urlObj.hostname ? headers : {};
        followRedirects(redirectUrl, redirectHeaders).then(resolve).catch(reject);
      } else if (res.statusCode === 200) {
        resolve(res);
      } else {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
    });
    request.on('error', reject);
  });
}

function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    followRedirects(url, headers).then((res) => {
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
    }).catch(reject);
  });
}

async function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    followRedirects(url, headers).then((res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).catch(reject);
  });
}

function getAllDylibRefs(binary) {
  // Returns ALL non-system dylib references, including @@HOMEBREW_PREFIX@@ placeholders
  try {
    const output = run(`otool -L "${binary}"`);
    const deps = [];
    for (const line of output.split('\n').slice(1)) {
      const match = line.trim().match(/^(.+?)\s+\(/);
      if (match) {
        const libPath = match[1];
        // Skip only true system libraries
        if (libPath.startsWith('/usr/lib') || libPath.startsWith('/System')) {
          continue;
        }
        // Include @@HOMEBREW_PREFIX@@ paths and /opt/homebrew paths
        // Skip only @executable_path/@loader_path/@rpath (already rewritten)
        if (libPath.startsWith('@executable_path') || libPath.startsWith('@loader_path') || libPath.startsWith('@rpath')) {
          continue;
        }
        deps.push(libPath);
      }
    }
    return deps;
  } catch {
    return [];
  }
}

function getDylibDeps(binary) {
  return getAllDylibRefs(binary);
}

function fixDylibPaths(binaryPath) {
  const deps = getAllDylibRefs(binaryPath);
  for (const dep of deps) {
    const libName = path.basename(dep);
    const newPath = `@executable_path/lib/${libName}`;
    try {
      run(`install_name_tool -change "${dep}" "${newPath}" "${binaryPath}" 2>/dev/null || true`);
    } catch (e) {
      // Ignore errors
    }
  }
  if (binaryPath.endsWith('.dylib')) {
    const libName = path.basename(binaryPath);
    try {
      run(`install_name_tool -id "@executable_path/lib/${libName}" "${binaryPath}" 2>/dev/null || true`);
    } catch (e) {
      // Ignore errors
    }
  }
}

async function getGhcrToken(pkg) {
  const tokenData = await fetchJSON(
    `https://ghcr.io/token?scope=repository:homebrew/core/${pkg}:pull`
  );
  return tokenData.token;
}

async function downloadBrewBottle(formulaName, tmpDir) {
  console.log(`  Fetching ${formulaName} info...`);
  const formulaInfo = await fetchJSON(`https://formulae.brew.sh/api/formula/${formulaName}.json`);

  const bottles = formulaInfo.bottle.stable.files;
  let bottleTag = null;

  if (ARCH === 'arm64') {
    const arm64Tags = Object.keys(bottles).filter(t => t.startsWith('arm64'));
    if (arm64Tags.length > 0) bottleTag = arm64Tags[0];
  } else {
    const x64Tags = Object.keys(bottles).filter(t => !t.startsWith('arm64') && t !== 'all');
    if (x64Tags.length > 0) bottleTag = x64Tags[0];
  }

  // Fallback to 'all' if available
  if (!bottleTag && bottles['all']) {
    bottleTag = 'all';
  }

  if (!bottleTag) {
    console.warn(`  Warning: No bottle found for ${formulaName}, skipping`);
    return null;
  }

  const bottleUrl = bottles[bottleTag].url;
  const bottlePath = path.join(tmpDir, `${formulaName}.tar.gz`);

  console.log(`  Downloading ${formulaName} (${bottleTag})...`);
  const token = await getGhcrToken(formulaName);
  await downloadFile(bottleUrl, bottlePath, {
    Authorization: `Bearer ${token}`,
  });

  const extractDir = path.join(tmpDir, `${formulaName}-extracted`);
  ensureDir(extractDir);
  run(`tar xzf "${bottlePath}" -C "${extractDir}"`);

  return extractDir;
}

function findDylibs(dir) {
  const results = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.dylib')) {
        results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

async function downloadGhostscript() {
  console.log('\n=== Downloading Ghostscript & Dependencies ===');
  const gsBin = path.join(BIN_DIR, 'gs');
  if (fs.existsSync(gsBin)) {
    console.log('Ghostscript already exists, skipping (delete bin/ to re-download)');
    return;
  }

  ensureDir(BIN_DIR);
  ensureDir(LIB_DIR);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpdf-'));

  try {
    // Download all bottles
    const extractedDirs = {};
    for (const dep of HOMEBREW_DEPS) {
      try {
        extractedDirs[dep] = await downloadBrewBottle(dep, tmpDir);
      } catch (e) {
        console.warn(`  Warning: Failed to download ${dep}: ${e.message}`);
      }
    }

    // Find and copy the gs binary from the ghostscript bottle
    const gsExtracted = extractedDirs['ghostscript'];
    if (!gsExtracted) {
      throw new Error('Failed to download ghostscript bottle');
    }

    const gsDirs = fs.readdirSync(path.join(gsExtracted, 'ghostscript'));
    const gsVersion = gsDirs[0];
    const gsPrefix = path.join(gsExtracted, 'ghostscript', gsVersion);
    const extractedGs = path.join(gsPrefix, 'bin', 'gs');

    if (!fs.existsSync(extractedGs)) {
      throw new Error('Could not find gs binary in extracted bottle');
    }

    // Copy gs binary
    fs.copyFileSync(extractedGs, gsBin);
    fs.chmodSync(gsBin, 0o755);
    console.log(`\nCopied gs binary to ${gsBin}`);

    // Copy share directory (PostScript resources, ICC profiles)
    const shareDir = path.join(gsPrefix, 'share');
    if (fs.existsSync(shareDir)) {
      const destShare = path.join(BIN_DIR, 'share');
      run(`cp -R "${shareDir}" "${destShare}"`);
      console.log('Copied share/ resources');
    }

    // Copy all dylibs from all bottles
    console.log('\nCollecting dylibs from all packages...');
    const copiedLibs = new Set();

    for (const [depName, extractDir] of Object.entries(extractedDirs)) {
      if (!extractDir) continue;
      const dylibs = findDylibs(extractDir);
      for (const dylib of dylibs) {
        const libName = path.basename(dylib);
        // Skip symlinks that we'll handle separately
        const dest = path.join(LIB_DIR, libName);
        if (!copiedLibs.has(libName)) {
          try {
            // Check if it's a symlink
            const stat = fs.lstatSync(dylib);
            if (stat.isSymbolicLink()) {
              const target = fs.readlinkSync(dylib);
              // Create relative symlink
              if (!fs.existsSync(dest)) {
                fs.symlinkSync(target, dest);
                copiedLibs.add(libName);
              }
            } else {
              fs.copyFileSync(dylib, dest);
              fs.chmodSync(dest, 0o755);
              copiedLibs.add(libName);
            }
          } catch (e) {
            console.warn(`  Warning: Could not copy ${libName}: ${e.message}`);
          }
        }
      }
    }
    console.log(`Collected ${copiedLibs.size} dylibs`);

    // Also copy fontconfig config files
    for (const [depName, extractDir] of Object.entries(extractedDirs)) {
      if (!extractDir || depName !== 'fontconfig') continue;
      const dirs = fs.readdirSync(path.join(extractDir, 'fontconfig'));
      if (dirs.length > 0) {
        const fcPrefix = path.join(extractDir, 'fontconfig', dirs[0]);
        const fcEtc = path.join(fcPrefix, 'etc', 'fonts');
        if (fs.existsSync(fcEtc)) {
          const destEtc = path.join(BIN_DIR, 'etc', 'fonts');
          ensureDir(path.dirname(destEtc));
          run(`cp -R "${fcEtc}" "${destEtc}"`);
          console.log('Copied fontconfig config');
        }
        const fcShare = path.join(fcPrefix, 'share', 'fontconfig');
        if (fs.existsSync(fcShare)) {
          const destFcShare = path.join(BIN_DIR, 'share', 'fontconfig');
          ensureDir(path.dirname(destFcShare));
          run(`cp -R "${fcShare}" "${destFcShare}"`);
        }
      }
    }

    // Fix dylib paths in gs binary
    console.log('\nFixing dylib paths...');
    fixDylibPaths(gsBin);

    // Fix dylib paths in all copied dylibs
    const allLibs = fs.readdirSync(LIB_DIR);
    for (const lib of allLibs) {
      const libPath = path.join(LIB_DIR, lib);
      const stat = fs.lstatSync(libPath);
      if (!stat.isSymbolicLink() && lib.endsWith('.dylib')) {
        fixDylibPaths(libPath);
      }
    }

    // Re-sign all binaries with ad-hoc signature
    console.log('Re-signing binaries...');
    try {
      run(`codesign --force --sign - "${gsBin}" 2>/dev/null || true`);
      for (const lib of allLibs) {
        const libPath = path.join(LIB_DIR, lib);
        const stat = fs.lstatSync(libPath);
        if (!stat.isSymbolicLink() && lib.endsWith('.dylib')) {
          run(`codesign --force --sign - "${libPath}" 2>/dev/null || true`);
        }
      }
    } catch (e) {
      console.warn('Warning: Code signing failed (may still work)');
    }

    // Verify
    console.log('\nVerifying Ghostscript installation...');
    try {
      const env = `DYLD_LIBRARY_PATH="${LIB_DIR}"`;
      const version = run(`${env} "${gsBin}" --version`);
      console.log(`✓ Ghostscript ${version} installed successfully!`);
    } catch (e) {
      console.error('Warning: gs binary verification failed.');
      console.error(e.message);
      console.error('Trying with DYLD_FALLBACK_LIBRARY_PATH...');
      try {
        const env = `DYLD_FALLBACK_LIBRARY_PATH="${LIB_DIR}"`;
        const version = run(`${env} "${gsBin}" --version`);
        console.log(`✓ Ghostscript ${version} installed successfully (with fallback path)!`);
      } catch (e2) {
        console.error('Binary could not run. The app may still work with proper env setup.');
      }
    }

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`Platform: ${PLATFORM}, Arch: ${ARCH}`);
  console.log(`Binary directory: ${BIN_DIR}`);
  await downloadGhostscript();
  console.log('\n=== Setup complete ===');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
