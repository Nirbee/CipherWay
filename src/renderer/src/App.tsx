import { useEffect, useState } from 'react'
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
import { cn } from './lib/cn'

export default function App() {
  const page = useNav((s) => s.page)
  const { setStatus, setTraffic } = useConnection()
  const addLog = useLogs((s) => s.add)
  const applyUpdater = useUpdater((s) => s.apply)
  const [maximized, setMaximized] = useState(false)

  // wire main-process push events into the stores once
  useEffect(() => {
    const offStatus = window.api.on.status(setStatus)
    const offTraffic = window.api.on.traffic(setTraffic)
    const offLog = window.api.on.log(addLog)
    const offUpdater = window.api.on.updater(applyUpdater)
    const offMax = window.api.on.windowMaximized(setMaximized)
    void window.api.vpn.getStatus().then(setStatus)
    void window.api.window.isMaximized().then(setMaximized)
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
      offMax()
    }
  }, [setStatus, setTraffic, addLog, applyUpdater])

  return (
    <div className={cn('app-shell flex text-text-primary', maximized && 'maximized')}>
      <Sidebar />
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
    case 'subscription':
      return <SubscriptionPage />
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
