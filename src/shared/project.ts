import { z } from 'zod'
import { Mask, Scene } from './scene'
import { Transcript } from './transcript'
import { Graphic, graphicLabel } from './graphics'
import { Theme } from './theme'
import { TransformKey } from './animation'
import { Motion } from './motion'
import { Zoom } from './zoom'

/**
 * project.json — the single source of truth for a project.
 * All times are in seconds (timeline or source time). Media files are never modified;
 * every edit is a change to this document.
 */

export const PROJECT_VERSION = 1

/**
 * 'color' is a generated solid-color layer, 'graphic' a text/card layer (see graphics.ts) and
 * 'motion' generated SVG art/animation (see motion.ts); none of them has a file.
 */
export const MediaKind = z.enum(['video', 'audio', 'image', 'color', 'graphic', 'motion'])
export type MediaKind = z.infer<typeof MediaKind>

export const MediaItem = z.object({
  id: z.string(),
  kind: MediaKind,
  name: z.string(),
  /** Relative to the project folder when copied in; absolute when `linked`. */
  path: z.string(),
  linked: z.boolean().default(false),
  /** Seconds. 0 for images (they get a default length when placed). */
  duration: z.number().nonnegative(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  hasAudio: z.boolean().default(false),
  /** Relative path of a thumbnail inside cache/. */
  thumbnail: z.string().optional(),
  /** Fill color for 'color' media (#rrggbb). */
  color: z.string().optional(),
  /** Content of 'graphic' media. */
  graphic: Graphic.optional(),
  /** Content of 'motion' media. */
  motion: Motion.optional(),
  /** Licence / attribution to credit (e.g. music from a Creative Commons library). */
  credit: z.string().optional()
})
export type MediaItem = z.infer<typeof MediaItem>

export const Transform = z.object({
  /** Center position, normalized to the canvas (0..1). */
  x: z.number().default(0.5),
  y: z.number().default(0.5),
  scale: z.number().default(1),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  /** Crop fractions of the source on each edge (0..1). */
  crop: z
    .object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() })
    .default({ left: 0, top: 0, right: 0, bottom: 0 }),
  mask: Mask.default('none'),
  /** Mirror the picture left-right / top-bottom. */
  flipH: z.boolean().default(false),
  flipV: z.boolean().default(false)
})
export type Transform = z.infer<typeof Transform>

/** A volume automation point, anchored to the source media time so trimming never shifts it. */
export const VolumeKey = z.object({ t: z.number(), v: z.number().min(0).max(4) })
export type VolumeKey = z.infer<typeof VolumeKey>

export const EnhanceLevel = z.enum(['off', 'light', 'medium', 'strong'])
export type EnhanceLevel = z.infer<typeof EnhanceLevel>

export const Clip = z.object({
  id: z.string(),
  mediaId: z.string(),
  /** Timeline position of the clip's first frame. */
  start: z.number().nonnegative(),
  /** Source in/out points. Clip length on the timeline = out - in. */
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  transform: Transform.default(Transform.parse({})),
  volume: z.number().min(0).max(4).default(1),
  /** Fade from/to transparent (video) and silence (audio), in seconds. */
  fadeIn: z.number().nonnegative().default(0),
  fadeOut: z.number().nonnegative().default(0),
  /** Crossfade with the clip that ends exactly where this one starts (same track), in seconds. */
  crossfadeIn: z.number().nonnegative().default(0),
  /** Volume automation (multiplies `volume`), sorted by t. */
  volumeKeys: z.array(VolumeKey).default([]),
  /** Silences this clip's sound (e.g. after its audio was detached to an audio track). */
  muted: z.boolean().default(false),
  /** Voice cleanup (noise removal) applied to this clip's sound. */
  enhance: EnhanceLevel.default('off'),
  /** Keyframe animation of position/size/opacity/rotation (see animation.ts). */
  keys: z.array(TransformKey).default([]),
  /** Auto zooms (screen recordings: zoom in on clicks and typing), see zoom.ts. */
  zooms: z.array(Zoom).default([]),
  /** Clips merged into one block share a group id: they move, cut, trim and delete together. */
  groupId: z.string().optional()
})
export type Clip = z.infer<typeof Clip>

export const TrackKind = z.enum(['video', 'audio'])
export type TrackKind = z.infer<typeof TrackKind>

export const Track = z.object({
  id: z.string(),
  kind: TrackKind,
  name: z.string(),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
  /** Kept sorted by `start`, never overlapping. */
  clips: z.array(Clip).default([])
})
export type Track = z.infer<typeof Track>

export const Marker = z.object({ id: z.string(), time: z.number(), label: z.string() })
export type Marker = z.infer<typeof Marker>

export const ProjectSettings = z.object({
  width: z.number().int().default(1920),
  height: z.number().int().default(1080),
  fps: z.number().default(30),
  sampleRate: z.number().int().default(48000)
})
export type ProjectSettings = z.infer<typeof ProjectSettings>

