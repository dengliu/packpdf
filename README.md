# PackPDF

A desktop application built with **Electron** that provides a GUI for compressing, merging, and converting files to PDF using **Ghostscript** as the backend engine. The app bundles the Ghostscript binary so it works out of the box with zero host-level prerequisites.

## Quick Start

```bash
# Install Node.js dependencies
npm install

# Download Ghostscript binary (~45MB)
npm run setup

# Run in development mode
npm run dev

# Package as .dmg for distribution
npm run dist

# Package as .app directory (no DMG)
npm run pack
```

---

## Architecture

```mermaid
graph TB
    subgraph Electron App
        subgraph Renderer Process
            UI[index.html + styles.css]
            RS[renderer.js<br/>UI Logic & Event Handling]
        end

        PL[preload.js<br/>Context Bridge]

        subgraph Main Process
            MN[main.js<br/>IPC Handlers & Window Management]
            GS[ghostscript.js<br/>Ghostscript & Image Processing]
            BP[bin-paths.js<br/>Binary Path Resolution]
        end
    end

    subgraph Bundled Binaries
        GSBIN[Ghostscript]
    end

    subgraph Build Tooling
        DD[scripts/download-deps.js<br/>Dependency Downloader]
        EB[electron-builder<br/>Packaging & DMG Creation]
    end

    RS -->|IPC via contextBridge| PL
    PL -->|ipcRenderer.invoke| MN
    MN -->|operation-progress event| PL
    PL -->|onOperationProgress callback| RS
    MN --> GS
    GS --> BP
    BP -->|resolves paths| GSBIN
    GS -->|spawn child_process| GSBIN
    DD -->|downloads at build time| GSBIN
    EB -->|extraResources| GSBIN
```

---

## Process Model

```mermaid
flowchart LR
    subgraph Renderer
        A[User Action]
    end
    subgraph Main
        B[IPC Handler]
        C[Ghostscript / Image Engine]
    end
    subgraph Child Processes
        D[gs - Ghostscript]
    end

    A -->|ipcRenderer.invoke| B
    B --> C
    C -->|spawn| D
    D -->|stdout progress| C
    C -->|webContents.send<br/>operation-progress| A
```

---

## Module Responsibilities

### `main.js` — Main Process Entry Point

- Creates the `BrowserWindow` with hidden title bar and dark theme
- Registers IPC handlers for file selection, merging, compressing, and file operations
- Converts DOCX files to PDF using mammoth (DOCX→HTML) + Electron `printToPDF`
- Preprocesses input files by converting DOCX to temporary PDFs before merge/compress

### `preload.js` — Context Bridge

- Exposes a safe `window.api` object to the renderer via `contextBridge`
- Maps IPC channels to callable functions (`selectFiles`, `mergePdfs`, `compressPdf`, etc.)
- Provides `onOperationProgress` callback registration for progress events

### `src/renderer.js` — UI Logic

- Manages application state (active tab, file lists, drag-and-drop reordering)
- Handles file selection via drop zones and native file dialogs
- Renders file lists with drag-to-reorder support
- Displays compression quality selector (Maximum / Balanced / Minimum)
- Shows operation progress and result summaries

### `src/ghostscript.js` — PDF Processing Engine

- Wraps the Ghostscript CLI for PDF merging and compression
- Converts images (JPG, PNG, TIFF, BMP, GIF) to PDF — JPEG and PNG are converted natively in Node.js without Ghostscript for speed
- Builds minimal PDF files in-memory for JPEG (DCTDecode) and PNG (FlateDecode) images
- Parses JPEG SOF markers and PNG IHDR/IDAT chunks for direct image embedding
- Falls back to Ghostscript for other image formats

### `src/bin-paths.js` — Binary Path Resolution

- Detects whether the app is running in development or packaged mode
- Resolves path to the bundled Ghostscript binary and its library directory
- Provides environment variables (`GS_LIB`) for Ghostscript resource lookup
- Falls back to system-installed Ghostscript if bundled binary is not found

### `scripts/download-deps.js` — Build-Time Dependency Downloader

- Downloads platform-specific Ghostscript binary from GitHub Releases
- Supports macOS arm64 architecture
- Extracts tarball and places binaries in `bin/darwin-arm64/`
- Caches downloads — skips if binary already exists

---

## IPC Channel Map

