const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { getGsPath, getGsEnv } = require('./bin-paths');

class GhostscriptError extends Error {
  constructor(message, stderr) {
    super(message);
    this.name = 'GhostscriptError';
    this.stderr = stderr;
  }
}

function runGs(args, onProgress) {
  return new Promise((resolve, reject) => {
    const gsPath = getGsPath();
    const gsEnv = getGsEnv();

    const env = { ...process.env, ...gsEnv };
    const proc = spawn(gsPath, args, { env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (onProgress) {
        const text = data.toString();
        // Ghostscript outputs "Processing pages X through Y" or "Page X"
        const pageMatch = text.match(/Page (\d+)/);
        if (pageMatch) {
          onProgress({ page: parseInt(pageMatch[1]) });
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new GhostscriptError(
          `Ghostscript exited with code ${code}: ${stderr}`,
          stderr
        ));
      }
    });

    proc.on('error', (err) => {
      reject(new GhostscriptError(`Failed to start Ghostscript: ${err.message}`, ''));
    });
  });
}

/**
 * Parse JPEG to extract width, height, and number of color components.
 * Scans for SOF0 (0xFFC0) or SOF2 (0xFFC2) markers.
 */
function parseJpegDimensions(buf) {
  let offset = 0;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) {
    throw new Error('Not a valid JPEG file');
  }
  offset = 2;
  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xFF) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0 or SOF2 (baseline or progressive)
    if (marker === 0xC0 || marker === 0xC2) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      const components = buf[offset + 9];
      return { width, height, components };
    }
    // Skip marker segment
    if (marker === 0xD8 || marker === 0xD9) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    offset += 2 + segLen;
  }
  throw new Error('Could not find JPEG SOF marker');
}

/**
 * Parse PNG to extract width, height, bit depth, color type, and raw IDAT data.
 */
function parsePng(buf) {
  // PNG signature: 137 80 78 71 13 10 26 10
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
    throw new Error('Not a valid PNG file');
  }
  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatChunks = [];

  while (offset < buf.length) {
    const chunkLen = buf.readUInt32BE(offset);
    const chunkType = buf.slice(offset + 4, offset + 8).toString('ascii');
    const chunkData = buf.slice(offset + 8, offset + 8 + chunkLen);

    if (chunkType === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
    } else if (chunkType === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (chunkType === 'IEND') {
      break;
    }
    // 4 (length) + 4 (type) + chunkLen (data) + 4 (CRC)
    offset += 12 + chunkLen;
  }

  const compressedData = Buffer.concat(idatChunks);
  return { width, height, bitDepth, colorType, compressedData };
}

/**
 * Build a minimal PDF buffer containing a single image.
 * @param {object} opts
 * @param {number} opts.width - image width in pixels
 * @param {number} opts.height - image height in pixels
 * @param {string} opts.colorSpace - '/DeviceRGB', '/DeviceGray', or '/DeviceCMYK'
 * @param {number} opts.bitsPerComponent - typically 8
 * @param {string} opts.filter - '/DCTDecode' for JPEG, '/FlateDecode' for PNG
 * @param {Buffer} opts.imageData - raw stream data
 * @param {string} [opts.decodeParms] - optional DecodeParms dict string
 */
