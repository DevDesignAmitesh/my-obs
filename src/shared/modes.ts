import { clipEnd, type CaptionStyle, type Project } from './project'
import { Theme } from './theme'
import type { Selection } from './assistant'

/**
 * Video modes: reusable editing recipes learned from reference videos.
 * A mode has an editing STRUCTURE (always applied) and a default LOOK, which is used only when
 * the user's extra instructions don't describe a mood of their own.
 */

export type ModeId = 'explainer' | 'demo' | 'happening'

export interface VideoMode {
  id: ModeId
  name: string
  tagline: string
  /** The reference this style was learned from. */
  reference: string
  /** The editing recipe (look-agnostic). */
  recipe: string
  /** Default look, only when the user gives no mood. */
  defaultLook: { description: string; theme: Theme; captions: Partial<CaptionStyle> }
}

export const MODES: VideoMode[] = [
  {
    id: 'explainer',
    name: 'Explainer',
    tagline: 'Talking head + slides that teach an idea step by step',
    reference: 'Sahil — “I built an inference engine in C++” (x.com/Sahil100X)',
    recipe: `EXPLAINER — teach one idea clearly, talking head alternating with clean slides.
Structure and pacing:
1. Hook (first 5–15 s): speaker full screen. Title card at the bottom-left over a dark scrim: small kicker label (e.g. "BUILT, NOT READ"), a 3–7 word title, an accent rule and a one-line subtitle. Visible from ~0.5 s for ~6 s.
2. Explanation: when the speaker starts explaining, switch to "slide mode": a theme-background colour layer fills the frame, the camera animates (~0.5 s) into a rounded box in the bottom-right corner (~0.3 of the width). For each idea: a section heading in the right column (kicker "01 — TOPIC" with the topic in the kicker, a 2–5 word title, accent rule, size ~1.3, no card) plus one card on the left (list, code, stat or text, on a card). Start the first heading+card as soon as the camera has settled; each stays until the next one starts — never an empty slide. Reveal list items / code highlights when the words are said (0.3 s early).
3. Key sentences said to camera: back to full screen with a lower third (≤ 8 words).
4. Screen recordings / demos: show them whole (fit, not cropped) on the theme background, a small "LIVE DEMO" style badge, lower thirds for each key action or question.
5. Outro: camera full screen; optional summary checklist; end card with kicker "NEXT" and what comes next.
Editing: captions of the spoken words OFF (the slides carry the text). Cut long waiting/dead time and false starts, but keep the speaker's natural pace.`,
    defaultLook: {
      description: 'dark navy slides, orange accent lines, blue monospace labels, calm and technical',
      theme: Theme.parse({ name: 'Explainer' }),
      captions: { enabled: false }
    }
  },
  {
    id: 'demo',
    name: 'Project demo',
    tagline: 'Fast, cinematic product walkthrough with zooms on what matters',
    reference: 'Farza — “Introducing collaborators” for HeyClicky (x.com/FarzaTV)',
    recipe: `PROJECT DEMO — show a product working, fast and cinematic, like a launch video.
Structure and pacing:
1. Hook: the first sentence must land within ~3 s — tighten the opening (remove the pause, "so", "um", false starts before it). No title card; cut straight in. NEVER delete the intro, the setup or the backstory to get to a later line: the whole story stays, in order.
2. Why: the sentences on the problem it solves (keep them all; just tighten them).
3. How it works, step by step: for each step the speaker describes, show the screen recording of it. When they mention a specific result, card or button, punch in: animate the screen clip to scale ~1.5–2 centred on that part (x/y) over ~0.4 s, hold while it is discussed, then animate back out. Alternate between the speaker and the screen so the picture changes every 2–4 s.
4. Payoff: show the concrete results (drafts made, report generated…).
5. Who it is for + call to action, spoken to camera.
6. End card: AFTER the last spoken word, 2–3 s black colour layer with the product/brand name as big centred text (title template, size ≥ 1.4).
Editing: jump cuts — remove every pause longer than ~0.3 s, false starts, filler words and repeated takes, but keep every sentence that carries content. The speaker's footage always fills the frame (no black side bars); punch-ins on the speaker (scale × ~1.15) on key lines are fine, smooth and sparing. Captions ON the whole video: sentence case, ONE short line (≤ ~6 words), centred in the lower third, no word highlight. No other text layers on the speaker (no badges, no lower thirds) — the captions carry the words.`,
    defaultLook: {
      description: 'clean cinematic: white captions with a soft outline, black end card, product-blue accent',
      theme: Theme.parse({ name: 'Demo', font: 'Segoe UI', text: '#ffffff', muted: '#c3c7cf', accent: '#3b82f6', accent2: '#93c5fd', panel: '#101114', panelBorder: '#26282e', background: '#000000', radius: 0.02 }),
      captions: { enabled: true, font: 'Segoe UI', size: 4.2, color: '#ffffff', highlight: 'none', outline: true, background: false, uppercase: false, y: 0.83, x: 0.5, width: 0.8, maxChars: 34, maxLines: 1 }
    }
  },
  {
    id: 'happening',
    name: 'Happening',
    tagline: 'Casual, energetic montage of people and moments — team updates, vlogs, BTS',
    reference: 'HeyClicky — “i have been busy” (x.com/heyclicky)',
    recipe: `HAPPENING — an energetic, casual montage of what's going on (team updates, vlogs, behind the scenes).
Structure and pacing:
1. Start instantly on the most energetic line; no intro, no title card.
2. Relay: each person / moment gets one short line, then cut to the next. Very tight: the picture changes every 1–2 s. With several people or clips, keep only the punchiest phrase of each statement (this mode asks for that trimming, so mark those cuts "userAskedToRemove": true). With one person talking continuously, keep every sentence and only remove pauses, filler and repeats — change the picture with punch-ins instead.
3. Between spoken lines, flash quick cutaways of screens, hands, places (0.5–1.5 s) when such footage exists.
4. 1–3 big kinetic words: huge lowercase text layers (text template, size ~2.5–3, centred, pop entrance) for the key phrase or title, about 1 s each (e.g. "everything we shipped*").
5. Ending: ~1 s logo/mark or name, then a 1.5–2 s end card on black with the name or URL in lowercase, centred.
Editing: footage always fills the frame. No slides, no cards, no lower thirds. Captions ON: all lowercase, short (≤ 4 words per line, one line), small, centred in the lower third, no highlight. Aim for under ~60 s unless the user asks otherwise.`,
    defaultLook: {
      description: 'warm, sunny and playful: lowercase white text, black end cards',
      theme: Theme.parse({ name: 'Happening', font: 'Segoe UI', text: '#ffffff', muted: '#e8dccf', accent: '#ffd166', accent2: '#ff8fab', panel: '#141414', panelBorder: '#2a2a2a', background: '#000000', radius: 0.02 }),
      captions: { enabled: true, font: 'Segoe UI', size: 3.6, color: '#ffffff', highlight: 'none', outline: true, background: false, uppercase: false, y: 0.84, x: 0.5, width: 0.7, maxChars: 22, maxLines: 1 }
    }
  }
]

