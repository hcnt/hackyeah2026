// Entry of the standalone widget.js bundle. Embed on any page:
//
//   <attend-now-widget event-id="EVENT_ID"></attend-now-widget>
//   <script src="https://hackyeah.kindhome.io/widget.js" async></script>
//
// The API origin defaults to wherever widget.js was loaded from; override it with api-base="…".
import type { Root } from 'react-dom/client'
import { mountWidget } from './mount'

const scriptOrigin = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src
  return src ? new URL(src).origin : window.location.origin
})()

class AttendNowWidget extends HTMLElement {
  static observedAttributes = ['event-id', 'api-base']
  private root: Root | null = null

  connectedCallback() {
    this.render()
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render()
  }

  disconnectedCallback() {
    this.root?.unmount()
    this.root = null
  }

  private render() {
    const eventId = this.getAttribute('event-id')
    if (!eventId) return
    this.root?.unmount()
    this.root = mountWidget(this, { eventId, apiBase: this.getAttribute('api-base') ?? scriptOrigin })
  }
}

if (!customElements.get('attend-now-widget')) customElements.define('attend-now-widget', AttendNowWidget)
