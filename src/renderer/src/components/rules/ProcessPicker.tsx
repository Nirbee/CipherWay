import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '../ui'

interface Proc {
  name: string
  path: string
  pid: number
}

interface Props {
  open: boolean
  mode: 'name' | 'path'
  onClose: () => void
  onPick: (value: string) => void
}

export function ProcessPicker({ open, mode, onClose, onPick }: Props) {
  const [procs, setProcs] = useState<Proc[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setFilter('')
    window.api.rules
      .processList()
      .then(setProcs)
      .finally(() => setLoading(false))
  }, [open])

  const pickValue = (p: Proc) => onPick(mode === 'path' ? p.path || p.name : p.name)

  const filtered = procs.filter(
    (p) =>
      p.name.toLowerCase().includes(filter.toLowerCase()) ||
      p.path.toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Выбор процесса"
      footer={
        <Button
          variant="secondary"
          onClick={async () => {
            const picked = await window.api.rules.pickExecutable()
            if (picked) onPick(mode === 'path' ? picked.path : picked.name)
          }}
        >
          Выбрать .exe файл…
        </Button>
      }
    >
      <Input
        placeholder="Фильтр процессов…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="mb-3"
      />
      <div className="max-h-[44vh] overflow-y-auto rounded-xl border border-border-default">
        {loading && <div className="px-4 py-6 text-center text-sm text-text-muted">Загрузка…</div>}
        {!loading && filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-text-muted">Ничего не найдено</div>
        )}
        {filtered.map((p) => (
          <button
            key={`${p.name}-${p.pid}`}
            onClick={() => pickValue(p)}
            className="flex w-full flex-col items-start gap-0.5 border-b border-border-subtle px-3.5 py-2.5 text-left last:border-0 hover:bg-bg-elevated"
          >
            <span className="font-mono text-sm text-text-primary">{p.name}</span>
            {p.path && <span className="truncate font-mono text-[11px] text-text-faint">{p.path}</span>}
          </button>
        ))}
      </div>
    </Modal>
  )
}
