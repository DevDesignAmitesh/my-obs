/** 83.5 -> "1:23", 3725 -> "1:02:05"; with frames: "1:23:15" style is not needed yet. */
export function formatTime(seconds: number, withTenths = false): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const base = h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
  return withTenths ? `${base}.${Math.floor((s % 1) * 10)}` : base
}
