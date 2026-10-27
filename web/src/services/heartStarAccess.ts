const STORAGE_KEY = 'pic:heart-star:access'
function clearLegacyAccess(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* Storage may be disabled. */ }
}

async function sessionRequest(method: string, path = '/session', password?: string): Promise<unknown> {
  let response: Response, body: { code: number; message?: string; data?: unknown }
  try {
    response = await fetch('/api/v1' + path, {
      method, credentials: 'same-origin', signal: AbortSignal.timeout(15000),
      ...(password === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }),
    })
    body = await response.json()
  } catch { throw Error('访问验证服务暂不可用，请检查后端服务后重试。') }
  if (!response.ok) throw Object.assign(Error(body?.message || '访问验证失败，请重试。'), { status: response.status })
  if (body?.code !== 0 || !Object.hasOwn(body, 'data')) throw Error('访问验证服务返回异常，请稍后重试。')
  return body.data
}

export async function clearHeartStarAccess(): Promise<void> {
  try { await sessionRequest('DELETE') }
  catch (error) { if ((error as { status?: number }).status !== 401) throw error }
  clearLegacyAccess()
}

export async function hasHeartStarAccess(): Promise<boolean> {
  clearLegacyAccess()
  try { await sessionRequest('GET'); return true }
  catch (error) {
    if ((error as { status?: number }).status === 401) return false
    throw error
  }
}

export async function rememberHeartStarAccess(password: string): Promise<void> {
  await sessionRequest('POST', '/tool-session', password)
  clearLegacyAccess()
}
