import { useLayoutEffect, useRef, useState } from 'react'

/**
 * The largest W:H box that fits inside a container, in pixels. CSS aspect-ratio with
 * height:100% + max-width:100% gets distorted when the container is narrow; this never does.
 */
export function useFitBox<T extends HTMLElement>(W: number, H: number): { ref: React.RefObject<T | null>; width: number; height: number } {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const cs = getComputedStyle(el)
      const availW = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const availH = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      const s = Math.max(0, Math.min(availW / W, availH / H))
      setSize({ width: Math.floor(W * s), height: Math.floor(H * s) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [W, H])
  return { ref, ...size }
}
