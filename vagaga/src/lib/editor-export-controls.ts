import { createApp } from 'vue'
import EditorExportControls from '../components/EditorExportControls.vue'
import stylesheet from '../style.css?inline'

export function mountEditorExportControls(document: Document) {
  const host = document.getElementById('exportControls')
  const source = document.getElementById('exportControlsFallback')
  const filename = document.querySelector<HTMLOutputElement>('#exportFilename')
  if (!host || !source || !filename) return

  // Keep the component styles isolated from the editor's standalone styles.
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = stylesheet + `
    @layer base { *, ::before, ::after { border: 0 solid; --tw-border-style: solid; } }
    [data-slot="switch-thumb"][data-state="checked"] { translate: calc(100% - 2px) 0; }
  `
  const container = document.createElement('div')
  root.replaceChildren(style, container)
  const app = createApp(EditorExportControls, { source, filename })
  app.mount(container)
  host.hidden = false
  source.hidden = true

  return () => {
    app.unmount()
    root.replaceChildren()
    host.hidden = true
    source.hidden = false
  }
}
