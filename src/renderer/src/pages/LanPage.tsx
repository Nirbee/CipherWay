import { PageHeader } from '../components/PageHeader'
import { Card, Pill } from '../components/ui'
import { LanIcon } from '../components/icons'

/** «LAN» — placeholder until rooms for playing over the network are ready. */
export function LanPage() {
  return (
    <div className="pb-8">
      <PageHeader title="LAN — игра с друзьями по сети" />
      <div className="px-7">
        <Card className="relative overflow-hidden p-8">
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-accent-green/10 blur-3xl" />
          <div className="relative flex flex-col items-center text-center">
            <div className="animate-glow mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-default bg-bg-panel-alt text-accent-green">
              <LanIcon width={30} height={30} />
            </div>
            <Pill tone="green" className="mb-3">
              Скоро
            </Pill>
            <div className="text-base font-semibold text-text-primary">
              Своя локальная сеть через интернет
            </div>
            <p className="mt-2 max-w-md text-[13px] leading-relaxed text-text-muted">
              Создайте комнату, пригласите друзей по ссылке и играйте по локальной сети через
              интернет — Minecraft и другие игры.
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
