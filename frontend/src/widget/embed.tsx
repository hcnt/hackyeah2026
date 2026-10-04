// Entry of the standalone widget.js bundle. Embed on any page:
//
//   <attend-now-widget event-id="EVENT_ID"></attend-now-widget>
//   <script src="https://hackyeah.kindhome.io/widget.js" async></script>
//
// The widget reads the event's oracles from Solana (rpc-url="…", default devnet; program-id="…", default the
// on_sight id in chain.ts) and sends the join to each of them. api-base="…" is the fallback oracle when that read
// fails; it defaults to wherever widget.js was loaded from.
import type { Root } from 'react-dom/client'
import { mountWidget } from './mount'

const scriptOrigin = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src
  return src ? new URL(src).origin : window.location.origin
})()

class AttendNowWidget extends HTMLElement {
  static observedAttributes = ['event-id', 'api-base', 'rpc-url', 'program-id']
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
    this.root = mountWidget(this, {
      eventId,
      apiBase: this.getAttribute('api-base') ?? scriptOrigin,
      rpcUrl: this.getAttribute('rpc-url') ?? undefined,
      programId: this.getAttribute('program-id') ?? undefined,
    })
  }
}

if (!customElements.get('attend-now-widget')) customElements.define('attend-now-widget', AttendNowWidget)
