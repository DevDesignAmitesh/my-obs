import { applyOps } from '@shared/ops'
import { createScene, recordedSources, SCENE_PRESETS, sourceKey, type Scene } from '@shared/scene'
import { MIC_LABEL, PROGRAM_LABEL, SYSTEM_LABEL, takeToOps } from '@shared/take'
import { drawScene } from './compositor'
import { LiveSources } from './live-sources'
import { TakeRecorder, type TakeTrack } from './take-recorder'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Dev check of the whole recording pipeline (run with `--selftest-record`): capture → encode →
 * stream to disk → split per source → timeline ops. Records ~5 s with a 1 s pause in the middle.
 */
export async function runSelftest(): Promise<void> {
  const result: Record<string, unknown> = { ok: false }
  const live = new LiveSources(30)
  try {
    const { path, project } = await window.studio.projects.create(`selftest-${Date.now()}`)
    result.projectPath = path
    const { width: W, height: H } = project.settings
    const scene = createScene('Test', SCENE_PRESETS[0], W, H)

    // Add an image source too (a generated PNG imported like a user's logo).
    const png = await new Promise<Blob>((resolve) => {
      const c = document.createElement('canvas')
      c.width = 400
      c.height = 200
      const g = c.getContext('2d')!
      g.fillStyle = '#6d8cff'
      g.fillRect(0, 0, 400, 200)
      c.toBlob((b) => resolve(b!), 'image/png')
    })
    const pngPath = `${path}/cache/selftest-logo.png`
    const h = await window.studio.recording.open(pngPath)
    await window.studio.recording.write(h, 0, new Uint8Array(await png.arrayBuffer()))
    await window.studio.recording.close(h)
    const [logo] = await window.studio.media.import(path, [pngPath])
    project.media.push(logo)
    scene.items.push({ id: 'logo', name: 'Logo', source: { type: 'image', mediaId: logo.id }, rect: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 }, fit: 'contain', mask: 'none', flipH: false, visible: true })

    // A second scene with the same sources in another layout: switched to mid-take.
    const scene2: Scene = { id: 'scene-2', name: 'Big camera', items: scene.items.map((i) => (i.source.type === 'camera' ? { ...i, rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, mask: 'none' as const } : i)) }
    let shown = scene
    await live.syncScenes([scene, scene2], project, path)
    await live.setMic(true)
    await live.setSystemAudio(true)
    await sleep(500) // let the first frames arrive

    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    const draw = setInterval(() => drawScene(ctx, shown, W, H, (i) => live.drawable(i)), 1000 / 30)

    const tracks: TakeTrack[] = []
    for (const item of recordedSources([scene, scene2])) {
      const track = live.videoTrack(item)
      if (track) tracks.push({ label: sourceKey(item), kind: 'video', track, role: item.source.type === 'display' ? 'screen' : 'camera', name: item.name })
    }
    if (live.micTrack) tracks.push({ label: MIC_LABEL, kind: 'audio', track: live.micTrack })
    if (live.systemTrack) tracks.push({ label: SYSTEM_LABEL, kind: 'audio', track: live.systemTrack })
    tracks.push({ label: PROGRAM_LABEL, kind: 'video', role: 'program', track: canvas.captureStream(30).getVideoTracks()[0] as MediaStreamVideoTrack })
    result.tracks = tracks.map((t) => t.label)

    const errors: string[] = []
    const t0 = performance.now()
    const rec = await TakeRecorder.start(path, tracks, 30, (e) => errors.push(e.message))
    await sleep(1500)
    const switchAt = rec.elapsed
    shown = scene2
    await sleep(1500)
    rec.pause()
    await sleep(1000)
    rec.resume()
    await sleep(2000)
    result.elapsed = rec.elapsed
    const finished = await rec.stop()
    clearInterval(draw)
    result.stopMs = Math.round(performance.now() - t0 - 6000)

    const p = applyOps(project, takeToOps(project, [{ at: 0, scene }, { at: switchAt, scene: scene2 }], finished))
    result.switchAt = Number(switchAt.toFixed(2))
    result.files = finished.map((f) => ({
      label: f.label.replace(/:.{12,}/, ':id'),
      path: f.item.path,
      duration: Number(f.item.duration.toFixed(2)),
      size: f.item.width ? `${f.item.width}x${f.item.height}` : undefined,
      fps: f.item.fps,
      audio: f.item.hasAudio,
      offset: Number(f.offset.toFixed(3))
    }))
    result.timeline = p.tracks.map((t) => `${t.name}:${t.clips.length}`)
    result.sourceErrors = [...live.errors.values()]
    result.logoOnTimeline = p.tracks.some((t) => t.clips.some((c) => c.mediaId === logo.id))
    result.encoderErrors = errors
    // Silent system audio is dropped on purpose; everything else must be there.
    const expected = tracks.filter((t) => t.label !== SYSTEM_LABEL).length
    result.ok = errors.length === 0 && finished.filter((f) => f.label !== SYSTEM_LABEL).length === expected
    result.systemAudioKept = finished.some((f) => f.label === SYSTEM_LABEL)
    result.micPeakDb = finished.find((f) => f.label === MIC_LABEL)?.peakDb
  } catch (e) {
    result.error = (e as Error).stack ?? String(e)
  } finally {
    live.dispose()
  }
  window.studio.system.selftestDone(result)
}

