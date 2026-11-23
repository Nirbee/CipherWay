import { useEffect, useState } from 'react'
import type { LanDevice, LanMember, LanPeerLink, LanRoom, LanView } from '@shared/types'
import { PageHeader } from '../components/PageHeader'
import { Button, Card, Input, Modal, Pill, Toggle } from '../components/ui'
import {
  AlertIcon,
  CopyIcon,
  LanIcon,
  PlusIcon,
  RefreshIcon,
  SpinnerIcon,
  TrashIcon
} from '../components/icons'
import { useLan } from '../store/lanStore'
import { useNav } from '../store/navStore'
import { toast } from '../store/toastStore'
import { cn } from '../lib/cn'

/** «LAN» — a virtual LAN with friends: rooms by code, Minecraft over the network. */
export function LanPage() {
  const { view, busy, apply, load, run } = useLan()
  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)

  useEffect(() => {
    const off = window.api.on.lan(apply)
    void load()
    window.api.lan.setActive(true)
    return () => {
      window.api.lan.setActive(false)
      off()
    }
  }, [apply, load])

  if (!view) return null

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader
        title="LAN — игра с друзьями по сети"
        subtitle="Своя локальная сеть через интернет: друзья из одной комнаты видят ваш компьютер, как будто вы рядом."
      />
      <div className="space-y-5 px-7 pb-8">
        <NetworkCard view={view} busy={busy} run={run} />
        <RoomsCard
          view={view}
          busy={busy}
          run={run}
          onCreate={() => setCreateOpen(true)}
          onJoin={() => setJoinOpen(true)}
        />
        <MinecraftCard selfIp={view.selfIp} />
      </div>

      <NameDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (name) => {
          const ok = await run(() => window.api.lan.createRoom(name), 'Комната создана')
          if (ok) setCreateOpen(false)
        }}
        busy={busy}
      />
      <CodeDialog
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onSubmit={async (code) => {
          const ok = await run(() => window.api.lan.joinRoom(code), 'Вы в комнате')
          if (ok) setJoinOpen(false)
        }}
        busy={busy}
      />
    </div>
  )
}

type Run = (op: () => Promise<LanView>, ok?: string) => Promise<boolean>

/** what the owner sends a friend (plain text) */
const inviteText = (name: string, code: string): string =>
  `Заходи в мою комнату «${name}» в CipherWay VPN: вкладка LAN → «Войти по коду» → ${code}`

const copy = (text: string, what = 'Скопировано'): void => {
  void navigator.clipboard.writeText(text).then(() => toast(what, 'success'))
}

function CopyButton({ text, what, title }: { text: string; what?: string; title?: string }) {
  return (
    <button
      onClick={() => copy(text, what)}
      title={title ?? 'Копировать'}
      className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary"
    >
      <CopyIcon width={14} height={14} />
    </button>
  )
}

const PHASE: Record<
  LanView['phase'],
  { label: string; tone: 'neutral' | 'amber' | 'green' | 'red' }
> = {
  off: { label: 'выключен', tone: 'neutral' },
  starting: { label: 'включается…', tone: 'amber' },
  on: { label: 'работает', tone: 'green' },
  error: { label: 'не работает', tone: 'red' }
}

// --- the switch, own address, errors ------------------------------------------

