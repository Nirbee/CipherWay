// ---------------------------------------------------------------------------
// Country of a server from its name. Panels put emoji flags into host names
// («🇳🇱 Нидерланды»), but Windows has no flag glyphs — Chromium draws them as
// two letters. So the flag is taken out of the label and drawn by the UI
// (see renderer components/Flag.tsx); without an emoji the country is guessed
// from words in the name. Pure — unit tested in flags.test.ts.
// ---------------------------------------------------------------------------

export interface ServerLabel {
  /** ISO 3166-1 alpha-2, upper case */
  code?: string
  /** name without the emoji flag */
  label: string
}

const RI_BASE = 0x1f1e6 // REGIONAL INDICATOR SYMBOL LETTER A
const FLAG_RE = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/u
const FLAG_RE_G = /[\u{1F1E6}-\u{1F1FF}]{2}/gu

const KEYWORDS: [RegExp, string][] = [
  [/нидерланд|netherland|holland|голланд|amsterdam|амстердам|eygelshoven/iu, 'NL'],
  [/герман|germany|deutschland|frankfurt|франкфурт|berlin|берлин|nuremberg|нюрнберг/iu, 'DE'],
  [/финлян|finland|helsinki|хельсинки/iu, 'FI'],
  [/росси|russia|moscow|москв|петербург|(?<!\p{L})спб(?!\p{L})/iu, 'RU'],
  [/польш|poland|warsaw|варшав/iu, 'PL'],
  [/швеци|sweden|stockholm|стокгольм/iu, 'SE'],
  [/норвег|norway|oslo/iu, 'NO'],
  [/дани[яи]|denmark/iu, 'DK'],
  [/исланд|iceland/iu, 'IS'],
  [/франци|france|paris|париж/iu, 'FR'],
  [/великобрит|британ|united kingdom|england|london|лондон|\buk\b/iu, 'GB'],
  [/(?<!\p{L})сша(?!\p{L})|\busa\b|united states|америк|new york|нью-йорк/iu, 'US'],
  [/казахст|kazakh|алмат/iu, 'KZ'],
  [/турци|turkey|türkiye|стамбул|istanbul/iu, 'TR'],
  [/латви|latvia|рига|\briga\b/iu, 'LV'],
  [/литв|lithuan|вильнюс|vilnius/iu, 'LT'],
  [/эстон|estonia|tallinn|таллин/iu, 'EE'],
  [/швейцар|switzerland|zurich|цюрих/iu, 'CH'],
  [/австри|austria|vienna|(?<!\p{L})вена(?!\p{L})/iu, 'AT'],
  [/итали|italy|milan|милан/iu, 'IT'],
  [/испани|spain|madrid|мадрид/iu, 'ES'],
  [/португал|portugal|lisbon/iu, 'PT'],
  [/япони|japan|tokyo|токио/iu, 'JP'],
  [/сингапур|singapore/iu, 'SG'],
  [/гонконг|hong ?kong/iu, 'HK'],
  [/канад|canada|toronto/iu, 'CA'],
  [/украин|ukrain|киев|kyiv/iu, 'UA'],
  [/молдов|moldova/iu, 'MD'],
  [/румын|romania/iu, 'RO'],
  [/болгар|bulgaria|софия/iu, 'BG'],
  [/венгр|hungary|budapest/iu, 'HU'],
  [/чехи|czech|prague|праг/iu, 'CZ'],
  [/серби|serbia|belgrade/iu, 'RS'],
  [/армени|armenia|ереван/iu, 'AM'],
  [/грузи|georgia|тбилиси/iu, 'GE'],
  [/израил|israel/iu, 'IL'],
  [/(?<!\p{L})оаэ(?!\p{L})|\buae\b|emirates|дубай|dubai/iu, 'AE'],
  [/инди[яи]|\bindia\b/iu, 'IN'],
  [/ирланд|ireland|dublin/iu, 'IE'],
  [/бельги|belgium|brussels/iu, 'BE'],
  [/люксемб|luxemb/iu, 'LU']
]

function codeFromEmoji(name: string): string | undefined {
  const m = FLAG_RE.exec(name)
  if (!m) return undefined
  const a = m[1].codePointAt(0)! - RI_BASE
  const b = m[2].codePointAt(0)! - RI_BASE
  return String.fromCharCode(65 + a, 65 + b)
}

function codeFromWords(text: string): string | undefined {
  let best: { idx: number; code: string } | undefined
  for (const [re, code] of KEYWORDS) {
    const m = re.exec(text)
    if (m && (best === undefined || m.index < best.idx)) best = { idx: m.index, code }
  }
  return best?.code
}

export function parseServerName(name: string): ServerLabel {
  const raw = name ?? ''
  const flags = [...raw.matchAll(FLAG_RE_G)].map((m) => codeFromEmoji(m[0]))
  // cascade «A —> B»: the exit country (last flag / after the arrow) matters
  let code = flags.at(-1)
  if (!code) {
    const parts = raw.split(/\s*(?:->|—>|–>|→|=>|»)\s*/)
    code = codeFromWords(parts.at(-1) ?? raw) ?? codeFromWords(raw)
  }
  const label = raw.replace(FLAG_RE_G, ' ').replace(/\s+/g, ' ').replace(/^[\s|·•-]+/, '').trim()
  return { code, label: label || raw.trim() || 'Сервер' }
}
