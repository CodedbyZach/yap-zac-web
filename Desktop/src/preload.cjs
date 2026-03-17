const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('yapzacDesktop', Object.freeze({
  platform: 'electron'
}));