```mermaid
sequenceDiagram
    participant R as Renderer
    participant P as Preload
    participant M as Main Process
    participant G as Ghostscript

    R->>P: api.selectFiles()
    P->>M: ipcRenderer.invoke('select-files')
    M-->>R: file list with metadata

    R->>P: api.mergePdfs(files)
    P->>M: ipcRenderer.invoke('merge-pdfs', {files})
    M->>G: mergePdfs(inputFiles, outputPath)
    G->>G: spawn gs -sDEVICE=pdfwrite
    loop Progress Updates
        G-->>M: onProgress callback
        M-->>R: webContents.send('operation-progress', data)
    end
    M-->>R: result {outputPath, outputSize}

    R->>P: api.compressPdf(files, quality)
    P->>M: ipcRenderer.invoke('compress-pdf', {files, quality})
    M->>G: compressPdf(inputFiles, outputPath, quality)
    G->>G: spawn gs -dPDFSETTINGS=/quality
    loop Progress Updates
        G-->>M: onProgress callback
        M-->>R: webContents.send('operation-progress', data)
    end
    M-->>R: result {outputPath, outputSize, ratio}
```

| Channel | Direction | Purpose |
|---|---|---|
| `select-files` | Renderer → Main | Open native file picker (PDF, images, DOCX) |
| `merge-pdfs` | Renderer → Main | Merge selected files into a single PDF |
| `compress-pdf` | Renderer → Main | Compress selected files with quality setting |
| `operation-progress` | Main → Renderer | Stream progress updates (converting, merging, compressing) |
| `open-file` | Renderer → Main | Reveal output file in Finder |
| `get-gs-info` | Renderer → Main | Get Ghostscript version and path info |

---

## Supported Input Formats

| Format | Type | Conversion Method |
|---|---|---|
| PDF | Document | Native (no conversion needed) |
| JPG/JPEG | Image | Direct embedding via DCTDecode (no Ghostscript) |
| PNG | Image | Decoded & re-compressed via FlateDecode (no Ghostscript) |
| TIFF/TIF | Image | Ghostscript conversion |
| BMP | Image | Ghostscript conversion |
| GIF | Image | Ghostscript conversion |
| DOCX | Document | mammoth → HTML → Electron printToPDF |

---

## Compression Quality Levels

| Level | DPI | Ghostscript Setting | Use Case |
|---|---|---|---|
| Maximum | 72 | `-dPDFSETTINGS=/screen` | Smallest file size |
| Balanced | 150 | `-dPDFSETTINGS=/ebook` | Good quality (default) |
| Minimum | 300 | `-dPDFSETTINGS=/printer` | High quality print |

---

## Binary Dependency Management

```mermaid
flowchart TD
    A[npm run setup] --> B[scripts/download-deps.js]
    B --> C{Detect platform & arch}
    C -->|darwin-arm64| D[Download Ghostscript from GitHub]
    D --> E[bin/darwin-arm64/]
    E --> F[gs-1001-linux_aarch64/gs binary + lib/]

    G[npm run dist] --> H[electron-builder]
    H --> I{extraResources}
    I -->|from: bin/darwin-arm64| J[App.app/Contents/Resources/bin/]

    K[App Runtime] --> L[bin-paths.js]
    L --> M{isPackaged?}
    M -->|Yes| N[process.resourcesPath/bin/]
    M -->|No| O[__dirname/../bin/darwin-arm64/]
    N --> P[Resolve gs path + GS_LIB]
    O --> P
    P --> Q[ghostscript.js uses resolved paths]
```

---

## File Structure

```
packpdf/
├── main.js                  # Electron main process
├── preload.js               # Context bridge (renderer ↔ main)
├── package.json             # Dependencies & electron-builder config
├── src/
│   ├── index.html           # App UI markup
│   ├── styles.css           # App styling (dark theme)
│   ├── renderer.js          # UI logic & state management
│   ├── ghostscript.js       # Ghostscript wrapper & image-to-PDF
│   └── bin-paths.js         # Binary path resolution
├── scripts/
│   └── download-deps.js     # Ghostscript binary downloader
├── bin/
│   └── darwin-arm64/        # Downloaded binaries (gitignored)
│       └── gs-1001-linux_aarch64/
│           ├── gs
│           └── lib/
└── dist/                    # Build output (gitignored)
    └── PackPDF-*.dmg
```

---

## Build & Distribution

```mermaid
flowchart LR
    A[npm install] --> B[npm run setup]
    B --> C[Download Ghostscript<br/>to bin/darwin-arm64/]
    C --> D[npm run dist]
    D --> E[electron-builder]
    E --> F[Bundle app + extraResources]
    F --> G[Ad-hoc code sign]
    G --> H[PackPDF-1.0.0-arm64.dmg]
