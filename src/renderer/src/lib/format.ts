const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 Б'
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / Math.pow(1024, i)
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${UNITS[i]}`
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/с`
}

export function formatDate(unixSeconds?: number): string {
  if (!unixSeconds) return '—'
  return new Date(unixSeconds * 1000).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

/** Whole days until `unixSeconds`; null = no expiry. */
export function daysLeft(unixSeconds?: number): number | null {
  if (!unixSeconds) return null
  return Math.max(0, Math.ceil((unixSeconds * 1000 - Date.now()) / 86_400_000))
}

/** 1 день, 2 дня, 5 дней */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

export function formatDays(n: number): string {
  return `${n} ${plural(n, 'день', 'дня', 'дней')}`
}

/** «только что», «3 мин назад», «2 ч назад», «вчера», date */
export function formatAgo(ts: number | null | undefined): string {
  if (!ts) return 'никогда'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'только что'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} мин назад`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч назад`
  const d = Math.round(h / 24)
  if (d === 1) return 'вчера'
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

/** connection age: 12 с, 4 мин, 1 ч 05 мин */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  return `${h} ч ${String(m % 60).padStart(2, '0')} мин`
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export const PROTOCOL_LABEL: Record<string, string> = {
  vless: 'VLESS',
  hysteria2: 'Hysteria2',
  vmess: 'VMess'
}

/** ipcRenderer.invoke wraps errors: "Error invoking remote method 'x': Error: …" */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']*':\s*(\w*Error:\s*)?/, '')
}
