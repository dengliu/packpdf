// State
const state = {
  merge: { files: [] },
  compress: { files: [], quality: 'ebook' },
  activeTab: 'compress',
  processing: false,
  lastResultPath: null,
};

// Elements
const els = {
  // Tabs
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabContents: document.querySelectorAll('.tab-content'),
  // Merge
  mergeDropZone: document.getElementById('mergeDropZone'),
  mergeSelectBtn: document.getElementById('mergeSelectBtn'),
  mergeFileListContainer: document.getElementById('mergeFileListContainer'),
  mergeFileList: document.getElementById('mergeFileList'),
  mergeFileCount: document.getElementById('mergeFileCount'),
  mergeAddMoreBtn: document.getElementById('mergeAddMoreBtn'),
  mergeClearBtn: document.getElementById('mergeClearBtn'),
  mergeBtn: document.getElementById('mergeBtn'),
  // Compress
  compressDropZone: document.getElementById('compressDropZone'),
  compressSelectBtn: document.getElementById('compressSelectBtn'),
  compressFileListContainer: document.getElementById('compressFileListContainer'),
  compressFileList: document.getElementById('compressFileList'),
  compressFileCount: document.getElementById('compressFileCount'),
  compressAddMoreBtn: document.getElementById('compressAddMoreBtn'),
  compressClearBtn: document.getElementById('compressClearBtn'),
  compressBtn: document.getElementById('compressBtn'),
  qualityBtns: document.querySelectorAll('.quality-btn'),
  // Status
  statusBar: document.getElementById('statusBar'),
  statusText: document.getElementById('statusText'),
  progressFill: document.getElementById('progressFill'),
  // Result
  resultPanel: document.getElementById('resultPanel'),
  resultTitle: document.getElementById('resultTitle'),
  resultDetails: document.getElementById('resultDetails'),
  resultOpenBtn: document.getElementById('resultOpenBtn'),
  // Info
  gsInfo: document.getElementById('gsInfo'),
};

// Utility
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(ext) {
  return ext === '.pdf' ? 'pdf' : 'img';
}

function getFileLabel(ext) {
  return ext === '.pdf' ? 'PDF' : ext.replace('.', '').toUpperCase();
}

// Tab switching
els.tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    state.activeTab = tab;

    els.tabBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    els.tabContents.forEach((c) => c.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');

    hideStatus();
    hideResult();
  });
});

// File list rendering
function renderFileList(mode) {
  const files = state[mode].files;
  const listEl = mode === 'merge' ? els.mergeFileList : els.compressFileList;
  const containerEl = mode === 'merge' ? els.mergeFileListContainer : els.compressFileListContainer;
  const dropZone = mode === 'merge' ? els.mergeDropZone : els.compressDropZone;
  const countEl = mode === 'merge' ? els.mergeFileCount : els.compressFileCount;

  if (files.length === 0) {
    containerEl.style.display = 'none';
    dropZone.style.display = 'flex';
    return;
  }

  containerEl.style.display = 'flex';
  dropZone.style.display = 'none';
  countEl.textContent = `(${files.length} file${files.length > 1 ? 's' : ''})`;

  listEl.innerHTML = '';
  files.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.draggable = true;
    item.dataset.index = index;

    const iconClass = getFileIcon(file.ext);
    const iconLabel = getFileLabel(file.ext);

    item.innerHTML = `
      <span class="file-item-drag">☰</span>
      <div class="file-item-icon ${iconClass}">${iconLabel}</div>
      <div class="file-item-info">
        <div class="file-item-name" title="${file.name}">${file.name}</div>
        <div class="file-item-size">${formatSize(file.size)}</div>
      </div>
      <button class="file-item-remove" data-index="${index}" title="Remove">×</button>
    `;

    // Remove button
    item.querySelector('.file-item-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      state[mode].files.splice(index, 1);
      renderFileList(mode);
    });

    // Drag and drop reordering
    item.addEventListener('dragstart', (e) => {
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', index.toString());
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
      const toIndex = index;
      if (fromIndex !== toIndex) {
        const [moved] = state[mode].files.splice(fromIndex, 1);
        state[mode].files.splice(toIndex, 0, moved);
        renderFileList(mode);
      }
    });

    listEl.appendChild(item);
  });
}

// Add files
async function addFiles(mode) {
  const files = await window.api.selectFiles();
  if (files && files.length > 0) {
    state[mode].files.push(...files);
    renderFileList(mode);
    hideResult();
  }
}

// Drop zone handlers
function setupDropZone(dropZone, mode) {
  dropZone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') {
      addFiles(mode);
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    // Note: In Electron with contextIsolation, dropped files need to be handled via IPC
    // For now, just trigger the file picker
    addFiles(mode);
  });
}

setupDropZone(els.mergeDropZone, 'merge');
setupDropZone(els.compressDropZone, 'compress');

