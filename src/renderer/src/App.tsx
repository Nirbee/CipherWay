import { useEffect } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { useNav } from './store/navStore'
import { useConnection } from './store/connectionStore'
import { useLogs } from './store/logsStore'
import { useUpdater } from './store/updaterStore'
import { RulesPage } from './pages/RulesPage'
import { HomePage } from './pages/HomePage'
import { ServersPage } from './pages/ServersPage'
import { LogsPage } from './pages/LogsPage'
import { SubscriptionPage } from './pages/SubscriptionPage'
import { SettingsPage } from './pages/SettingsPage'

export default function App() {
  const page = useNav((s) => s.page)
  const { setStatus, setTraffic } = useConnection()
  const addLog = useLogs((s) => s.add)
  const applyUpdater = useUpdater((s) => s.apply)

  // wire main-process push events into the stores once
  useEffect(() => {
    const offStatus = window.api.on.status(setStatus)
    const offTraffic = window.api.on.traffic(setTraffic)
    const offLog = window.api.on.log(addLog)
    const offUpdater = window.api.on.updater(applyUpdater)
    void window.api.vpn.getStatus().then(setStatus)
    // auto-connect on launch if enabled and a server is configured
    void window.api.settings.get().then(async (s) => {
      if (!s.autoConnect) return
      const sub = await window.api.subscription.get()
      if (sub?.outbounds.length) void window.api.vpn.connect()
    })
    return () => {
      offStatus()
      offTraffic()
      offLog()
      offUpdater()
    }
  }, [setStatus, setTraffic, addLog, applyUpdater])

  return (
    <div className="flex h-screen flex-col bg-bg-app text-text-primary">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <PageView page={page} />
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
    case 'subscription':
      return <SubscriptionPage />
    case 'connectors':
      return <ServersPage />
    case 'rules':
      return <RulesPage />
    case 'logs':
      return <LogsPage />
    case 'settings':
      return <SettingsPage />
    default:
      return null
  }
}
