const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFiles: () => ipcRenderer.invoke('select-files'),
  mergePdfs: (options) => ipcRenderer.invoke('merge-pdfs', options),
  compressPdf: (options) => ipcRenderer.invoke('compress-pdf', options),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  getGsInfo: () => ipcRenderer.invoke('get-gs-info'),
  onOperationProgress: (callback) => {
    ipcRenderer.on('operation-progress', (event, data) => callback(data));
  },
  removeProgressListener: () => {
    ipcRenderer.removeAllListeners('operation-progress');
  },
});