// Button handlers
els.mergeSelectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  addFiles('merge');
});
els.compressSelectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  addFiles('compress');
});
els.mergeAddMoreBtn.addEventListener('click', () => addFiles('merge'));
els.compressAddMoreBtn.addEventListener('click', () => addFiles('compress'));

els.mergeClearBtn.addEventListener('click', () => {
  state.merge.files = [];
  renderFileList('merge');
  hideResult();
});

els.compressClearBtn.addEventListener('click', () => {
  state.compress.files = [];
  renderFileList('compress');
  hideResult();
});

// Quality selector
els.qualityBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    els.qualityBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.compress.quality = btn.dataset.quality;
  });
});

// Status helpers
function showStatus(text) {
  els.statusBar.style.display = 'block';
  els.statusText.textContent = text;
  els.progressFill.style.width = '0%';
}

function updateStatus(text, progress) {
  els.statusText.textContent = text;
  if (progress !== undefined) {
    els.progressFill.style.width = `${progress}%`;
  }
}

function hideStatus() {
  els.statusBar.style.display = 'none';
}

function showResult(title, details, outputPath, isError = false) {
  els.resultPanel.style.display = 'flex';
  els.resultPanel.className = `result-panel${isError ? ' error' : ''}`;
  els.resultTitle.textContent = title;
  els.resultDetails.textContent = details;
  state.lastResultPath = outputPath;
  els.resultOpenBtn.style.display = outputPath ? 'inline-flex' : 'none';

  if (isError) {
    els.resultPanel.querySelector('.result-icon').textContent = '✕';
  } else {
    els.resultPanel.querySelector('.result-icon').textContent = '✓';
  }
}

function hideResult() {
  els.resultPanel.style.display = 'none';
  state.lastResultPath = null;
}

els.resultOpenBtn.addEventListener('click', () => {
  if (state.lastResultPath) {
    window.api.openFile(state.lastResultPath);
  }
});

// Progress listener
window.api.onOperationProgress((data) => {
  if (data.stage === 'converting') {
    updateStatus(`Converting ${data.file} (${data.current}/${data.total})...`, (data.current / data.total) * 50);
  } else if (data.stage === 'merging') {
    updateStatus('Merging PDFs...', 60);
  } else if (data.stage === 'compressing') {
    updateStatus('Compressing...', 60);
  } else if (data.page) {
    updateStatus(`Processing page ${data.page}...`, 70);
  } else if (data.stage === 'done') {
    updateStatus('Finishing up...', 95);
  }
});

// Merge action
els.mergeBtn.addEventListener('click', async () => {
  if (state.processing || state.merge.files.length < 2) return;

  if (state.merge.files.length < 2) {
    showResult('Need at least 2 files', 'Add more files to merge.', null, true);
    return;
  }

  state.processing = true;
  els.mergeBtn.disabled = true;
  hideResult();
  showStatus('Starting merge...');

  try {
    const result = await window.api.mergePdfs({ files: state.merge.files });

    if (result.canceled) {
      hideStatus();
    } else if (result.success) {
      hideStatus();
      showResult(
        'Merge Complete!',
        `Output: ${formatSize(result.outputSize)} — ${state.merge.files.length} files merged`,
        result.outputPath
      );
    } else {
      hideStatus();
      showResult('Merge Failed', result.error, null, true);
    }
  } catch (e) {
    hideStatus();
    showResult('Merge Failed', e.message, null, true);
  }

  state.processing = false;
  els.mergeBtn.disabled = false;
});

// Compress action
els.compressBtn.addEventListener('click', async () => {
  if (state.processing || state.compress.files.length === 0) return;

  state.processing = true;
  els.compressBtn.disabled = true;
  hideResult();
  showStatus('Starting compression...');

  try {
    const result = await window.api.compressPdf({
      files: state.compress.files,
      quality: state.compress.quality,
    });

    if (result.canceled) {
      hideStatus();
    } else if (result.success) {
      hideStatus();
      const ratioText = result.ratio > 0
        ? `Reduced by ${result.ratio}%`
        : 'File size unchanged';
      showResult(
        'Compression Complete!',
        `${formatSize(result.originalSize)} → ${formatSize(result.outputSize)} (${ratioText})`,
        result.outputPath
      );
    } else {
      hideStatus();
      showResult('Compression Failed', result.error, null, true);
    }
  } catch (e) {
    hideStatus();
    showResult('Compression Failed', e.message, null, true);
  }

  state.processing = false;
  els.compressBtn.disabled = false;
});

// Load GS info
(async () => {
  try {
    const info = await window.api.getGsInfo();
    if (info.version) {
      els.gsInfo.textContent = `Ghostscript ${info.version}`;
    } else {
      els.gsInfo.textContent = 'GS: not found';
      els.gsInfo.style.color = '#ff4a6a';
    }
  } catch {
    els.gsInfo.textContent = '';
  }
})();
