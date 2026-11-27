import { describe, expect, it, vi } from 'vitest'
import type { ConnItem, RoutingRule } from '@shared/types'
import {
  closeConnections,
  connIdsOf,
  findProcessRule,
  planProcessRule,
  processKey,
  processRuleName,
  ruleActionText,
  zapretForProgram
} from './connMenu'

const rule = (p: Partial<RoutingRule> & Pick<RoutingRule, 'id'>): RoutingRule => ({
  enabled: true,
  conditionType: 'ProcessName',
  value: 'game.exe',
  action: 'PROXY',
  ...p
})

const conn = (id: string, process?: string): ConnItem =>
  ({
    id,
    process,
    host: 'example.com',
    port: '443',
    network: 'tcp',
    rule: 'Всё остальное',
    route: 'proxy',
    upload: 0,
    download: 0,
    uploadSpeed: 0,
    downloadSpeed: 0,
    start: 0
  }) as ConnItem

describe('processRuleName', () => {
  it('an exe name is the rule value, as the rule editor makes it', () => {
    expect(processRuleName('Discord.exe')).toBe('Discord.exe')
    expect(processRuleName('  game.exe ')).toBe('game.exe')
  })
  it('no program (a system connection): no rule', () => {
    expect(processRuleName(undefined)).toBeNull()
    expect(processRuleName('')).toBeNull()
    expect(processRuleName('—')).toBeNull()
  })
})

describe('planProcessRule', () => {
  it('no rule for the exe: a «программа» rule to add (at the top — the caller prepends)', () => {
    expect(planProcessRule([], 'game.exe', 'DIRECT')).toEqual({
      kind: 'add',
      rule: { enabled: true, conditionType: 'ProcessName', value: 'game.exe', action: 'DIRECT' }
    })
  })

  it('a rule for the same exe (another case): the existing one changes, no duplicate', () => {
    const r = rule({ id: 'a', value: 'GAME.EXE', action: 'PROXY' })
    const plan = planProcessRule([rule({ id: 'x', value: 'other.exe' }), r], 'game.exe', 'DIRECT')
    expect(plan).toEqual({ kind: 'change', rule: r, patch: { action: 'DIRECT', enabled: true } })
  })

  it('the same action and on: nothing to do', () => {
    const r = rule({ id: 'a', action: 'DIRECT' })
    expect(planProcessRule([r], 'game.exe', 'DIRECT')).toEqual({ kind: 'same', rule: r })
  })

  it('the same action but switched off: switched on', () => {
    const r = rule({ id: 'a', action: 'DIRECT', enabled: false })
    expect(planProcessRule([r], 'game.exe', 'DIRECT')).toMatchObject({
      kind: 'change',
      patch: { action: 'DIRECT', enabled: true }
    })
  })

  it('from «Напрямую + zapret» to another action: its own option goes', () => {
    const r = rule({ id: 'a', action: 'ZAPRET', zapretFallback: false })
    const plan = planProcessRule([r], 'game.exe', 'PROXY')
    expect(plan.kind).toBe('change')
    if (plan.kind !== 'change') return
    expect('zapretFallback' in plan.patch && plan.patch.zapretFallback === undefined).toBe(true)
  })

  it('a «путь» rule to this very file counts; to another file with that name — not', () => {
    const p = rule({ id: 'p', conditionType: 'ProcessPath', value: 'C:\\Games\\Game.exe' })
    expect(findProcessRule([p], 'game.exe', 'c:\\games\\game.exe')).toBe(p)
    expect(findProcessRule([p], 'game.exe', 'D:\\Other\\game.exe')).toBeNull()
    expect(findProcessRule([p], 'game.exe')).toBeNull()
  })

  it('the first matching rule in the list wins', () => {
    const a = rule({ id: 'a', action: 'DIRECT' })
    const b = rule({ id: 'b', action: 'PROXY' })
    expect(findProcessRule([a, b], 'game.exe')).toBe(a)
  })
})

describe('zapret for a program', () => {
  it('follows what zapret takes from a «программа» rule (not yet in 0.7.3)', () => {
    expect(zapretForProgram('game.exe')).toBe(false)
  })
})

describe('ruleActionText', () => {
  it('reads every action', () => {
    expect(ruleActionText('PROXY')).toBe('Через VPN')
    expect(ruleActionText('DIRECT')).toBe('Напрямую')
    expect(ruleActionText('ZAPRET')).toBe('Напрямую + zapret')
    expect(ruleActionText('REJECT')).toBe('Блокировать')
    expect(ruleActionText('Германия')).toBe('Через VPN · только Германия')
  })
})

describe('closing all connections of a program', () => {
  const items = [conn('1', 'Game.exe'), conn('2', 'other.exe'), conn('3', 'game.exe'), conn('4'), conn('5')]

  it('every connection of the program, any case of its name', () => {
    expect(connIdsOf(items, processKey('GAME.exe'))).toEqual(['1', '3'])
  })

  it('connections without a program are one group of their own', () => {
    expect(connIdsOf(items, processKey(undefined))).toEqual(['4', '5'])
  })

  it('each id is closed; failures are counted, not thrown', async () => {
    const close = vi.fn(async (id: string) => {
      if (id === '3') throw new Error('gone')
    })
    expect(await closeConnections(['1', '3'], close)).toEqual({ closed: 1, failed: 1 })
    expect(close.mock.calls.map((c) => c[0])).toEqual(['1', '3'])
  })

  it('nothing to close: nothing called', async () => {
    const close = vi.fn(async () => undefined)
    expect(await closeConnections([], close)).toEqual({ closed: 0, failed: 0 })
    expect(close).not.toHaveBeenCalled()
  })
})