export const CaptionStyle = z.object({
  enabled: z.boolean().default(false),
  font: z.string().default('Arial Black'),
  /** Font size as % of the canvas height. */
  size: z.number().default(5.5),
  color: z.string().default('#ffffff'),
  /** Color of the word being spoken. */
  highlightColor: z.string().default('#ffd400'),
  /** none: plain · word: current word highlighted · karaoke: spoken words highlighted */
  highlight: z.enum(['none', 'word', 'karaoke']).default('word'),
  outline: z.boolean().default(true),
  background: z.boolean().default(false),
  /** Vertical position of the caption's center (0 top … 1 bottom). */
  y: z.number().min(0).max(1).default(0.8),
  uppercase: z.boolean().default(false),
  /** Horizontal center of the caption area (0 left … 1 right) and its width (fraction of the canvas). */
  x: z.number().min(0).max(1).default(0.5),
  width: z.number().min(0.1).max(1).default(0.86),
  /** Max characters per caption line; short lines suit vertical video. */
  maxChars: z.number().int().default(32),
  maxLines: z.number().int().min(1).max(3).default(2)
})
export type CaptionStyle = z.infer<typeof CaptionStyle>

export const ModeId = z.enum(['explainer', 'demo', 'happening'])

/**
 * A part of the timeline with its own video mode and mood (e.g. 0:10–2:30 as a "Project demo",
 * warm and playful). Its look, once the AI or the user sets one, overrides the project's theme and
 * caption style inside the part. Timeline seconds; cuts shift and shrink it like markers.
 */
export const Section = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  mode: ModeId,
  mood: z.string().default(''),
  theme: Theme.optional(),
  captions: CaptionStyle.optional()
})
export type Section = z.infer<typeof Section>

/**
 * Something that was deleted, kept so it can be put back (the "Deleted" list).
 * `start`/`end` are timeline seconds; later cuts shift them like markers, so "restore" lands
 * where the material used to be. `gap`: whether the deletion closed the gap (on every track, or
 * only on the clips' own tracks), so restoring re-opens it.
 */
export const TrashEntry = z.object({
  id: z.string(),
  /** ISO time of the deletion. */
  time: z.string(),
  label: z.string(),
  start: z.number(),
  end: z.number(),
  gap: z.enum(['none', 'track', 'all']).default('none'),
  clips: z.array(z.object({ trackId: z.string(), clip: Clip })).default([]),
  /** Media items that were removed from the project along with the clips. */
  media: z.array(MediaItem).default([])
})
export type TrashEntry = z.infer<typeof TrashEntry>

export const Project = z.object({
  version: z.literal(PROJECT_VERSION),
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  settings: ProjectSettings.default(ProjectSettings.parse({})),
  media: z.array(MediaItem).default([]),
  /** Order = stacking order for video: index 0 is the bottom layer. */
  tracks: z.array(Track).default([]),
  markers: z.array(Marker).default([]),
  scenes: z.array(Scene).default([]),
  activeSceneId: z.string().optional(),
  /** Transcripts by media id (source time); corrections are made here, so they're undoable. */
  transcripts: z.record(z.string(), Transcript).default({}),
  captionStyle: CaptionStyle.default(CaptionStyle.parse({})),
  /** Visual style of text layers and cards. */
  theme: Theme.default(Theme.parse({})),
  /** Editing mode (see modes.ts) and the user's standing extra instructions / mood. */
  mode: ModeId.default('explainer'),
  extraPrompt: z.string().default(''),
  /** Parts with their own mode and mood (sorted, not overlapping). */
  sections: z.array(Section).default([]),
  /** Deleted clips/parts that can be put back, newest last. */
  trash: z.array(TrashEntry).default([])
})
export type Project = z.infer<typeof Project>

export const newId = (): string => globalThis.crypto.randomUUID()

export function createProject(name: string, settings?: Partial<ProjectSettings>): Project {
  const now = new Date().toISOString()
  return Project.parse({
    version: PROJECT_VERSION,
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    settings: { ...ProjectSettings.parse({}), ...settings },
    tracks: [
      { id: newId(), kind: 'video', name: 'V1' },
      { id: newId(), kind: 'video', name: 'V2' },
      { id: newId(), kind: 'audio', name: 'A1' },
      { id: newId(), kind: 'audio', name: 'A2' }
    ]
  })
}

/** Stills (images, color layers) have no fixed length: any in/out is valid. */
export const isStill = (m: Pick<MediaItem, 'kind'>): boolean => m.kind === 'image' || m.kind === 'color' || m.kind === 'graphic' || m.kind === 'motion'

/** Generated SVG art / animation. */
export function motionMedia(id: string, name: string, motion: Motion): MediaItem {
  return { id, kind: 'motion', name, path: '', linked: false, duration: motion.duration, width: motion.width, height: motion.height, hasAudio: false, motion }
}

/** A text/card layer the size of the canvas. */
export function graphicMedia(id: string, graphic: Graphic, W: number, H: number): MediaItem {
  return { id, kind: 'graphic', name: graphicLabel(graphic), path: '', linked: false, duration: 0, width: W, height: H, hasAudio: false, graphic }
}

/** A solid color layer the size of the canvas. */
export function colorMedia(id: string, color: string, W: number, H: number, name = `Color ${color}`): MediaItem {
  return { id, kind: 'color', name, path: '', linked: false, duration: 0, width: W, height: H, hasAudio: false, color }
}

export const clipLength = (c: Clip): number => c.out - c.in
export const clipEnd = (c: Clip): number => c.start + clipLength(c)

export function projectDuration(p: Project): number {
  let end = 0
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c))
  return end
}

/** Standard folders inside every project folder. */
export const PROJECT_DIRS = ['recordings', 'media', 'generated', 'cache', 'exports', 'autosave'] as const
export const PROJECT_FILE = 'project.json'
