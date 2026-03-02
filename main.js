const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mammoth = require('mammoth');
const { mergePdfs, compressPdf, getGsInfo } = require('./src/ghostscript');

let mainWindow;

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png');

  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    icon: iconPath,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('src/index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, 'icon.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(iconPath);
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Convert a DOCX file to PDF using mammoth (DOCX→HTML) + Electron printToPDF
 */
async function docxToPdf(docxPath, outputPath) {
  const result = await mammoth.convertToHtml({ path: docxPath });
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; line-height: 1.6; color: #333; font-size: 12pt; }
  h1 { font-size: 24pt; margin-top: 24pt; }
  h2 { font-size: 18pt; margin-top: 18pt; }
  h3 { font-size: 14pt; margin-top: 14pt; }
  table { border-collapse: collapse; width: 100%; margin: 12pt 0; }
  td, th { border: 1px solid #ccc; padding: 6pt 8pt; }
  th { background: #f5f5f5; font-weight: bold; }
  img { max-width: 100%; }
  p { margin: 6pt 0; }
  ul, ol { margin: 6pt 0; padding-left: 24pt; }
</style>
</head>
<body>${result.value}</body>
</html>`;

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { offscreen: true },
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdfData = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
    });
    fs.writeFileSync(outputPath, pdfData);
  } finally {
    win.destroy();
  }

  return outputPath;
}

/**
 * Preprocess files: convert any .docx files to temporary PDFs.
 * Returns { processedFiles, tmpDir } where processedFiles replaces .docx paths with temp PDF paths.
 */
async function preprocessFiles(inputFiles, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packpdf-docx-'));
  const processedFiles = [];

  for (let i = 0; i < inputFiles.length; i++) {
    const filePath = inputFiles[i];
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.docx') {
      if (onProgress) {
        onProgress({
          stage: 'converting-docx',
          current: i + 1,
          total: inputFiles.length,
          file: path.basename(filePath),
        });
      }
      const baseName = path.basename(filePath, ext);
      const tmpPdf = path.join(tmpDir, `${baseName}_${Date.now()}.pdf`);
      await docxToPdf(filePath, tmpPdf);
      processedFiles.push(tmpPdf);
    } else {
      processedFiles.push(filePath);
    }
  }

  return { processedFiles, tmpDir };
}

// IPC: Select files
ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported Files', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'gif', 'docx'] },
      { name: 'PDF Files', extensions: ['pdf'] },
      { name: 'Image Files', extensions: ['jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp', 'gif'] },
      { name: 'Word Documents', extensions: ['docx'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled) return [];

  return result.filePaths.map((filePath) => ({
    path: filePath,
    name: path.basename(filePath),
    size: fs.statSync(filePath).size,
    ext: path.extname(filePath).toLowerCase(),
  }));
});

// IPC: Merge PDFs
ipcMain.handle('merge-pdfs', async (event, { files }) => {
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Merged PDF',
    defaultPath: path.join(app.getPath('downloads'), 'merged.pdf'),
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });

  if (saveResult.canceled) return { canceled: true };

  const outputPath = saveResult.filePath;
  const rawFiles = files.map((f) => f.path);
  let docxTmpDir = null;

  try {
    // Preprocess: convert .docx files to temp PDFs
    const { processedFiles: inputFiles, tmpDir } = await preprocessFiles(rawFiles, (progress) => {
      mainWindow.webContents.send('operation-progress', progress);
    });
    docxTmpDir = tmpDir;

    await mergePdfs(inputFiles, outputPath, (progress) => {
      mainWindow.webContents.send('operation-progress', progress);
    });

    const stats = fs.statSync(outputPath);
    return {
      success: true,
      outputPath,
      outputSize: stats.size,
    };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (docxTmpDir) {
      fs.rmSync(docxTmpDir, { recursive: true, force: true });
    }
  }
});

// IPC: Compress PDF
ipcMain.handle('compress-pdf', async (event, { files, quality }) => {
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Compressed PDF',
    defaultPath: path.join(app.getPath('downloads'), 'compressed.pdf'),
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });

  if (saveResult.canceled) return { canceled: true };

  const outputPath = saveResult.filePath;
  const rawFiles = files.map((f) => f.path);

  // Calculate original total size
  const originalSize = rawFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  let docxTmpDir = null;

  try {
    // Preprocess: convert .docx files to temp PDFs
    const { processedFiles: inputFiles, tmpDir } = await preprocessFiles(rawFiles, (progress) => {
      mainWindow.webContents.send('operation-progress', progress);
    });
    docxTmpDir = tmpDir;

    await compressPdf(inputFiles, outputPath, quality, (progress) => {
      mainWindow.webContents.send('operation-progress', progress);
    });

    const stats = fs.statSync(outputPath);
    return {
      success: true,
      outputPath,
      outputSize: stats.size,
      originalSize,
      ratio: ((1 - stats.size / originalSize) * 100).toFixed(1),
    };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    if (docxTmpDir) {
      fs.rmSync(docxTmpDir, { recursive: true, force: true });
    }
  }
});

// IPC: Open file in Finder
ipcMain.handle('open-file', async (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// IPC: Get Ghostscript info
ipcMain.handle('get-gs-info', async () => {
  return getGsInfo();
});