function buildImagePdf({ width, height, colorSpace, bitsPerComponent, filter, imageData, decodeParms }) {
  const objects = [];
  let objNum = 0;

  function addObj(content) {
    objNum++;
    objects.push({ num: objNum, content });
    return objNum;
  }

  // 1: Catalog
  const catalogNum = addObj('<< /Type /Catalog /Pages 2 0 R >>');
  // 2: Pages
  const pagesNum = addObj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  // 3: Page (placeholder, fill after we know image obj)
  const pageNum = addObj(null);
  // 4: Content stream
  const contentStream = `q\n${width} 0 0 ${height} 0 0 cm\n/Img Do\nQ\n`;
  const contentBuf = Buffer.from(contentStream, 'ascii');
  const contentNum = addObj(null); // placeholder
  // 5: Image XObject
  const imageNum = addObj(null); // placeholder

  // Build Page object
  objects[pageNum - 1].content =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
    `/Contents ${contentNum} 0 R /Resources << /XObject << /Img ${imageNum} 0 R >> >> >>`;

  // Now serialize the PDF
  const parts = [];
  const offsets = [];
  parts.push(Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'binary'));

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    offsets.push(Buffer.concat(parts).length);

    if (obj.num === contentNum) {
      // Content stream object
      const header = `${obj.num} 0 obj\n<< /Length ${contentBuf.length} >>\nstream\n`;
      const footer = `\nendstream\nendobj\n`;
      parts.push(Buffer.from(header, 'ascii'));
      parts.push(contentBuf);
      parts.push(Buffer.from(footer, 'ascii'));
    } else if (obj.num === imageNum) {
      // Image XObject stream
      let dictStr =
        `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace ${colorSpace} /BitsPerComponent ${bitsPerComponent} ` +
        `/Filter ${filter} /Length ${imageData.length}`;
      if (decodeParms) {
        dictStr += ` /DecodeParms ${decodeParms}`;
      }
      const header = `${obj.num} 0 obj\n<< ${dictStr} >>\nstream\n`;
      const footer = `\nendstream\nendobj\n`;
      parts.push(Buffer.from(header, 'ascii'));
      parts.push(imageData);
      parts.push(Buffer.from(footer, 'ascii'));
    } else {
      parts.push(Buffer.from(`${obj.num} 0 obj\n${obj.content}\nendobj\n`, 'ascii'));
    }
  }

  // Cross-reference table
  const xrefOffset = Buffer.concat(parts).length;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += `0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }

  // Trailer
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\n`;
  xref += `startxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'ascii'));

  return Buffer.concat(parts);
}

/**
 * Convert an image (JPG, PNG, etc.) to a single-page PDF.
 * For JPEG and PNG, generates the PDF directly in Node.js (no Ghostscript needed).
 * For other formats, falls back to Ghostscript.
 */
async function imageToPdf(imagePath, outputPath) {
  const ext = path.extname(imagePath).toLowerCase();
  const absImagePath = path.resolve(imagePath);
  const imageBuffer = fs.readFileSync(absImagePath);

  if (ext === '.jpg' || ext === '.jpeg') {
    // JPEG: embed raw bytes with DCTDecode — PDF natively supports JPEG
    const { width, height, components } = parseJpegDimensions(imageBuffer);
    const colorSpace = components === 1 ? '/DeviceGray' : '/DeviceRGB';
    const pdfBuf = buildImagePdf({
      width,
      height,
      colorSpace,
      bitsPerComponent: 8,
      filter: '/DCTDecode',
      imageData: imageBuffer,
    });
    fs.writeFileSync(outputPath, pdfBuf);
    return outputPath;
  }

  if (ext === '.png') {
    // PNG: decompress IDAT, strip filter bytes and alpha channel, re-deflate for FlateDecode
    const { width, height, bitDepth, colorType, compressedData } = parsePng(imageBuffer);
    const rawData = zlib.inflateSync(compressedData);

    // colorType: 0=Grayscale, 2=RGB, 4=GrayAlpha, 6=RGBA
    let channels;
    switch (colorType) {
      case 0: channels = 1; break;
      case 2: channels = 3; break;
      case 4: channels = 2; break;
      case 6: channels = 4; break;
      default: throw new Error(`Unsupported PNG colorType: ${colorType}`);
    }

    const hasAlpha = colorType === 4 || colorType === 6;
    const outputChannels = hasAlpha ? channels - 1 : channels;
    const bytesPerPixel = channels * (bitDepth / 8);
    const outputBytesPerPixel = outputChannels * (bitDepth / 8);

    // PNG raw data has a filter byte per row
    const rowBytes = width * bytesPerPixel;
    const filterStride = 1;

    // Reconstruct pixel data (apply PNG filters)
    const pixelData = Buffer.alloc(height * width * outputBytesPerPixel);
    const prevRow = Buffer.alloc(rowBytes);
    const curRow = Buffer.alloc(rowBytes);
    prevRow.fill(0);

    let srcOffset = 0;
    for (let y = 0; y < height; y++) {
      const filterType = rawData[srcOffset];
      srcOffset++;
      const scanlineData = rawData.slice(srcOffset, srcOffset + rowBytes);
      srcOffset += rowBytes;

      // Apply PNG filter to reconstruct row
      for (let x = 0; x < rowBytes; x++) {
        const raw = scanlineData[x];
        const a = x >= bytesPerPixel ? curRow[x - bytesPerPixel] : 0;
        const b = prevRow[x];
        const c = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;

        switch (filterType) {
          case 0: curRow[x] = raw; break;
          case 1: curRow[x] = (raw + a) & 0xFF; break;
          case 2: curRow[x] = (raw + b) & 0xFF; break;
          case 3: curRow[x] = (raw + ((a + b) >>> 1)) & 0xFF; break;
          case 4: {
            // Paeth predictor
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            curRow[x] = (raw + pr) & 0xFF;
            break;
          }
          default: curRow[x] = raw; break;
        }
      }

      // Copy pixel data, stripping alpha if present
      const destRowOffset = y * width * outputBytesPerPixel;
      for (let x = 0; x < width; x++) {
        const srcPx = x * bytesPerPixel;
        const dstPx = destRowOffset + x * outputBytesPerPixel;
        for (let ch = 0; ch < outputBytesPerPixel; ch++) {
          pixelData[dstPx + ch] = curRow[srcPx + ch];
        }
      }

      curRow.copy(prevRow);
    }

    const deflatedData = zlib.deflateSync(pixelData);
    let colorSpace;
    if (outputChannels === 1) colorSpace = '/DeviceGray';
    else if (outputChannels === 3) colorSpace = '/DeviceRGB';
    else colorSpace = '/DeviceRGB';

    const pdfBuf = buildImagePdf({
      width,
      height,
      colorSpace,
      bitsPerComponent: bitDepth,
      filter: '/FlateDecode',
      imageData: deflatedData,
      decodeParms: `<< /Predictor 1 /Colors ${outputChannels} /BitsPerComponent ${bitDepth} /Columns ${width} >>`,
    });
    fs.writeFileSync(outputPath, pdfBuf);
    return outputPath;
  }

  // Fallback for other image formats: use Ghostscript
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packpdf-'));
  try {
    const args = [
      '-dNOPAUSE', '-dBATCH', '-dSAFER',
      '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4',
      `-sOutputFile=${outputPath}`,
      absImagePath,
    ];
    await runGs(args);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return outputPath;
}

/**
 * Ensure a file is a PDF. If it's an image, convert it first.
 * Returns the path to a PDF file (may be a temp file).
 */
async function ensurePdf(filePath, tmpDir) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return { pdfPath: filePath, isTemp: false };
  }

  const imageExts = ['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp', '.gif'];
  if (!imageExts.includes(ext)) {
    throw new Error(`Unsupported file format: ${ext}`);
  }

  const baseName = path.basename(filePath, ext);
  const tmpPdf = path.join(tmpDir, `${baseName}_${Date.now()}.pdf`);
  await imageToPdf(filePath, tmpPdf);
  return { pdfPath: tmpPdf, isTemp: true };
}

/**
 * Merge multiple files (PDF or images) into a single PDF
 */
async function mergePdfs(inputFiles, outputPath, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packpdf-merge-'));
  const tempFiles = [];

  try {
    // Convert all inputs to PDF
    const pdfPaths = [];
    for (let i = 0; i < inputFiles.length; i++) {
      if (onProgress) {
        onProgress({
          stage: 'converting',
          current: i + 1,
          total: inputFiles.length,
          file: path.basename(inputFiles[i]),
        });
      }
      const { pdfPath, isTemp } = await ensurePdf(inputFiles[i], tmpDir);
      pdfPaths.push(pdfPath);
      if (isTemp) tempFiles.push(pdfPath);
    }

    if (onProgress) {
      onProgress({ stage: 'merging', current: 0, total: pdfPaths.length });
    }

    // Merge all PDFs using Ghostscript
    const args = [
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      `-sOutputFile=${outputPath}`,
      ...pdfPaths,
    ];

    await runGs(args, onProgress);

    if (onProgress) {
      onProgress({ stage: 'done' });
    }

    return outputPath;
  } finally {
    // Clean up temp files
    for (const tmp of tempFiles) {
      try { fs.unlinkSync(tmp); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Compress a PDF (or image) with the specified quality level
 * @param {string} quality - 'screen' (72dpi), 'ebook' (150dpi), 'printer' (300dpi), 'prepress' (300dpi+)
 */
async function compressPdf(inputFiles, outputPath, quality = 'ebook', onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packpdf-compress-'));
  const tempFiles = [];

  const validQualities = ['screen', 'ebook', 'printer', 'prepress'];
  if (!validQualities.includes(quality)) {
    quality = 'ebook';
  }

  try {
    // Convert all inputs to PDF first
    const pdfPaths = [];
    for (let i = 0; i < inputFiles.length; i++) {
      if (onProgress) {
        onProgress({
          stage: 'converting',
          current: i + 1,
          total: inputFiles.length,
          file: path.basename(inputFiles[i]),
        });
      }
      const { pdfPath, isTemp } = await ensurePdf(inputFiles[i], tmpDir);
      pdfPaths.push(pdfPath);
      if (isTemp) tempFiles.push(pdfPath);
    }

    if (onProgress) {
      onProgress({ stage: 'compressing' });
    }

    const args = [
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      `-dPDFSETTINGS=/${quality}`,
      '-dDownsampleColorImages=true',
      '-dDownsampleGrayImages=true',
      '-dDownsampleMonoImages=true',
      '-dColorImageResolution=150',
      '-dGrayImageResolution=150',
      '-dMonoImageResolution=300',
      `-sOutputFile=${outputPath}`,
      ...pdfPaths,
    ];

    // Adjust resolution based on quality
    if (quality === 'screen') {
      args.splice(args.indexOf('-dColorImageResolution=150'), 1, '-dColorImageResolution=72');
      args.splice(args.indexOf('-dGrayImageResolution=150'), 1, '-dGrayImageResolution=72');
      args.splice(args.indexOf('-dMonoImageResolution=300'), 1, '-dMonoImageResolution=150');
    } else if (quality === 'printer' || quality === 'prepress') {
      args.splice(args.indexOf('-dColorImageResolution=150'), 1, '-dColorImageResolution=300');
      args.splice(args.indexOf('-dGrayImageResolution=150'), 1, '-dGrayImageResolution=300');
      args.splice(args.indexOf('-dMonoImageResolution=300'), 1, '-dMonoImageResolution=600');
    }

    await runGs(args, onProgress);

    if (onProgress) {
      onProgress({ stage: 'done' });
    }

    return outputPath;
  } finally {
    for (const tmp of tempFiles) {
      try { fs.unlinkSync(tmp); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Get info about the Ghostscript installation
 */
async function getGsInfo() {
  try {
    const { stdout } = await runGs(['--version']);
    return { version: stdout.trim(), path: getGsPath() };
  } catch (e) {
    return { version: null, path: getGsPath(), error: e.message };
  }
}

module.exports = { mergePdfs, compressPdf, getGsInfo, imageToPdf };
