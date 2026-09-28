import { describe, expect, it } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from './index'

describe('pricing route', () => {
  it('makes the price guide available at /pricing', () => {
    const router = createAppRouter(createMemoryHistory())

    const resolved = router.resolve('/pricing')

    expect(resolved.name).toBe('pricing')
    expect(resolved.matched).toHaveLength(1)
  })
})
