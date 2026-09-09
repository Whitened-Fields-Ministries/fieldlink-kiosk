// Preload — runs before every page in the kiosk window.
//
// The remote kiosk page only gets a read-only marker so it can tailor its
// messages ("press Ctrl+Shift+K on this kiosk…"). The privileged bridge that can
// change the saved kiosk URL is exposed ONLY to our local recovery.html.
const { contextBridge, ipcRenderer } = require('electron');

const versionArg = (process.argv || []).find(a => a.startsWith('--flk-version='));
contextBridge.exposeInMainWorld('fieldlinkKioskApp', Object.freeze({
  app: true,
  version: versionArg ? versionArg.slice('--flk-version='.length) : undefined,
}));

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('kiosk', {
    getState: ()            => ipcRenderer.invoke('kiosk:get-state'),
    pair:     (code, server) => ipcRenderer.invoke('kiosk:pair', { code, server }),
    setUrl:   (text, server) => ipcRenderer.invoke('kiosk:set-url', { text, server }),
    retry:    ()            => ipcRenderer.invoke('kiosk:retry'),
    back:     ()            => ipcRenderer.invoke('kiosk:back'),
    quit:     ()            => ipcRenderer.invoke('kiosk:quit'),
    // Kiosk-displayed pairing code (admin types it into FieldLink Admin)
    pairRequest: (server)   => ipcRenderer.invoke('kiosk:pair-request', { server }),
    // Privileged helper (resources/kiosk-admin.ps1) — UAC prompt on the PC
    adminStatus: ()         => ipcRenderer.invoke('kiosk:admin-status'),
    adminRun:    (action)   => ipcRenderer.invoke('kiosk:admin-run', { action }),
    adminResult: ()         => ipcRenderer.invoke('kiosk:admin-result'),
    adminJob:    ()         => ipcRenderer.invoke('kiosk:admin-job'),
    checkUpdate: ()         => ipcRenderer.invoke('kiosk:check-update'),
    installUpdate: ()       => ipcRenderer.invoke('kiosk:install-update'),
    updateState: ()         => ipcRenderer.invoke('kiosk:update-state'),
    restart:     ()         => ipcRenderer.invoke('kiosk:restart'),
    onState:  (cb) => {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('kiosk:state', handler);
      return () => ipcRenderer.removeListener('kiosk:state', handler);
    },
  });
}
