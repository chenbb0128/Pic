import { describe, expect, it } from 'vitest'
import source from '../../public/embedded/heart-star/template-link.js?raw'
import { heartStarToolUrl } from './heartStarTemplateLink'

describe('desktop template deep links', () => {
  it('passes the template through the page to the editor and selects it before load', () => {
    const scope: any = {}
    new Function('globalThis', source)(scope)
    for (const name of ['缤纷糖果.png', '模板混合.png', '爱心横版.png']) {
      const url = new URL(heartStarToolUrl('/', `?template=${encodeURIComponent(name)}&order=private`), 'https://pic.example')
      const select = { value: '模板爱心.png', options: [{ value: '模板爱心.png' }, { value: name }] }
      expect(scope.HeartStarTemplateLink.selectInitial(select, { [name]: {} }, url.search)).toBe(true)
      expect(select.value).toBe(name)
      expect(url.searchParams.has('order')).toBe(false)
    }
    const select = { value: '模板爱心.png', options: [{ value: '模板爱心.png' }] }
    for (const search of ['', '?template=missing', '?template=__proto__']) {
      expect(scope.HeartStarTemplateLink.selectInitial(select, { '模板爱心.png': {} }, search)).toBe(false)
      expect(select.value).toBe('模板爱心.png')
    }
  })
})
