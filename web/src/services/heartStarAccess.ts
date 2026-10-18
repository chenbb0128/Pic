const STORAGE_KEY = 'pic:heart-star:access'
const ACCESS_DURATION_MS = 30 * 24 * 60 * 60 * 1000

async function passwordVersion(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function clearHeartStarAccess(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* Storage may be disabled. */ }
}

export async function hasHeartStarAccess(password: string): Promise<boolean> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return false
    const record = JSON.parse(saved)
    if (record && Number.isFinite(record.expiresAt) && record.expiresAt > Date.now()
      && record.expiresAt <= Date.now() + ACCESS_DURATION_MS
      && record.passwordVersion === await passwordVersion(password)) return true
  } catch { /* Invalid or unavailable storage must not prevent manual unlocking. */ }
  clearHeartStarAccess()
  return false
}

export async function rememberHeartStarAccess(password: string): Promise<void> {
  try {
    const version = await passwordVersion(password)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      passwordVersion: version,
      expiresAt: Date.now() + ACCESS_DURATION_MS,
    }))
  } catch { /* Manual access still works when persistence is unavailable. */ }
}
