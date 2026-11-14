export function heartStarToolUrl(baseUrl: string, search: string): string {
  const query = new URLSearchParams({ v: 'desktop-templates-1' })
  const template = new URLSearchParams(search).get('template')
  if (template && template.length <= 100) query.set('template', template)
  return `${baseUrl}embedded/heart-star/index.html?${query}`
}
