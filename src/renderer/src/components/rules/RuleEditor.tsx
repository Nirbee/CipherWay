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
import { validateValue } from '@shared/rulesText'
import { ZAPRET_ACTION, ZAPRET_PROCESS_HINT, zapretRuleTarget } from '@shared/zapret'

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
      { value: 'PROXY', label: 'Через VPN (текущий сервер)' },
      { value: 'DIRECT', label: 'Напрямую' },
      { value: ZAPRET_ACTION, label: 'Напрямую + zapret' },
      { value: 'REJECT', label: 'Блокировать' },
      ...outboundNames.map((n) => ({ value: n, label: `Через VPN · только ${n}` }))
    ],
    [outboundNames]
  )

  const check = draft.value.trim() ? validateValue(draft.conditionType, draft.value) : null
  // «Напрямую + zapret»: only conditions zapret can take (a host list / an address list)
  const isZapret = draft.action === ZAPRET_ACTION
  const zt = isZapret && check?.ok ? zapretRuleTarget({ ...draft, value: check.value }) : null
  const zapretBad = isZapret && !!check?.ok && zt !== null && !zt.ok
  const valid = check?.ok === true && !zapretBad

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
          <Button
            disabled={!valid}
            onClick={() => check?.ok && onSave({ ...draft, value: check.value })}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Тип условия">
          <Select
            value={draft.conditionType}
            options={CONDITION_TYPES.map((t) => ({
              value: t,
              label: `${CONDITION_META[t].label} — ${CONDITION_META[t].clash}`
            }))}
            onChange={(v) =>
              setDraft((d) => ({ ...d, conditionType: v as RuleConditionType, value: '' }))
            }
          />
        </Field>

        <Field
          label="Значение"
          hint={
            check && !check.ok
              ? `Ошибка: ${check.reason}`
              : isProcess
                ? 'Введите вручную или выберите запущенную программу'
                : meta.hint
          }
        >
          <div className="flex gap-2">
            <Input
              list={datalist.length ? 'rule-autocomplete' : undefined}
              mono={meta.mono}
              invalid={!!check && !check.ok}
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

        <Field
          label="Действие"
          hint={
            zt && !zt.ok
              ? zt.reason
              : isZapret && isProcess
                ? ZAPRET_PROCESS_HINT
                : isZapret
                  ? 'Напрямую, а zapret снимает замедление провайдера. Работает, когда в «Ускорении без VPN» включён zapret; иначе — просто напрямую.'
                : undefined
          }
        >
          <Select
            value={draft.action}
            options={actionOptions}
            onChange={(v) => setDraft((d) => ({ ...d, action: v }))}
          />
        </Field>
        {/* a program is never checked: no way back to the VPN (0.7.4) */}
        {isZapret && !isProcess && (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-text-primary">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent-green"
              checked={draft.zapretFallback !== false}
              onChange={(e) => setDraft((d) => ({ ...d, zapretFallback: e.target.checked }))}
            />
            Если напрямую не открывается — через VPN
          </label>
        )}
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
