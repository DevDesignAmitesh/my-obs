import { z } from 'zod'

/**
 * A project's visual style. Every text layer / card is drawn from the theme, so changing it restyles
 * the whole video. Each video mode has a default look (modes.ts); a mood the user describes replaces it.
 */
export const Theme = z.object({
  name: z.string().default('Midnight'),
  font: z.string().default('Segoe UI'),
  monoFont: z.string().default('Cascadia Mono'),
  /** Main text, secondary text. */
  text: z.string().default('#f1f3f7'),
  muted: z.string().default('#8b93a5'),
  /** Primary accent (rules, highlights, stats) and secondary accent (labels, code keywords). */
  accent: z.string().default('#f08a4b'),
  accent2: z.string().default('#6ea8ff'),
  /** Card / panel fill and border. */
  panel: z.string().default('#151b29'),
  panelBorder: z.string().default('#252d40'),
  /** Suggested full-frame background color for slides. */
  background: z.string().default('#0d121d'),
  /** Corner radius as a fraction of the canvas height. */
  radius: z.number().default(0.018),
  /** Whether the theme is light (affects code colors). */
  light: z.boolean().default(false)
})
export type Theme = z.infer<typeof Theme>
