import { useEffect, useMemo, useState } from 'react'
import type { RoutingRule, RuleConditionType } from '@shared/types'
import { Button, Field, Input, Modal, Select } from '../ui'
import {
  CONDITION_META,
  CONDITION_TYPES,
  GEOIP_CATEGORIES,
  GEOSITE_CATEGORIES
} from '../../lib/ruleMeta'
import { ProcessPicker } from './ProcessPicker'

type Draft = Omit<RoutingRule, 'id'>

const EMPTY: Draft = { enabled: true, conditionType: 'ProcessName', value: '', action: 'PROXY' }

interface Props {
  open: boolean
  initial?: RoutingRule | null
  outboundNames: string[]
  onClose: () => void
  onSave: (draft: Draft) => void
}

export function RuleEditor({ open, initial, outboundNames, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (open) {
      setDraft(initial ? { ...initial } : EMPTY)
      setPickerOpen(false)
    }
  }, [open, initial])

  const meta = CONDITION_META[draft.conditionType]
  const isProcess = draft.conditionType === 'ProcessName' || draft.conditionType === 'ProcessPath'

  const datalist = useMemo(() => {
    if (draft.conditionType === 'GeoSite') return GEOSITE_CATEGORIES
    if (draft.conditionType === 'GeoIP') return GEOIP_CATEGORIES
    return []
  }, [draft.conditionType])

  const actionOptions = useMemo(
    () => [
      { value: 'PROXY', label: 'PROXY (через туннель)' },
      { value: 'DIRECT', label: 'DIRECT (напрямую)' },
      { value: 'REJECT', label: 'REJECT (блокировать)' },
      ...outboundNames.map((n) => ({ value: n, label: n }))
    ],
    [outboundNames]
  )

  const valid = draft.value.trim().length > 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? 'Редактировать правило' : 'Новое правило'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={!valid} onClick={() => onSave({ ...draft, value: draft.value.trim() })}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Тип условия">
          <Select
            value={draft.conditionType}
            options={CONDITION_TYPES.map((t) => ({ value: t, label: CONDITION_META[t].label }))}
            onChange={(v) =>
              setDraft((d) => ({ ...d, conditionType: v as RuleConditionType, value: '' }))
            }
          />
        </Field>

        <Field label="Значение" hint={isProcess ? 'Введите вручную или выберите процесс' : undefined}>
          <div className="flex gap-2">
            <Input
              list={datalist.length ? 'rule-autocomplete' : undefined}
              mono={meta.mono}
              placeholder={meta.placeholder}
              value={draft.value}
              onChange={(e) => setDraft((d) => ({ ...d, value: e.target.value }))}
            />
            {isProcess && (
              <Button variant="secondary" className="shrink-0" onClick={() => setPickerOpen(true)}>
                Выбрать
              </Button>
            )}
          </div>
          {datalist.length > 0 && (
            <datalist id="rule-autocomplete">
              {datalist.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          )}
        </Field>

        <Field label="Действие">
          <Select
            value={draft.action}
            options={actionOptions}
            onChange={(v) => setDraft((d) => ({ ...d, action: v }))}
          />
        </Field>
      </div>

      <ProcessPicker
        open={pickerOpen}
        mode={draft.conditionType === 'ProcessPath' ? 'path' : 'name'}
        onClose={() => setPickerOpen(false)}
        onPick={(value) => {
          setDraft((d) => ({ ...d, value }))
          setPickerOpen(false)
        }}
      />
    </Modal>
  )
}