export const modeById = (id: string | undefined): VideoMode => MODES.find((m) => m.id === id) ?? MODES[0]

/** A mode's default look, by mode id or name (for setTheme { preset }). */
export function presetTheme(name: string): Theme | undefined {
  const n = name.toLowerCase()
  return MODES.find((m) => m.id === n || m.name.toLowerCase() === n || m.defaultLook.theme.name.toLowerCase() === n)?.defaultLook.theme
}

/** Words that suggest the user described a look / mood of their own. */
const MOOD_HINT = /\b(mood|vibe|feel|tone|theme|colou?rs?|palette|font|dark|light|bright|warm|cool|calm|serious|playful|fun|energetic|cinematic|minimal|moody|pastel|neon|retro|vintage|elegant|bold|cute|professional|corporate|luxury|dreamy|gritty|clean)\b/i

export const describesMood = (extra: string): boolean => MOOD_HINT.test(extra)

/**
 * The full request for "Generate": the mode's editing structure, how to pick the look, and the
 * user's own extra instructions (which win over the recipe where they conflict).
 */
export function buildModeRequest(
  modeId: string | undefined,
  extra: string,
  opts: {
    /** Limit the edit to this marked part of the timeline. */
    scope?: Selection | null
    /** For footage-specific hints (e.g. filling the frame). */
    project?: Project
    /** Project-wide standing instructions: a mood there also replaces the default look. */
    standing?: string
  } = {}
): string {
  const mode = modeById(modeId)
  const trimmed = extra.trim()
  const { scope, project } = opts
  const hasMood = describesMood(`${trimmed} ${opts.standing ?? ''}`)
  const look = hasMood
    ? `LOOK: The user described their own mood/look below. Do NOT copy the reference look. Translate their words into a matching theme (setTheme with a patch: background, panel, panelBorder, text, muted, accent, accent2, font) and caption colours/font, and let the mood also shape the pacing and entrance animations. Keep the mode's editing structure.`
    : `LOOK: No mood was given, so use this mode's default look: ${mode.defaultLook.description}. Apply it with setTheme ${JSON.stringify({ patch: mode.defaultLook.theme })} and setCaptionStyle ${JSON.stringify({ patch: mode.defaultLook.captions })}.`
  const r = (n: number): string => n.toFixed(2)
  const header = scope
    ? `Edit ONLY the marked part ${r(scope.start)}–${r(scope.end)} s in "${mode.name}" mode. It is one part of a longer video: leave everything outside it exactly as it is. The recipe's opening steps (hook) apply only if the part starts the video, and its ending steps (end card) only if it ends the video.`
    : `Edit the WHOLE video in "${mode.name}" mode.`
  return [
    header,
    '',
    mode.recipe,
    ...(project ? fillHints(project, scope ?? null) : []),
    '',
    look,
    '',
    trimmed ? `USER'S EXTRA INSTRUCTIONS (these win over the recipe where they conflict):\n${trimmed}` : 'No extra instructions.',
    '',
    'Work only with the footage and transcript that exist; if the recipe asks for something the footage does not have (e.g. screen recordings, several people), skip that part and say so. Put cuts last.'
  ].join('\n')
}

