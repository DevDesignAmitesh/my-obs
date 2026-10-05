import { z } from 'zod'

/** One spoken word, in source-media seconds. */
export const Word = z.object({ text: z.string(), start: z.number(), end: z.number() })
export type Word = z.infer<typeof Word>

export const Transcript = z.object({
  provider: z.string(),
  model: z.string(),
  language: z.string().optional(),
  createdAt: z.string(),
  words: z.array(Word)
})
export type Transcript = z.infer<typeof Transcript>

/** Normalized form used for matching (lowercase, no punctuation). */
export const normWord = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')

export const FILLER_WORDS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm'])

/**
 * Whisper's word timings come without punctuation, but its full text has it. Copies the
 * punctuation (and capitalisation) of the text onto the timed words, matching them in order.
 */
export function punctuateWords(words: Word[], text: string | undefined): Word[] {
  const tokens = (text ?? '').split(/\s+/).filter((t) => normWord(t))
  if (!tokens.length) return words
  let j = 0
  return words.map((w) => {
    const n = normWord(w.text)
    // Look a few tokens ahead so a missing or extra word doesn't derail the rest.
    for (let k = j; k < Math.min(tokens.length, j + 4); k++) {
      if (normWord(tokens[k]) === n) {
        j = k + 1
        return { ...w, text: tokens[k] }
      }
    }
    return w
  })
}

/** Ends a sentence: punctuation, or (for unpunctuated transcripts) a pause before a capitalised word. */
export function endsSentence(w: Word, next: Word | undefined): boolean {
  if (/[.!?]["')\]]?$/.test(w.text)) return true
  if (!next || /[.,!?;:]/.test(w.text)) return false
  return /^[A-Z]/.test(next.text) && !/^I('|$|’)/.test(next.text) && next.start - w.end >= 0.25
}
