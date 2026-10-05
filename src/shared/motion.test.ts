import { describe, expect, it } from 'vitest'
import { ease, extractJson, Motion, motionTime, sanitizeSvg, valuesAt } from './motion'
import { isMonetizable, licenseCode } from './music'

describe('motion values', () => {
  const keys = [
    { t: 0, opacity: 0, scale: 0.5, fill: '#000000' },
    { t: 1, opacity: 1, ease: 'linear' as const },
    { t: 2, scale: 1, fill: '#ffffff', ease: 'linear' as const }
  ]

  it('interpolates each property between the keys that set it', () => {
    expect(valuesAt(keys, 0.5).opacity).toBeCloseTo(0.5)
    // scale is only keyed at 0 and 2, so at 1 s it is halfway.
    expect(valuesAt(keys, 1).scale).toBeCloseTo(0.75)
    expect(valuesAt(keys, 1).fill).toBe('#808080')
  })

  it('holds the first value before and the last after', () => {
    expect(valuesAt(keys, -1)).toMatchObject({ opacity: 0, scale: 0.5 })
    expect(valuesAt(keys, 9)).toMatchObject({ opacity: 1, scale: 1, fill: '#ffffff' })
  })

  it('eases start at 0 and end at 1', () => {
    for (const e of ['linear', 'in', 'out', 'inOut', 'back', 'bounce', 'elastic'] as const) {
      expect(ease(e, 0)).toBeCloseTo(0)
      expect(ease(e, 1)).toBeCloseTo(1)
    }
  })

  it('loops or holds the last frame', () => {
    const m = Motion.parse({ svg: '<svg viewBox="0 0 10 10"></svg>', width: 10, height: 10, duration: 2 })
    expect(motionTime(m, 5)).toBe(2)
    expect(motionTime({ ...m, loop: true }, 5)).toBeCloseTo(1)
  })
})

describe('AI replies', () => {
  it('finds JSON inside fences and chatter', () => {
    expect(extractJson('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractJson('here {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } })
  })

  it('strips scripts, handlers and outside links from SVG', () => {
    const s = sanitizeSvg('<svg onload="x()"><script>alert(1)</script><image href="http://evil/x.png"/><use href="#a"/></svg>')
    expect(s).not.toMatch(/script|onload|evil/)
    expect(s).toContain('href="#a"')
  })
})

describe('music licences', () => {
  it('reads licence codes from URLs and knows which suit monetized videos', () => {
    expect(licenseCode('http://creativecommons.org/licenses/by-nc-sa/3.0/')).toBe('by-nc-sa')
    expect(licenseCode('https://creativecommons.org/publicdomain/zero/1.0/')).toBe('cc0')
    expect(licenseCode('by')).toBe('by')
    expect(isMonetizable('by')).toBe(true)
    expect(isMonetizable('by-nd')).toBe(false)
    expect(isMonetizable('by-nc')).toBe(false)
  })
})
