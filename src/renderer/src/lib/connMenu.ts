import type { ConnItem, RoutingRule } from '@shared/types'
import { validateValue } from '@shared/rulesText'
import { ZAPRET_ACTION, zapretRuleTarget } from '@shared/zapret'

// ---------------------------------------------------------------------------
// «Подключения» → right click on a program (0.7.3): a rule for its exe
// («Через VPN» / «Напрямую» / «Напрямую + zapret») in the same form the rule
// editor makes (PROCESS-NAME = the exe's file name), never a duplicate: an
// existing rule for that exe gets the new action instead. Pure — unit tested
// in connMenu.test.ts.
// ---------------------------------------------------------------------------

export type ProcessRuleAction = 'PROXY' | 'DIRECT' | typeof ZAPRET_ACTION

export const PROCESS_RULE_ACTIONS: readonly ProcessRuleAction[] = ['PROXY', 'DIRECT', ZAPRET_ACTION]

export const PROCESS_ACTION_TEXT: Record<ProcessRuleAction, string> = {
  PROXY: 'Через VPN',
  DIRECT: 'Напрямую',
  [ZAPRET_ACTION]: 'Напрямую + zapret'
}

/** the exe name a «программа» rule can take, or null (a system connection without a process path) */
export function processRuleName(process: string | undefined | null): string | null {
  const name = (process ?? '').trim()
  if (!name || name === '—') return null
  const v = validateValue('ProcessName', name)
  return v.ok ? v.value : null
}

/** «Напрямую + zapret» can be a rule for a program (zapret's own check of the condition) */
export function zapretForProgram(exe: string): boolean {
  return zapretRuleTarget({ conditionType: 'ProcessName', value: exe }).ok
}

/**
 * The user's rule for this exe: «программа <exe>» (any case), or «путь …»
 * to this very file (`path`, when known) — the first one in the list.
 */
export function findProcessRule(
  rules: readonly RoutingRule[],
  exe: string,
  path?: string
): RoutingRule | null {
  const name = exe.toLowerCase()
  const full = path?.trim().toLowerCase()
  for (const r of rules) {
    const v = r.value.trim().toLowerCase()
    if (r.conditionType === 'ProcessName' && v === name) return r
    if (r.conditionType === 'ProcessPath' && (full ? v === full : false)) return r
  }
  return null
}

export type ProcessRulePlan =
  /** no rule for this exe yet: add this one at the top */
  | { kind: 'add'; rule: Omit<RoutingRule, 'id'> }
  /** a rule exists with another action (or switched off): offer to change it */
  | { kind: 'change'; rule: RoutingRule; patch: Partial<RoutingRule> }
  /** the same rule is already there and on */
  | { kind: 'same'; rule: RoutingRule }

export function planProcessRule(
  rules: readonly RoutingRule[],
  exe: string,
  action: ProcessRuleAction,
  path?: string
): ProcessRulePlan {
  const cur = findProcessRule(rules, exe, path)
  if (!cur) {
    return { kind: 'add', rule: { enabled: true, conditionType: 'ProcessName', value: exe, action } }
  }
  if (cur.action === action && cur.enabled) return { kind: 'same', rule: cur }
  const patch: Partial<RoutingRule> = { action, enabled: true }
  // «Напрямую + zapret»'s own option means nothing for another action
  if (action !== ZAPRET_ACTION && cur.zapretFallback !== undefined) patch.zapretFallback = undefined
  return { kind: 'change', rule: cur, patch }
}

/** «Через VPN · только <сервер>» and the like — the action of a rule as the user reads it */
export function ruleActionText(action: string): string {
  if (action === 'PROXY') return 'Через VPN'
  if (action === 'DIRECT') return 'Напрямую'
  if (action === ZAPRET_ACTION) return 'Напрямую + zapret'
  if (action === 'REJECT' || action === 'BLOCK') return 'Блокировать'
  return `Через VPN · только ${action}`
}

/** the key a connection's program is grouped by (ConnectionsPage) */
export const processKey = (process: string | undefined): string => (process ?? '').toLowerCase() || '—'

/** every live connection of a program (all of them, not only the shown ones) */
export function connIdsOf(items: readonly ConnItem[], key: string): string[] {
  return items.filter((c) => processKey(c.process) === key).map((c) => c.id)
}

/** closes them one by one (Clash API DELETE /connections/<id>); how many were closed */
export async function closeConnections(
  ids: readonly string[],
  close: (id: string) => Promise<void>
): Promise<{ closed: number; failed: number }> {
  const res = await Promise.allSettled(ids.map((id) => close(id)))
  const closed = res.filter((r) => r.status === 'fulfilled').length
  return { closed, failed: res.length - closed }
}
