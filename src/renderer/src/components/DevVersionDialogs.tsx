import { useEffect, useState } from 'react'
import {
  DEV_CONSENT,
  DEV_CONSENT_CHECKBOX,
  DEV_CONSENT_TITLE,
  DEV_CONSENT_VERSION,
  canEnableDev
} from '@shared/devversion'
import { Button, Modal } from './ui'

/** The consent text (consent_version 1); «Включить» only with the box ticked. */
export function DevConsentModal({
  open,
  busy,
  onCancel,
  onAccept
}: {
  open: boolean
  busy: boolean
  onCancel: () => void
  onAccept: (consentVersion: string) => void
}) {
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (open) setChecked(false)
  }, [open])
  const can = canEnableDev(checked) && !busy

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={DEV_CONSENT_TITLE}
      width="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
          <Button disabled={!can} onClick={() => onAccept(DEV_CONSENT_VERSION)}>
            Включить
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] leading-relaxed text-text-secondary">
        <p>{DEV_CONSENT.intro}</p>
        <ul className="list-disc space-y-1.5 pl-5">
          {DEV_CONSENT.items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        {DEV_CONSENT.after.map((t) => (
          <p key={t}>{t}</p>
        ))}
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border-default bg-bg-panel-alt px-3 py-2.5 text-text-primary">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent-green"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          {DEV_CONSENT_CHECKBOX}
        </label>
      </div>
    </Modal>
  )
}

/** Off: confirm; optionally the reports on the server go too. */
export function DevDisableModal({
  open,
  busy,
  onCancel,
  onConfirm
}: {
  open: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: (deleteRemote: boolean) => void
}) {
  const [remote, setRemote] = useState(false)
  useEffect(() => {
    if (open) setRemote(false)
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Выключить DevVersion?"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => onConfirm(remote)}>
            Выключить
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] leading-relaxed text-text-secondary">
        <p>
          Сбор данных сразу прекратится, а всё, что собрано на этом компьютере и ещё не отправлено,
          будет удалено. Цвета приложения вернутся к обычным.
        </p>
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-border-default bg-bg-panel-alt px-3 py-2.5 text-text-primary">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent-green"
            checked={remote}
            onChange={(e) => setRemote(e.target.checked)}
          />
          Также удалить уже отправленные данные с серверов CipherWay
        </label>
      </div>
    </Modal>
  )
}

/** «Удалить отправленные данные»: one more question before the DELETE. */
export function DevDeleteRemoteModal({
  open,
  busy,
  onCancel,
  onConfirm
}: {
  open: boolean
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Удалить отправленные данные?"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Отмена
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            Удалить
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-text-secondary">
        Все отчёты DevVersion этой подписки будут удалены с серверов CipherWay. Сбор продолжится —
        чтобы его остановить, выключите DevVersion.
      </p>
    </Modal>
  )
}
