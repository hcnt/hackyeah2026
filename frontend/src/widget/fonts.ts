import regular from './assets/fonts/Satoshi-Regular.woff2?inline'
import medium from './assets/fonts/Satoshi-Medium.woff2?inline'
import bold from './assets/fonts/Satoshi-Bold.woff2?inline'
import black from './assets/fonts/Satoshi-Black.woff2?inline'

const FAMILY = 'Attend Now Satoshi'

/**
 * Registers Satoshi on the host document. @font-face rules inside a shadow root are ignored by browsers,
 * so the faces go on the page itself, under a family name no host page will use.
 */
export function ensureFonts(): void {
  if (document.getElementById('attend-now-fonts')) return
  const style = document.createElement('style')
  style.id = 'attend-now-fonts'
  style.textContent = (
    [[regular, 400], [medium, 500], [bold, 700], [black, 900]] as const
  )
    .map(([src, weight]) => `@font-face{font-family:'${FAMILY}';src:url(${src}) format('woff2');font-weight:${weight};font-style:normal;font-display:swap}`)
    .join('\n')
  document.head.append(style)
}
