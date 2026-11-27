import { useEffect } from 'react'
import { create } from 'zustand'
import { resolveNewYear, type NewYearLevel } from '@shared/seasonal'
import { useSettings } from '../store/settingsStore'

/** «now», refreshed every 10 minutes: «Авто» switches on / off by itself at the season edges. */
const useClock = create<{ now: number }>(() => ({ now: Date.now() }))
let clockStarted = false
function startClock(): void {
  if (clockStarted) return
  clockStarted = true
  setInterval(() => useClock.setState({ now: Date.now() }), 10 * 60_000)
}

/** What «Новогоднее оформление» draws right now ('off' until the settings are loaded). */
export function useNewYear(): NewYearLevel {
  const loaded = useSettings((s) => s.settings !== null)
  const mode = useSettings((s) => s.settings?.newYearDecor)
  const now = useClock((s) => s.now)
  useEffect(startClock, [])
  return loaded ? resolveNewYear(mode, new Date(now)) : 'off'
}

/** prefers-reduced-motion («Анимация в Windows» off), live. */
export function reducedMotion(): MediaQueryList {
  return window.matchMedia('(prefers-reduced-motion: reduce)')
}
