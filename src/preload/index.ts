import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { ExposedApi } from '@shared/ipc'

function subscribe(channel: string, cb: (...args: unknown[]) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ExposedApi = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url)
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    maximize: () => ipcRenderer.send(IPC.windowMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized)
  },
  vpn: {
    connect: (outboundId) => ipcRenderer.invoke(IPC.connect, outboundId),
    disconnect: () => ipcRenderer.invoke(IPC.disconnect),
    getStatus: () => ipcRenderer.invoke(IPC.getStatus),
    setRoutingMode: (mode) => ipcRenderer.invoke(IPC.setRoutingMode, mode)
  },
  subscription: {
    fetch: (url) => ipcRenderer.invoke(IPC.subscriptionFetch, url),
    refresh: () => ipcRenderer.invoke(IPC.subscriptionRefresh),
    get: () => ipcRenderer.invoke(IPC.subscriptionGet)
  },
  connections: {
    list: () => ipcRenderer.invoke(IPC.connectionsList),
    close: (id) => ipcRenderer.invoke(IPC.connectionsClose, id),
    closeAll: () => ipcRenderer.invoke(IPC.connectionsCloseAll),
    icon: (exePath) => ipcRenderer.invoke(IPC.processIcon, exePath)
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
    openText: () => ipcRenderer.invoke(IPC.rulesOpenText),
    saveText: (text) => ipcRenderer.invoke(IPC.rulesSaveText, text),
    processList: () => ipcRenderer.invoke(IPC.processList),
    pickExecutable: () => ipcRenderer.invoke(IPC.pickExecutable)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  tunService: {
    status: () => ipcRenderer.invoke(IPC.tunServiceStatus),
    install: () => ipcRenderer.invoke(IPC.tunServiceInstall),
    remove: () => ipcRenderer.invoke(IPC.tunServiceRemove)
  },
  deeplink: {
    takePending: () => ipcRenderer.invoke(IPC.deeplinkTakePending)
  },
  support: {
    get: () => ipcRenderer.invoke(IPC.supportGet),
    refresh: () => ipcRenderer.invoke(IPC.supportRefresh),
    send: (text) => ipcRenderer.invoke(IPC.supportSend, text),
    sendPhoto: (photo) => ipcRenderer.invoke(IPC.supportSendPhoto, photo),
    image: (url) => ipcRenderer.invoke(IPC.supportImage, url),
    setActive: (active) => ipcRenderer.send(IPC.supportSetActive, active),
    markRead: () => ipcRenderer.send(IPC.supportMarkRead)
  },
  updater: {
    getState: () => ipcRenderer.invoke(IPC.updaterGetState),
    check: () => ipcRenderer.invoke(IPC.updaterCheck),
    download: () => ipcRenderer.invoke(IPC.updaterDownload),
    install: () => ipcRenderer.send(IPC.updaterInstall)
  },
  on: {
    status: (cb) => subscribe(IPC.evtStatus, (p) => cb(p as never)),
    traffic: (cb) => subscribe(IPC.evtTraffic, (p) => cb(p as never)),
    log: (cb) => subscribe(IPC.evtLog, (p) => cb(p as never)),
    pings: (cb) => subscribe(IPC.evtPings, (p) => cb(p as never)),
    support: (cb) => subscribe(IPC.evtSupport, (p) => cb(p as never)),
    navigate: (cb) => subscribe(IPC.evtNavigate, (p) => cb(p as never)),
    updater: (cb) => subscribe(IPC.evtUpdater, (p) => cb(p as never)),
    windowMaximized: (cb) => subscribe(IPC.evtWindowMaximized, (p) => cb(p as never)),
    importRequest: (cb) => subscribe(IPC.evtImportRequest, () => cb()),
    settings: (cb) => subscribe(IPC.evtSettings, (p) => cb(p as never)),
    subscription: (cb) => subscribe(IPC.evtSubscription, (p) => cb(p as never)),
    notice: (cb) => subscribe(IPC.evtNotice, (p) => cb(p as never))
  }
}

contextBridge.exposeInMainWorld('api', api)
