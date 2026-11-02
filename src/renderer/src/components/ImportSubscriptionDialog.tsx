import { useCallback, useEffect, useState } from 'react'
import type { ImportRequest } from '@shared/types'
import { Button, Modal } from './ui'
import { useSubscription } from '../store/subscriptionStore'
import { useNav } from '../store/navStore'

/**
 * Confirmation for cipherway://import links. The main process validates the
 * link (https only) and parks it; we pull it here, ask the user, and only
 * then fetch the subscription. Never connects automatically.
 */
export function ImportSubscriptionDialog() {
  const [req, setReq] = useState<ImportRequest | null>(null)
  const { data, loading, error, fetch } = useSubscription()
  const setPage = useNav((s) => s.setPage)
  const [submitted, setSubmitted] = useState(false)

  const pull = useCallback(() => {
    void window.api.deeplink.takePending().then((next) => {
      if (next) {
        setSubmitted(false)
        setReq(next)
      }
    })
  }, [])

  useEffect(() => {
    pull() // a link that launched the app arrives before we subscribe
    return window.api.on.importRequest(pull)
  }, [pull])

  const close = () => {
    if (!loading) setReq(null)
  }

  const confirm = async () => {
    if (!req) return
    setSubmitted(true)
    const ok = await fetch(req.url)
    if (ok) {
      setReq(null)
      setPage('subscription')
    }
  }

  return (
    <Modal
      open={req !== null}
      onClose={close}
      title="Добавить подписку"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={loading}>
            Отмена
          </Button>
          <Button onClick={confirm} disabled={loading}>
            {loading ? 'Загрузка…' : 'Добавить'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-text-secondary">
        <p>
          Добавить подписку с{' '}
          <span className="font-mono font-semibold text-text-primary">{req?.host}</span>?
        </p>
        {data && (
          <p className="text-xs text-text-muted">
            Текущая подписка будет заменена. Подключение не начнётся само — нажмите «Подключить» на
            главном экране.
          </p>
        )}
        {submitted && error && <p className="text-xs text-accent-red">{error}</p>}
      </div>
    </Modal>
  )
}