function NetworkCard({ view, busy, run }: { view: LanView; busy: boolean; run: Run }) {
  const setPage = useNav((s) => s.setPage)
  const phase = PHASE[view.phase]
  const starting = view.phase === 'starting'
  const apply = useLan((s) => s.apply)
  const toggle = (on: boolean): void => {
    // «off» also cancels a start that is still running (waiting for UAC, the server)
    if (!on) {
      void window.api.lan
        .setEnabled(false)
        .then(apply)
        .catch((e: unknown) => toast(String(e), 'error'))
      return
    }
    void run(() => window.api.lan.setEnabled(true))
  }

  return (
    <Card className="relative overflow-hidden p-5">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-accent-green/10 blur-3xl" />
      <div className="relative flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border-default bg-bg-panel-alt text-accent-green">
            <LanIcon width={22} height={22} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-primary">Моя LAN-сеть</span>
              <Pill tone={phase.tone}>{phase.label}</Pill>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {view.phase === 'on'
                ? 'Компьютер в сети CipherWay LAN. VPN можно включать и выключать — LAN это не мешает.'
                : 'Включите, чтобы играть с друзьями из ваших комнат. Работает и без VPN.'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {starting && (
            <SpinnerIcon width={16} height={16} className="animate-spin text-text-muted" />
          )}
          <Toggle
            checked={view.enabled}
            disabled={!view.available || (busy && !starting)}
            onChange={toggle}
            label="LAN"
          />
        </div>
      </div>

      {view.message && starting && (
        <div className="relative mt-3 text-[12px] text-text-muted">{view.message}</div>
      )}

      {view.phase === 'on' && (
        <div className="relative mt-4 flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-panel-alt px-3.5 py-2.5">
          <div className="min-w-0">
            <div className="text-[11px] text-text-faint">Мой LAN-адрес</div>
            <div className="font-mono text-[15px] font-semibold text-text-primary">
              {view.selfIp ?? 'выдаётся…'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {view.selfName && (
              <span className="truncate text-[11px] text-text-faint">{view.selfName}</span>
            )}
            {view.selfIp && <CopyButton text={view.selfIp} what="Адрес скопирован" />}
          </div>
        </div>
      )}

      <div className="relative mt-3 rounded-xl border border-accent-amber/25 bg-accent-amber/[0.06] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-text-muted">
        <b className="text-text-secondary">Важно:</b> участники комнаты видят ваш ПК как домашнюю
        сеть (общие папки, удалённый рабочий стол, если включены) — заходите только в комнаты к тем,
        кому доверяете. Действуют правила брандмауэра Windows: программа, которой там не разрешён
        доступ, снаружи недоступна. Настройки DNS и маршрутов от сервера LAN на ваш компьютер не
        применяет.
      </div>

      {view.error && (
        <div
          className={cn(
            'relative mt-4 flex gap-2.5 rounded-xl border px-3.5 py-3 text-[12px] leading-relaxed',
            view.error.kind === 'device_limit' || view.error.kind === 'tailscale_running'
              ? 'border-accent-amber/30 bg-accent-amber/[0.07] text-text-secondary'
              : 'border-accent-red/30 bg-accent-red/[0.07] text-text-secondary'
          )}
        >
          <AlertIcon width={16} height={16} className="mt-0.5 shrink-0 text-accent-amber" />
          <div className="min-w-0 flex-1">
            <div>{view.error.text}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {view.error.kind === 'nosub' && (
                <Button size="sm" variant="secondary" onClick={() => setPage('subscription')}>
                  Открыть «Подписку»
                </Button>
              )}
              {(view.error.kind === 'daemon' || view.error.kind === 'login') && (
                <Button size="sm" variant="secondary" onClick={() => setPage('logs')}>
                  Открыть «Логи»
                </Button>
              )}
              {view.error.kind !== 'nosub' && view.error.kind !== 'device_limit' && (
                <Button size="sm" disabled={busy} onClick={() => toggle(true)}>
                  {view.error.kind === 'service' || view.error.kind === 'uac'
                    ? 'Включить'
                    : 'Попробовать снова'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {(view.error?.kind === 'device_limit' || view.devices) && (
        <Devices view={view} busy={busy} run={run} />
      )}
      {!view.devices && view.error?.kind !== 'device_limit' && view.hasSubscription && (
        <div className="relative mt-3">
          <button
            className="no-drag text-[11px] text-text-faint underline-offset-2 hover:text-text-muted hover:underline"
            onClick={() => void run(() => window.api.lan.devices())}
          >
            Мои устройства в LAN
          </button>
        </div>
      )}
    </Card>
  )
}

function Devices({ view, busy, run }: { view: LanView; busy: boolean; run: Run }) {
  const list: LanDevice[] = view.devices ?? []
  const max = view.limits?.maxDevices
  return (
    <div className="relative mt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-text-muted">
          Мои устройства{max ? ` (${list.length} из ${max})` : ''}
        </span>
        <button
          className="no-drag flex items-center gap-1 text-[11px] text-text-faint hover:text-text-muted"
          onClick={() => void run(() => window.api.lan.devices())}
        >
          <RefreshIcon width={12} height={12} /> обновить
        </button>
      </div>
      {list.length === 0 ? (
        <div className="text-[12px] text-text-faint">Устройств пока нет.</div>
      ) : (
        <div className="space-y-1.5">
          {list.map((d) => (
            <div
              key={d.nodeId}
              className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-panel-alt px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <OnlineDot online={d.online} />
                <span className="truncate text-[13px] text-text-primary">{d.name}</span>
                {d.isThis && <Pill tone="blue">этот компьютер</Pill>}
                {d.expired && (
                  <Pill title="Не считается в лимите устройств">отключено сервером</Pill>
                )}
                {d.ip && <span className="font-mono text-[11px] text-text-faint">{d.ip}</span>}
              </div>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(() => window.api.lan.deleteDevice(d.nodeId), 'Устройство удалено')
                }
              >
                <TrashIcon width={13} height={13} /> Удалить
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      title={online ? 'в сети' : 'не в сети'}
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        online ? 'bg-status-ok shadow-[0_0_6px] shadow-status-ok/60' : 'bg-text-faint/50'
      )}
    />
  )
}

// --- rooms ----------------------------------------------------------------------

function RoomsCard({
  view,
  busy,
  run,
  onCreate,
  onJoin
}: {
  view: LanView
  busy: boolean
  run: Run
  onCreate: () => void
  onJoin: () => void
}) {
  const maxOwned = view.limits?.maxRoomsOwned
  const owned = view.rooms.filter((r) => r.isOwner).length
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-text-primary">Комнаты</div>
          <div className="mt-0.5 text-[11px] text-text-faint">
            Участники комнаты видят только друг друга
            {view.limits ? ` · до ${view.limits.maxRoomMembers} человек в комнате` : ''}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !view.hasSubscription}
            title={
              view.limits
                ? `Можно состоять не больше чем в ${view.limits.maxRoomsJoined} комнатах`
                : undefined
            }
            onClick={onJoin}
          >
            Войти по коду
          </Button>
          <Button
            size="sm"
            disabled={busy || !view.hasSubscription || (!!maxOwned && owned >= maxOwned)}
            title={
              maxOwned && owned >= maxOwned ? `Можно создать не больше ${maxOwned}` : undefined
            }
            onClick={onCreate}
          >
            <PlusIcon width={14} height={14} /> Создать
          </Button>
        </div>
      </div>

      {view.roomsError && (
        <div className="mt-3 text-[12px] text-accent-amber">{view.roomsError}</div>
      )}

      {view.rooms.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border-default px-4 py-6 text-center text-[12px] leading-relaxed text-text-muted">
          Комнат пока нет. Создайте свою и отправьте другу её код — или войдите по коду, который
          прислал друг.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {view.rooms.map((r) => (
            <RoomCard key={r.id} room={r} view={view} busy={busy} run={run} />
          ))}
        </div>
      )}
    </Card>
  )
}

function RoomCard({
  room,
  view,
  busy,
  run
}: {
  room: LanRoom
  view: LanView
  busy: boolean
  run: Run
}) {
  const [confirm, setConfirm] = useState(false)
  const max = view.limits?.maxRoomMembers
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-panel-alt p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-text-primary">
              {room.name}
            </span>
            {room.isOwner && <Pill tone="blue">ваша</Pill>}
            <span className="text-[11px] text-text-faint">
              {room.members.length}
              {max ? ` из ${max}` : ''}
            </span>
          </div>
          {room.isOwner && room.code ? (
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="text-[11px] text-text-faint">Код:</span>
              <span className="font-mono text-[14px] font-semibold tracking-[0.2em] text-accent-green">
                {room.code}
              </span>
              <CopyButton text={room.code} what="Код комнаты скопирован" title="Копировать код" />
            </div>
          ) : (
            !room.isOwner && (
              <div className="mt-1 text-[11px] text-text-faint">
                Пригласить друзей может создатель комнаты
              </div>
            )
          )}
        </div>
        <div className="flex shrink-0 gap-1.5">
          {room.isOwner && room.code && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="Скопировать приглашение с кодом комнаты"
              onClick={() => copy(inviteText(room.name, room.code!), 'Приглашение скопировано')}
            >
              Пригласить
            </Button>
          )}
          {room.isOwner && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="Старый код перестанет работать"
              onClick={() =>
                void run(() => window.api.lan.regenerateCode(room.id), 'Новый код готов')
              }
            >
              <RefreshIcon width={13} height={13} /> Сменить код
            </Button>
          )}
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirm(true)}>
            {room.isOwner ? 'Удалить' : 'Выйти'}
          </Button>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        {room.members.map((m) => (
          <MemberRow key={m.memberId} member={m} room={room} view={view} busy={busy} run={run} />
        ))}
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={room.isOwner ? 'Удалить комнату?' : 'Выйти из комнаты?'}
        width="max-w-sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              Отмена
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={async () => {
                const ok = await run(
                  () => window.api.lan.leaveRoom(room.id),
                  room.isOwner ? 'Комната удалена' : 'Вы вышли из комнаты'
                )
                if (ok) setConfirm(false)
              }}
            >
              {room.isOwner ? 'Удалить' : 'Выйти'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-text-muted">
          {room.isOwner
            ? `Вы создатель «${room.name}»: если вы уйдёте, комната удалится для всех участников.`
            : `Вы больше не будете видеть участников «${room.name}». Вернуться можно по коду.`}
        </p>
      </Modal>
    </div>
  )
}

function LinkPill({ link, lanOn }: { link: LanPeerLink | undefined; lanOn: boolean }) {
  if (!lanOn || !link) return null
  if (!link.online) return <Pill>не в сети</Pill>
  const ms = link.latencyMs !== null ? ` · ${link.latencyMs} мс` : ''
  if (link.path === 'direct') {
    return (
      <Pill tone="green" title="Компьютеры связаны напрямую — лучший вариант для игры">
        напрямую{ms}
      </Pill>
    )
  }
  if (link.path === 'relay') {
    return (
      <Pill
        tone="amber"
        title="Прямое соединение не получилось (строгий NAT у кого-то из вас) — данные идут через сервер CipherWay"
      >
        через сервер{ms}
      </Pill>
    )
  }
  return <Pill tone="neutral">соединяемся…{ms}</Pill>
}

function MemberRow({
  member,
  room,
  view,
  busy,
  run
}: {
  member: LanMember
  room: LanRoom
  view: LanView
  busy: boolean
  run: Run
}) {
  const devices = member.devices.length ? member.devices : [{ name: '', ip: null, online: false }]
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-panel px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-[13px] font-medium text-text-primary">
          {member.label}
          {member.isSelf && (
            <span className="ml-1.5 text-[11px] font-normal text-text-faint">(вы)</span>
          )}
        </span>
        {room.isOwner && !member.isSelf && (
          <button
            disabled={busy}
            className="no-drag text-[11px] text-text-faint hover:text-accent-red disabled:opacity-50"
            onClick={() =>
              void run(
                () => window.api.lan.kick(room.id, member.memberId),
                `${member.label} исключён, код комнаты сменился`
              )
            }
          >
            Исключить
          </button>
        )}
      </div>
      <div className="mt-1 space-y-1">
        {devices.map((d, i) => {
          const link = d.ip ? view.links[d.ip] : undefined
          const online = member.isSelf ? d.online : (link?.online ?? d.online)
          return (
            <div key={`${d.ip ?? ''}-${i}`} className="flex items-center gap-2 text-[12px]">
              <OnlineDot online={online} />
              <span className="min-w-0 truncate text-text-muted">
                {d.name || 'нет устройств в сети'}
              </span>
              {d.ip && (
                <>
                  <span className="font-mono text-text-secondary">{d.ip}</span>
                  <CopyButton text={d.ip} what="Адрес скопирован" />
                </>
              )}
              {!member.isSelf && d.ip && (
                <span className="ml-auto">
                  <LinkPill link={link} lanOn={view.phase === 'on'} />
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- Minecraft how-to -----------------------------------------------------------

function MinecraftCard({ selfIp }: { selfIp: string | null }) {
  const ip = selfIp ?? '100.x.y.z'
  return (
    <Card className="p-5">
      <div className="text-sm font-semibold text-text-primary">Как поиграть в Minecraft (Java)</div>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-text-muted">
        <li>Включите LAN у себя и у друга, оба зайдите в одну комнату.</li>
        <li>
          Кто открывает мир: зайдите в него, нажмите Esc →{' '}
          <b className="text-text-secondary">«Открыть для сети»</b> →{' '}
          <b className="text-text-secondary">«Открыть мир для сети»</b>. В чате появится номер
          порта, например{' '}
          <span className="font-mono">«Локальный сервер запущен на порте 51234»</span>.
        </li>
        <li>
          Друг: <b className="text-text-secondary">«Сетевая игра»</b> →{' '}
          <b className="text-text-secondary">«Прямое подключение»</b> → вводит{' '}
          <span className="font-mono text-text-secondary">{ip}:51234</span> — ваш LAN-адрес и порт
          из чата.
        </li>
        <li>
          Если Windows спросит про брандмауэр для Java — разрешите доступ, иначе друг не
          подключится.
        </li>
      </ol>
      <p className="mt-3 text-[11px] text-text-faint">
        Мир из списка «Сетевая игра» сам пока не появляется — подключайтесь по адресу. Автопоиск
        LAN-миров добавим в следующей версии.
      </p>
    </Card>
  )
}

// --- dialogs --------------------------------------------------------------------

function NameDialog({
  open,
  onClose,
  onSubmit,
  busy
}: {
  open: boolean
  onClose: () => void
  onSubmit: (name: string) => void
  busy: boolean
}) {
  const [name, setName] = useState('')
  useEffect(() => {
    if (open) setName('')
  }, [open])
  const ok = name.trim().length > 0 && name.trim().length <= 40
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Новая комната"
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отмена
          </Button>
          <Button size="sm" disabled={!ok || busy} onClick={() => onSubmit(name.trim())}>
            Создать
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        placeholder="Например: Майнкрафт с Петей"
        maxLength={40}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && ok && !busy && onSubmit(name.trim())}
      />
      <p className="mt-2 text-[11px] text-text-faint">
        После создания появится код из 6 символов — отправьте его друзьям.
      </p>
    </Modal>
  )
}

function CodeDialog({
  open,
  onClose,
  onSubmit,
  busy
}: {
  open: boolean
  onClose: () => void
  onSubmit: (code: string) => void
  busy: boolean
}) {
  const [code, setCode] = useState('')
  useEffect(() => {
    if (open) setCode('')
  }, [open])
  const clean = code.replace(/[\s-]/g, '').toUpperCase()
  const ok = /^[A-Z0-9]{6}$/.test(clean)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Войти в комнату по коду"
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отмена
          </Button>
          <Button size="sm" disabled={!ok || busy} onClick={() => onSubmit(clean)}>
            Войти
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        mono
        placeholder="ABC234"
        maxLength={12}
        value={code}
        className="text-center text-lg tracking-[0.3em] uppercase"
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && ok && !busy && onSubmit(clean)}
      />
      <p className="mt-2 text-[11px] text-text-faint">
        Код из 6 букв и цифр — его даёт создатель комнаты.
      </p>
    </Modal>
  )
}
