/** The oracle accepts images up to this many pixels on the long side. */
export const MAX_LONG_SIDE = 1280

/**
 * Grabs the current video frame as a JPEG (the raw, unmirrored camera image), scaled down to at most `maxWidth`
 * pixels wide and MAX_LONG_SIDE on the long side. Reuses the caller's canvas to avoid allocations while streaming.
 */
export function captureJpeg(
  video: HTMLVideoElement,
  maxWidth: number,
  quality: number,
  canvas: HTMLCanvasElement,
): Promise<Blob> {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return Promise.reject(new Error('Video is not ready yet'))
  const scale = Math.min(1, maxWidth / vw, MAX_LONG_SIDE / Math.max(vw, vh))
  const w = Math.round(vw * scale)
  const h = Math.round(vh * scale)
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('Canvas is not available'))
  ctx.drawImage(video, 0, 0, w, h)
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the frame'))), 'image/jpeg', quality)
  })
}
