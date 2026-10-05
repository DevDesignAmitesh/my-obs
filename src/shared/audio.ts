import type { EnhanceLevel } from './project'

/** Where the cleaned-up ("Enhance voice") audio of a media item is cached, relative to the project. */
export const enhancedAudioPath = (mediaId: string, level: Exclude<EnhanceLevel, 'off'>): string =>
  `cache/audio/${mediaId}-voice-${level}.flac`

/**
 * FFmpeg filter per "Enhance voice" level: rumble cut + non-local-means denoising (anlmdn).
 * Benchmarked on a real recording: pauses −71 → −90 dB with the voice level unchanged. (afftdn was
 * rejected: it adds its own noise floor and made quiet pauses louder.) Speed ≈ 12% of real time.
 */
export const ENHANCE_FILTER: Record<Exclude<EnhanceLevel, 'off'>, string> = {
  light: 'highpass=f=70,anlmdn=s=3',
  medium: 'highpass=f=80,anlmdn=s=7',
  strong: 'highpass=f=90,anlmdn=s=12:p=0.004'
}

/** Rough processing time for Enhance voice, as a fraction of the audio duration. */
export const ENHANCE_SPEED = 0.12

export const gainToDb = (g: number): number => (g <= 0 ? -Infinity : 20 * Math.log10(g))
export const dbToGain = (db: number): number => 10 ** (db / 20)

/** Export loudness targets (integrated LUFS). */
export const LOUDNESS_TARGETS = { youtube: -14, podcast: -16 } as const
export type LoudnessTarget = keyof typeof LOUDNESS_TARGETS
