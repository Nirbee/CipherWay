import { useEffect, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { useNav } from './store/navStore'
import { useConnection } from './store/connectionStore'
import { useLogs } from './store/logsStore'
import { useUpdater } from './store/updaterStore'
import { useSettings } from './store/settingsStore'
import { useSubscription } from './store/subscriptionStore'
import { useServers } from './store/serversStore'
import { useSupport } from './store/supportStore'
import { toast } from './store/toastStore'
import { PAGE_KEYS, type PageKey } from './store/navStore'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { Toaster } from './components/Toaster'
import { RulesPage } from './pages/RulesPage'
import { HomePage } from './pages/HomePage'
import { ServersPage } from './pages/ServersPage'
import { LogsPage } from './pages/LogsPage'
import { SubscriptionPage } from './pages/SubscriptionPage'
import { SettingsPage } from './pages/SettingsPage'
import { SupportPage } from './pages/SupportPage'
import { LanPage } from './pages/LanPage'
import { ImportSubscriptionDialog } from './components/ImportSubscriptionDialog'
import { cn } from './lib/cn'

export default function App() {
  const page = useNav((s) => s.page)
  const setPage = useNav((s) => s.setPage)
  const { setStatus, setTraffic } = useConnection()
  const addLogs = useLogs((s) => s.addBatch)
  const applyPings = useServers((s) => s.applyPings)
  const applySupport = useSupport((s) => s.apply)
  const applyUpdater = useUpdater((s) => s.set)
  const loadUpdater = useUpdater((s) => s.load)
  const applySettings = useSettings((s) => s.apply)
  const loadSettings = useSettings((s) => s.load)
  const setSubscription = useSubscription((s) => s.set)
  const setActiveLocal = useServers((s) => s.setActiveLocal)
  const [maximized, setMaximized] = useState(false)

  // wire main-process push events into the stores once
  useEffect(() => {
    const offStatus = window.api.on.status((s) => {
      setStatus(s)
      setActiveLocal(s.activeOutboundId)
    })
    const offSettings = window.api.on.settings(applySettings)
    const offSub = window.api.on.subscription(setSubscription)
    const offNotice = window.api.on.notice((n) => toast(n.text, n.tone))
    void loadSettings()
    const offTraffic = window.api.on.traffic(setTraffic)
    const offLog = window.api.on.log(addLogs)
    const offPings = window.api.on.pings(applyPings)
    const offSupport = window.api.on.support(applySupport)
    const offNav = window.api.on.navigate((p) => {
      if ((PAGE_KEYS as readonly string[]).includes(p)) setPage(p as PageKey)
    })
    void window.api.support.get().then(applySupport)
    const offUpdater = window.api.on.updater(applyUpdater)
    void loadUpdater()
    const offMax = window.api.on.windowMaximized(setMaximized)
    void window.api.vpn.getStatus().then((s) => {
      setStatus(s)
      setActiveLocal(s.activeOutboundId)
    })
    void window.api.window.isMaximized().then(setMaximized)
    // auto-connect on launch if enabled and a server is configured
    void window.api.settings.get().then(async (s) => {
      if (!s.autoConnect) return
      const sub = await window.api.subscription.get()
      if (sub?.servers.length) void window.api.vpn.connect()
    })
    return () => {
      offStatus()
      offTraffic()
      offLog()
      offUpdater()
      offMax()
      offSettings()
      offSub()
      offNotice()
      offPings()
      offSupport()
      offNav()
    }
  }, [
    setStatus,
    setTraffic,
    addLogs,
    applyPings,
    applySupport,
    setPage,
    applyUpdater,
    loadUpdater,
    applySettings,
    loadSettings,
    setSubscription,
    setActiveLocal
  ])

  return (
    <div className={cn('app-shell flex text-text-primary', maximized && 'maximized')}>
      <Sidebar />
      <ImportSubscriptionDialog />
      <Toaster />
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div key={page} className="animate-page h-full">
            <PageView page={page} />
          </div>
        </main>
      </div>
    </div>
  )
}

function PageView({ page }: { page: string }) {
  switch (page) {
    case 'home':
      return <HomePage />
    case 'servers':
      return <ServersPage />
    case 'connections':
      return <ConnectionsPage />
    case 'lan':
      return <LanPage />
    case 'subscription':
      return <SubscriptionPage />
    case 'rules':
      return <RulesPage />
    case 'support':
      return <SupportPage />
    case 'logs':
      return <LogsPage />
    case 'settings':
      return <SettingsPage />
    default:
      return null
  }
}