/** Full-screen clips whose shape differs from the canvas (they would show black bars), with the scale that fills it. */
export function fillHints(p: Project, scope: Selection | null): string[] {
  const { width: W, height: H } = p.settings
  const out: string[] = []
  for (const t of p.tracks) {
    if (t.kind !== 'video') continue
    for (const c of t.clips) {
      if (scope && (clipEnd(c) <= scope.start || c.start >= scope.end)) continue
      const m = p.media.find((x) => x.id === c.mediaId)
      if (!m || m.kind !== 'video' || !m.width || !m.height || Math.abs(c.transform.scale - 1) > 0.02 || Math.abs(c.transform.x - 0.5) > 0.02) continue
      const ratio = W / H / (m.width / m.height)
      const fill = ratio >= 1 ? ratio : 1 / ratio
      if (fill > 1.02) out.push(`FRAMING: clip ${c.id} ("${m.name}", ${m.width}x${m.height}) shows black bars on the ${W}x${H} canvas. Set its scale to ${fill.toFixed(3)} (updateClip transform) so it fills the frame, and base punch-ins on that scale.`)
    }
  }
  return out.length ? ['', ...out] : []
}

// ---- feedback → refined instruction ---------------------------------------------------------

export interface RefinedFeedback {
  /** One sentence: what the user wants. */
  intent: string
  /** Precise instruction for the editing AI. */
  instruction: string
  /** A lasting preference to add to the project's extra instructions ("" if none). */
  remember: string
}

export const REFINER_SYSTEM = `You turn a video creator's feedback into a precise instruction for an AI video editor.
You get: the video mode and its editing recipe, the user's standing extra instructions, a summary of the current timeline and transcript, the recent conversation, and the new feedback (maybe with a frame and time they pointed at).
Work out what they really want (their intent), including vague feedback like "too slow", "looks boring" or "make it feel premium", and write ONE clear editing instruction that the editor can act on: name the exact times, text layers (by what they say) or sections, and the concrete change (cut, move, resize, restyle, animate, add, remove). Stay within the editor's abilities: cuts, splits, trims, moves, text layers (title, lower third, heading, text, badge, stat, list, code), keyframe animation (move/zoom/fade), colour layers, theme colours/fonts, captions, volume.
If the feedback states a lasting preference (a mood, a style rule, "always …", "never …"), put it in "remember" so future edits follow it; otherwise leave "remember" empty.
Reply with JSON only: {"intent": "...", "instruction": "...", "remember": "..."}`

/** Pulls the JSON object out of a model reply (tolerates code fences and extra words). */
export function parseRefined(text: string, fallback: string): RefinedFeedback {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(text.slice(start, end + 1)) as Partial<RefinedFeedback>
      if (j.instruction && typeof j.instruction === 'string') {
        return { intent: String(j.intent ?? '').trim(), instruction: j.instruction.trim(), remember: String(j.remember ?? '').trim() }
      }
    } catch {
      // fall through
    }
  }
  return { intent: '', instruction: fallback, remember: '' }
}
