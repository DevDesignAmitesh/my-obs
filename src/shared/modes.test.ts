import { describe, expect, it } from 'vitest'
import { buildContext } from './assistant'
import { buildModeRequest, describesMood, modeById, MODES, parseRefined, presetTheme } from './modes'
import { applyOps } from './ops'
import { createProject } from './project'

describe('video modes', () => {
  it('has the three modes learned from the reference videos', () => {
    expect(MODES.map((m) => m.name)).toEqual(['Explainer', 'Project demo', 'Happening'])
    expect(modeById('nope').id).toBe('explainer')
    expect(presetTheme('demo')?.background).toBe('#000000')
  })

  it('uses the default look only when no mood is described', () => {
    const plain = buildModeRequest('demo', '')
    expect(plain).toContain('PROJECT DEMO')
    expect(plain).toContain("use this mode's default look")
    expect(plain).toContain('"highlight":"none"')

    const moody = buildModeRequest('demo', 'warm and playful, pastel colours')
    expect(moody).toContain('Do NOT copy the reference look')
    expect(moody).not.toContain("use this mode's default look")
    expect(moody).toContain('PROJECT DEMO') // the editing structure stays
    expect(moody).toContain('warm and playful, pastel colours')

    // Extra instructions without a mood keep the default look but are still passed on.
    const noMood = buildModeRequest('happening', 'keep it under 30 seconds')
    expect(noMood).toContain("use this mode's default look")
    expect(noMood).toContain('keep it under 30 seconds')
  })

  it('recognises mood words', () => {
    expect(describesMood('make it feel premium and dark')).toBe(true)
    expect(describesMood('cut the intro')).toBe(false)
  })

  it('stores the mode and standing instructions in the project, and shows them to the AI', () => {
    const p = applyOps(createProject('p'), [{ op: 'setMode', mode: 'happening', extraPrompt: 'always lowercase' }])
    expect(p).toMatchObject({ mode: 'happening', extraPrompt: 'always lowercase' })
    const ctx = buildContext(p, null, 0)
    expect(ctx).toContain('VIDEO MODE: Happening')
    expect(ctx).toContain("USER'S STANDING INSTRUCTIONS (mood, style rules; always follow): always lowercase")
    // A mode's default look can be applied by name.
    expect(applyOps(p, [{ op: 'setTheme', preset: 'happening' }]).theme.accent).toBe('#ffd166')
  })
})

describe('feedback refiner answer', () => {
  it('reads JSON even inside code fences or extra words', () => {
    expect(parseRefined('Sure!\n```json\n{"intent":"faster","instruction":"Cut pauses over 0.4 s","remember":""}\n```', 'x')).toEqual({
      intent: 'faster',
      instruction: 'Cut pauses over 0.4 s',
      remember: ''
    })
  })

  it('falls back to the raw feedback if the answer is unusable', () => {
    expect(parseRefined('I could not do that', 'make it pop')).toEqual({ intent: '', instruction: 'make it pop', remember: '' })
  })
})
