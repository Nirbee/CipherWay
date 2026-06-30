import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { ExposedApi } from '@shared/ipc'

function subscribe(channel: string, cb: (...args: unknown[]) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ExposedApi = {
  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    maximize: () => ipcRenderer.send(IPC.windowMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized)
  },
  vpn: {
    connect: (outboundId) => ipcRenderer.invoke(IPC.connect, outboundId),
    disconnect: () => ipcRenderer.invoke(IPC.disconnect),
    getStatus: () => ipcRenderer.invoke(IPC.getStatus)
  },
  subscription: {
    fetch: (url) => ipcRenderer.invoke(IPC.subscriptionFetch, url),
    refresh: () => ipcRenderer.invoke(IPC.subscriptionRefresh),
    get: () => ipcRenderer.invoke(IPC.subscriptionGet)
  },
  servers: {
    ping: () => ipcRenderer.invoke(IPC.serversPing),
    select: (outboundId) => ipcRenderer.invoke(IPC.serverSelect, outboundId)
  },
  rules: {
    get: () => ipcRenderer.invoke(IPC.rulesGet),
    set: (config) => ipcRenderer.invoke(IPC.rulesSet, config),
    export: () => ipcRenderer.invoke(IPC.rulesExport),
    import: () => ipcRenderer.invoke(IPC.rulesImport),
    processList: () => ipcRenderer.invoke(IPC.processList),
    pickExecutable: () => ipcRenderer.invoke(IPC.pickExecutable)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  updater: {
    check: () => ipcRenderer.invoke(IPC.updaterCheck),
    download: () => ipcRenderer.invoke(IPC.updaterDownload),
    install: () => ipcRenderer.send(IPC.updaterInstall)
  },
  on: {
    status: (cb) => subscribe(IPC.evtStatus, (p) => cb(p as never)),
    traffic: (cb) => subscribe(IPC.evtTraffic, (p) => cb(p as never)),
    log: (cb) => subscribe(IPC.evtLog, (p) => cb(p as never)),
    updater: (cb) => subscribe(IPC.evtUpdater, (p) => cb(p as never))
  }
}

contextBridge.exposeInMainWorld('api', api)
