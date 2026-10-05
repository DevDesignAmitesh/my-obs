import { useEffect, useRef } from 'react'

/** Live input level bar for a microphone stream (green → yellow → red near clipping). */
export function MicMeter({ stream }: { stream?: MediaStream }) {
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!stream || !stream.getAudioTracks().length) return
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    let raf = 0
    let level = 0
    const tick = (): void => {
      analyser.getFloatTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v))
      // Fast attack, slow release; shown on a dB scale from -60 dB to 0 dB.
      const db = 20 * Math.log10(Math.max(peak, 1e-6))
      const target = Math.min(1, Math.max(0, (db + 60) / 60))
      level = target > level ? target : level * 0.92 + target * 0.08
      if (barRef.current) {
        barRef.current.style.width = `${level * 100}%`
        barRef.current.style.background = level > 0.93 ? '#ff5d6c' : level > 0.75 ? '#f5c542' : '#1f9d74'
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      ctx.close()
    }
  }, [stream])

  return (
    <div className="h-2 w-full overflow-hidden rounded bg-panel-2">
      <div ref={barRef} className="h-full w-0" />
    </div>
  )
}