/**
 * Dev check of export (run with `--selftest-export`): A (440 Hz) → crossfade → B (880 Hz, fades out)
 * with a red logo on top, exported at 1280×720.
 */
export async function runExportSelftest(): Promise<void> {
  const result: Record<string, unknown> = { ok: false }
  try {
    const { exportProject } = await import('../engine/exporter')
    const { path, project } = await window.studio.projects.create(`selftest-${Date.now()}`)
    result.projectPath = path
    const files = (await (window as unknown as { selftestMakeMedia(dir: string): Promise<string[]> }).selftestMakeMedia(`${path}/cache`))
    const [a, b, logo, music] = await window.studio.media.import(path, files)
    const [v1, v2, a1] = project.tracks.map((t) => t.id)
    await window.studio.audio.enhance(path, a, 'light')
    const { duckKeys } = await import('@shared/ducking')
    const base = applyOps(project, [
      { op: 'addMedia', items: [a, b, logo, music] },
      { op: 'insertClip', trackId: a1, mediaId: music.id, start: 0, in: 0, out: 11, clipId: 'M' }
    ])
    const musicClip = base.tracks.find((t) => t.id === a1)!.clips[0]
    const p = applyOps(base, [
      { op: 'setVolumeKeys', clipId: 'M', keys: duckKeys(musicClip, [[2, 4]]) },
      { op: 'insertClip', trackId: v1, mediaId: a.id, start: 0, in: 1, out: 7, clipId: 'A' },
      { op: 'insertClip', trackId: v1, mediaId: b.id, start: 6, in: 2, out: 7, clipId: 'B' },
      { op: 'updateClip', clipId: 'B', crossfadeIn: 1, fadeOut: 1 },
      { op: 'insertClip', trackId: v2, mediaId: logo.id, start: 0, in: 0, out: 11, clipId: 'L' },
      { op: 'updateClip', clipId: 'L', transform: { x: 0.9, y: 0.15, scale: 0.15 } },
      { op: 'updateClip', clipId: 'A', enhance: 'light' },
      { op: 'detachAudio', clipId: 'B' },
      {
        op: 'setTranscript',
        mediaId: a.id,
        transcript: { provider: 'test', model: 'test', createdAt: '', words: ['CAPTION', 'TEST', 'WORDS', 'HERE'].map((text, i) => ({ text, start: 2 + i * 0.5, end: 2.4 + i * 0.5 })) }
      },
      { op: 'setCaptionStyle', patch: { enabled: true, y: 0.8, size: 8 } }
    ])
    // Text layers in the export too: a code card (top-left) and a title (bottom-left), 8–10 s.
    const { compileEdits } = await import('@shared/assistant')
    const withText = compileEdits(p, [
      { op: 'addGraphic', template: 'code', start: 8, end: 10, box: { x: 0.05, y: 0.1, w: 0.5, h: 0.5 }, code: 'int main() {\n    return 42;\n}', filename: 'main.cc', highlights: [{ lines: [2] }], enter: 'none', clipId: 'code' },
      { op: 'addGraphic', template: 'title', start: 8, end: 10, title: 'Export test', kicker: 'SELFTEST', enter: 'none', clipId: 'title' }
    ]).after
    const out = await window.studio.files.exportPath(path, 'selftest export')
    const t0 = performance.now()
    let last = { done: 0, total: 0, speed: 0 }
    await exportProject(withText, path, { path: out, width: 1280, height: 720, fps: 30, videoBitrate: 6_000_000 }, (pr) => (last = pr), new AbortController().signal)
    result.seconds = Number(((performance.now() - t0) / 1000).toFixed(1))
    result.frames = last.done
    result.renderFps = Number(last.speed.toFixed(1))
    result.output = out
    result.loudness = await window.studio.audio.normalize(out, -14)
    result.ok = true
  } catch (e) {
    result.error = (e as Error).stack ?? String(e)
  }
  window.studio.system.selftestDone(result)
}

