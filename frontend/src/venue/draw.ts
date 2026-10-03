import type { LiveFace } from './api'

const COLORS = { paid: '#45C9B4', tracking: '#E8AA52', unknown: '#7A8886' } as const
const LABEL_INK = '#0E1514'

function label(f: LiveFace): string | null {
  const name = f.name?.trim() || 'Guest'
  if (f.state === 'paid') return `${name} · paid ✓`
  if (f.state === 'tracking') return `${name} · ${f.seen_secs.toFixed(1)} s`
  return null
}

/** Draws one annotated frame: the image, then a box (and label) per face, in image pixel coordinates. */
export function drawFrame(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, faces: LiveFace[]) {
  const canvas = ctx.canvas
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  ctx.drawImage(img, 0, 0, w, h)

  const line = Math.max(2, Math.round(w / 300))
  const fontPx = Math.max(13, Math.round(w / 48))
  const padX = Math.round(fontPx * 0.45)
  const labelH = Math.round(fontPx * 1.55)
  ctx.font = `600 ${fontPx}px "JetBrains Mono", ui-monospace, Menlo, monospace`
  ctx.textBaseline = 'middle'

  // Unknown first so recognised people are drawn on top.
  const order = [...faces].sort((a, b) => (a.state === 'unknown' ? 0 : 1) - (b.state === 'unknown' ? 0 : 1))
  for (const f of order) {
    const [x1, y1, x2, y2] = f.bbox
    const color = COLORS[f.state] ?? COLORS.unknown
    ctx.save()
    ctx.lineWidth = line
    ctx.strokeStyle = color
    if (f.state === 'unknown') ctx.setLineDash([line * 3, line * 2.5])
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
    ctx.restore()

    const text = label(f)
    if (!text) continue
    const tw = Math.ceil(ctx.measureText(text).width) + padX * 2
    // Above the box when there is room, otherwise just inside its top edge.
    const ly = y1 - labelH >= 0 ? y1 - labelH : y1
    const lx = Math.min(Math.max(0, x1 - line / 2), Math.max(0, w - tw))
    ctx.fillStyle = color
    ctx.fillRect(lx, ly, tw, labelH)
    ctx.fillStyle = LABEL_INK
    ctx.fillText(text, lx + padX, ly + labelH / 2)
  }
}

export function base64ToBlob(b64: string, type = 'image/jpeg'): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}
