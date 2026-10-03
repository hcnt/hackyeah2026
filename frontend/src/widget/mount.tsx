import { createRoot, type Root } from 'react-dom/client'
import Widget, { type WidgetProps } from './Widget'
import css from './widget.css?inline'

/** Renders the widget inside a shadow root so host-page CSS and ours don't leak into each other. */
export function mountWidget(host: HTMLElement, props: WidgetProps): Root {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  shadow.replaceChildren()
  const style = document.createElement('style')
  style.textContent = css
  const container = document.createElement('div')
  shadow.append(style, container)
  const root = createRoot(container)
  root.render(<Widget {...props} />)
  return root
}
