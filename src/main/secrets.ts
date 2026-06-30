import { safeStorage } from 'electron'
import { store } from './store'

/**
 * Encrypts the subscription URL on disk using the OS keychain via Electron's
 * safeStorage. Falls back to a marked plaintext value if encryption is
 * unavailable (e.g. headless CI), so the app still works but the value is
 * clearly not protected.
 */
const PLAIN_PREFIX = 'plain:'

export function setSubscriptionUrl(url: string | null): void {
  if (!url) {
    store.set('subscriptionUrlEnc', null)
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(url).toString('base64')
    store.set('subscriptionUrlEnc', enc)
  } else {
    store.set('subscriptionUrlEnc', PLAIN_PREFIX + Buffer.from(url, 'utf8').toString('base64'))
  }
}

export function getSubscriptionUrl(): string | null {
  const enc = store.get('subscriptionUrlEnc')
  if (!enc) return null
  if (enc.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(enc.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}