/** Dev: a throwaway project with a crossfade + logo, opened in the editor (STUDIO_DEV_MODE=demo). */
export async function openDemoProject(): Promise<void> {
  const { useStudio } = await import('../store')
  const opened = await window.studio.projects.create(`devcheck-${Date.now()}`)
  const files = await (window as unknown as { selftestMakeMedia(dir: string): Promise<string[]> }).selftestMakeMedia(`${opened.path}/cache`)
  const [a, b, logo, music] = await window.studio.media.import(opened.path, files)
  const [v1, v2, , a2] = opened.project.tracks.map((t) => t.id)
  const { duckKeys } = await import('@shared/ducking')
  const withMusic = applyOps(opened.project, [
    { op: 'addMedia', items: [a, b, logo, music] },
    { op: 'insertClip', trackId: a2, mediaId: music.id, start: 0, in: 0, out: 11, clipId: 'M' }
  ])
  const project = applyOps(withMusic, [
    { op: 'setVolumeKeys', clipId: 'M', keys: duckKeys(withMusic.tracks.find((t) => t.id === a2)!.clips[0], [[2, 4]]) },
    { op: 'insertClip', trackId: v1, mediaId: a.id, start: 0, in: 1, out: 7, clipId: 'A' },
    { op: 'insertClip', trackId: v1, mediaId: b.id, start: 6, in: 2, out: 7, clipId: 'B' },
    { op: 'updateClip', clipId: 'B', crossfadeIn: 1, fadeOut: 1 },
    { op: 'insertClip', trackId: v2, mediaId: logo.id, start: 0, in: 0, out: 11, clipId: 'L' },
    { op: 'updateClip', clipId: 'L', transform: { x: 0.88, y: 0.18, scale: 0.2, mask: 'circle' } },
    { op: 'detachAudio', clipId: 'B', newClipId: 'BA' },
    // A sample transcript for clip A (source 1..7 s is on the timeline at 0..6 s).
    {
      op: 'setTranscript',
      mediaId: a.id,
      transcript: {
        provider: 'demo',
        model: 'demo',
        createdAt: '',
        words: 'So um today we are building a video editor from scratch. It records, edits and captions.'
          .split(' ')
          .map((text, i) => ({ text, start: 1.2 + i * 0.36 + (i > 10 ? 1.4 : 0), end: 1.2 + i * 0.36 + 0.3 + (i > 10 ? 1.4 : 0) }))
      }
    },
    { op: 'setCaptionStyle', patch: { enabled: true, font: 'Arial Black', size: 6.5, highlight: 'word', uppercase: true, maxChars: 16, maxLines: 2 } }
  ])
  let shown = project
  if (window.studio.dev.mode === 'demo-layout') {
    // The test1 request, as the assistant can now express it.
    const { validateEdits } = await import('@shared/assistant')
    const r = validateEdits(project, [
      { op: 'splitClip', clipId: 'A', time: 1, newClipId: 'A2' },
      { op: 'addTrack', kind: 'video', trackId: 'vtop' },
      { op: 'moveClip', clipId: 'A2', start: 1, trackId: 'vtop' },
      { op: 'updateClip', clipId: 'A2', transform: { x: 0.2, y: 0.78, scale: 0.33, flipH: true } },
      { op: 'addColor', color: '#101828', trackId: v1, start: 1, end: 6, clipId: 'panel' },
      { op: 'setCaptionStyle', patch: { enabled: true, x: 0.72, width: 0.5, y: 0.45 } }
    ])
    if (r.ok) shown = r.after
    else console.error('demo-layout', r.error)
  }
  if (window.studio.dev.mode === 'demo-graphics') {
    // An explainer section built with the same edits the AI proposes.
    const { validateEdits } = await import('@shared/assistant')
    const r = validateEdits(project, [
      { op: 'deleteClips', clipIds: ['L'] },
      { op: 'setCaptionStyle', patch: { enabled: false } },
      { op: 'splitClip', clipId: 'A', time: 1.5, newClipId: 'A2' },
      { op: 'addTrack', kind: 'video', trackId: 'vcam' },
      { op: 'moveClip', clipId: 'A2', start: 1.5, trackId: 'vcam' },
      { op: 'addColor', color: project.theme.background, trackId: v1, start: 1.5, end: 6, clipId: 'bg' },
      { op: 'animate', clipId: 'A2', time: 1.5, duration: 0.6, corner: 'bottom-right', size: 0.33 },
      { op: 'addGraphic', template: 'heading', start: 1.7, end: 6, kicker: '08 — THE HOT LOOP', title: 'forward() — this is the inference', clipId: 'h' },
      {
        op: 'addGraphic',
        template: 'code',
        start: 1.7,
        end: 6,
        filename: 'neuralNetwork.cc — forward()',
        tag: 'the hot loop',
        code: [
          'vector<double> forward(vector<double> inputs) {',
          '    int countNeurons = this->biases.size();',
          '    vector<double> output = this->biases;',
          '',
          '    for (int i = 0; i < countNeurons; i++) {',
          '        for (int j = 0; j < inputs.size(); j++)',
          '            output[i] += this->weights[i * inputs.size() + j] * inputs[j];',
          '        output[i] = relu(output[i]);',
          '    }',
          '    return output;',
          '}'
        ].join('\n'),
        highlights: [{ lines: [7], at: 1 }],
        clipId: 'code'
      },
      { op: 'addGraphic', template: 'lowerThird', start: 2.2, end: 6, title: 'One loop does all the work', box: { x: 0.64, y: 0.4, w: 0.33, h: 0.1 }, scrim: false, clipId: 'lt' }
    ])
    if (r.ok) shown = r.after
    else console.error('demo-graphics', r.error)
  }
  const s = useStudio.getState()
  s.open({ path: opened.path, project: shown })
  if (window.studio.dev.mode === 'demo-graphics') {
    s.selectClips(['code'])
    s.setRightTab('clip')
    s.setPlayhead(4)
  } else if (window.studio.dev.mode === 'demo-modes') {
    s.dispatch({ op: 'setMode', mode: 'demo', extraPrompt: 'warm and playful, pastel colours' })
    s.selectClips([])
    s.setRightTab('clip')
    s.setPlayhead(1.6)
  } else if (window.studio.dev.mode === 'demo-parts') {
    // A part with its own mode, mood and look, selected on the timeline.
    s.dispatch({ op: 'setSection', section: { id: 'part-a', start: 6, end: 11, mode: 'happening', mood: 'warm and playful, pastel colours' } })
    s.dispatch({ op: 'setTheme', sectionId: 'part-a', patch: { accent: '#ff8fab' } })
    s.selectClips([])
    s.setRightTab('clip')
    s.setMarks(6, 11)
    s.setPlayhead(6.5)
  } else {
    s.selectClips([])
    s.setPlayhead(1.6)
    s.setMarks(3, 4.5)
    s.setTool('razor')
  }
}
