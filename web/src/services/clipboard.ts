export interface ClipboardWriter {
  writeText(text: string): Promise<void>
}

export type LegacyCopy = (text: string) => boolean

export async function runCopyDownloadStep(
  copied: boolean,
  copy: () => Promise<boolean>,
  download: () => void,
): Promise<boolean> {
  if (!copied) return copy()
  download()
  return true
}

function getBrowserClipboard(): ClipboardWriter | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator.clipboard
}

function copyWithTextArea(text: string): boolean {
  if (typeof document === 'undefined') return false
  const textArea = document.createElement('textarea')
  textArea.value = text
  textArea.setAttribute('readonly', '')
  textArea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  document.body.append(textArea)
  textArea.select()
  textArea.setSelectionRange(0, textArea.value.length)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    textArea.remove()
  }
  return copied
}

export async function copyText(
  text: string,
  clipboard: ClipboardWriter | undefined = getBrowserClipboard(),
  legacyCopy: LegacyCopy = copyWithTextArea,
): Promise<boolean> {
  if (clipboard) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Clipboard API may be blocked outside HTTPS or by browser permissions.
    }
  }

  try {
    return legacyCopy(text)
  } catch {
    return false
  }
}
