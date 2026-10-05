import { useEffect, useMemo, useRef, useState } from 'react'
import type { InputEvent, RecorderSettings } from '@shared/api'
import type { InputMark } from '@shared/zoom'
import { createScene, recordedSources, SCENE_PRESETS, sourceKey, type Rect, type Scene, type SceneItem } from '@shared/scene'
import { MIC_LABEL, PROGRAM_LABEL, SYSTEM_LABEL, takeToOps, type SceneSwitch } from '@shared/take'
import { useStudio } from '../store'
import { formatTime } from '../time'
import { drawScene } from './compositor'
import { LiveSources } from './live-sources'
import { MicMeter } from './MicMeter'
import { PreviewStage } from './PreviewStage'
import { SourcePicker } from './SourcePicker'
import { TakeRecorder, type TakeTrack } from './take-recorder'

type RecState = 'idle' | 'countdown' | 'recording' | 'stopping'

const newId = (): string => crypto.randomUUID()

export function RecorderView({ onTakeSaved }: { onTakeSaved(): void }) {
  const project = useStudio((s) => s.project)!
  const projectPath = useStudio((s) => s.projectPath)!
  const { dispatch, showToast, setRecording } = useStudio.getState()
  const { width: W, height: H } = project.settings

  const [settings, setSettings] = useState<RecorderSettings | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ id: string; rect: Rect } | null>(null)
  const [picker, setPicker] = useState<{ itemId?: string } | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [recState, setRecState] = useState<RecState>('idle')
  const [countdown, setCountdown] = useState(0)
  const [, forceRender] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [live, setLive] = useState<LiveSources | null>(null)
  const recRef = useRef<TakeRecorder | null>(null)
  /** Scenes shown during the current take, with when they were switched to. */
  const switchesRef = useRef<SceneSwitch[]>([])
  /** Whether clicks/typing are being followed for auto zoom during the current take. */
  const followingInputRef = useRef(false)
  const recStateRef = useRef<RecState>('idle')
  recStateRef.current = recState

  // ---- scenes --------------------------------------------------------------------------------
  const scenes = project.scenes
  const active = scenes.find((s) => s.id === project.activeSceneId) ?? scenes[0]
  const shown: Scene | undefined = useMemo(
    () => active && draft ? { ...active, items: active.items.map((i) => (i.id === draft.id ? { ...i, rect: draft.rect } : i)) } : active,
    [active, draft]
  )
  const sceneRef = useRef(shown)
  sceneRef.current = shown
  const selected = active?.items.find((i) => i.id === selectedId)

  useEffect(() => {
    if (!scenes.length) {
      const scene = createScene('Screen + camera', SCENE_PRESETS[0], W, H)
      dispatch({ op: 'setScenes', scenes: [scene], activeSceneId: scene.id })
    }
  }, [scenes.length])

  const saveScenes = (next: Scene[], activeSceneId = active?.id): void => {
    dispatch({ op: 'setScenes', scenes: next, activeSceneId })
  }
  const updateActive = (fn: (s: Scene) => Scene): void => saveScenes(scenes.map((s) => (s.id === active.id ? fn(s) : s)))
  const updateItem = (id: string, patch: Partial<SceneItem>): void =>
    updateActive((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }))

  // ---- settings, devices -------------------------------------------------------------------
  useEffect(() => {
    window.studio.settings.get().then((s) => setSettings(s.recorder))
  }, [])
  const patchSettings = (patch: Partial<RecorderSettings>): void => {
    setSettings((s) => (s ? { ...s, ...patch } : s))
    window.studio.settings.set({ recorder: patch })
  }
  useEffect(() => {
    if (settings) window.studio.window.hideFromCapture(settings.hideStudio)
  }, [settings?.hideStudio])

  const refreshDevices = (): void => {
    navigator.mediaDevices.enumerateDevices().then(setDevices, () => undefined)
  }
  useEffect(() => {
    refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
  }, [])
  const cameras = devices.filter((d) => d.kind === 'videoinput')
  const mics = devices.filter((d) => d.kind === 'audioinput')

  // ---- live sources + preview loop ---------------------------------------------------------
  useEffect(() => {
    if (!settings) return
    const live = new LiveSources(settings.fps)
    live.onChange = () => forceRender((n) => n + 1)
    setLive(live)
    const ctx = canvasRef.current!.getContext('2d')!
    // setInterval, not requestAnimationFrame: it keeps running while minimized (needed for the program video).
    const timer = setInterval(() => {
      if (sceneRef.current) drawScene(ctx, sceneRef.current, W, H, (i) => live.drawable(i))
    }, 1000 / settings.fps)
    return () => {
      clearInterval(timer)
      live.dispose()
      setLive(null)
    }
  }, [settings?.fps, W, H, !!settings])

  // Every scene's sources stay live, so switching scenes (even mid-recording) is instant.
  // While recording, the set of captures is frozen: a recorded source must not stop mid-take.
  const sourcesKey = JSON.stringify(scenes.map((s) => s.items.map((i) => [i.source, i.visible])))
  const idle = recState === 'idle'
  useEffect(() => {
    if (live && idle && scenes.length) live.syncScenes(scenes, project, projectPath).then(refreshDevices)
  }, [sourcesKey, live, idle])

  /** Switches the scene; during a take the switch is logged so the timeline gets each layout. */
  const switchScene = (id: string): void => {
    if (id === active?.id || recStateRef.current === 'stopping') return
    const rec = recRef.current
    if (rec && recStateRef.current === 'recording') {
      const log = switchesRef.current
      if (log.length) log[log.length - 1].scene = sceneRef.current! // keep layout changes made during that stretch
      log.push({ at: rec.elapsed, scene: scenes.find((s) => s.id === id)! })
    }
    saveScenes(scenes, id)
  }

  useEffect(() => {
    if (live && settings) live.setMic(settings.micEnabled, settings.micDeviceId, settings.micAutoGain).then(refreshDevices)
  }, [settings?.micEnabled, settings?.micDeviceId, settings?.micAutoGain, live])

  useEffect(() => {
    if (live && settings) live.setSystemAudio(settings.systemAudio)
  }, [settings?.systemAudio, live])

  // ---- recording ---------------------------------------------------------------------------
  const startRecording = async (): Promise<void> => {
    if (!live || !settings || !active || recStateRef.current !== 'idle') return
    setRecording(true)
    try {
      for (let n = settings.countdownSeconds; n > 0; n--) {
        setRecState('countdown')
        setCountdown(n)
        await new Promise((r) => setTimeout(r, 1000))
        if ((recStateRef.current as RecState) !== 'countdown') return // cancelled
      }

      // One file per distinct screen/camera used by ANY scene, so scenes can be switched mid-take.
      const tracks: TakeTrack[] = []
      const missing: string[] = []
      for (const item of recordedSources(scenes)) {
        const track = live.videoTrack(item)
        if (track) tracks.push({ label: sourceKey(item), kind: 'video', track, role: item.source.type === 'display' ? 'screen' : 'camera', name: item.name })
        else missing.push(item.name)
      }
      if (live.micTrack) tracks.push({ label: MIC_LABEL, kind: 'audio', track: live.micTrack })
      if (live.systemTrack) tracks.push({ label: SYSTEM_LABEL, kind: 'audio', track: live.systemTrack })
      if (settings.recordProgram) {
        const program = canvasRef.current!.captureStream(settings.fps).getVideoTracks()[0] as MediaStreamVideoTrack
        tracks.push({ label: PROGRAM_LABEL, kind: 'video', track: program, role: 'program' })
      }
      if (missing.length) showToast(`Not recording (no signal): ${missing.join(', ')}`)

      recRef.current = await TakeRecorder.start(projectPath, tracks, settings.fps, (e) => showToast(`Recording problem: ${e.message}`))
      switchesRef.current = [{ at: 0, scene: sceneRef.current! }]
      // Auto zoom: follow clicks and typing on the recorded screens (not windows).
      const screens = recordedSources(scenes)
        .filter((i) => i.source.type === 'display' && live.videoTrack(i))
        .map((i) => ({ label: sourceKey(i), sourceId: (i.source as { sourceId?: string }).sourceId }))
      followingInputRef.current = settings.autoZoom && screens.length > 0 && (await window.studio.input.start(screens).catch(() => false))
      setRecState('recording')
      if (settings.minimizeOnRecord) window.studio.window.minimize()
    } catch (e) {
      showToast((e as Error).message)
      setRecState('idle')
      setRecording(false)
    }
  }

  const stopRecording = async (): Promise<void> => {
    if (recStateRef.current === 'countdown') {
      setRecState('idle')
      setRecording(false)
      return
    }
    const rec = recRef.current
    if (!rec || recStateRef.current !== 'recording') return
    setRecState('stopping')
    window.studio.window.restore()
    try {
      const log = switchesRef.current
      if (log.length) log[log.length - 1].scene = sceneRef.current!
      const marks = followingInputRef.current ? inputMarks(rec, await window.studio.input.stop().catch(() => ({}))) : undefined
      const finished = await rec.stop()
      const s = useStudio.getState()
      const ops = takeToOps(s.project!, log.length ? log : [{ at: 0, scene: sceneRef.current! }], finished, marks && { marks, scale: settings!.autoZoomScale })
      s.dispatch(ops)
      const switched = new Set(log.map((x) => x.scene.id)).size
      const zooms = ops.reduce((n, op) => n + (op.op === 'setZooms' ? op.zooms.length : 0), 0)
      showToast(
        `Take saved (${formatTime(rec.elapsed)}${switched > 1 ? `, ${switched} scenes` : ''}${zooms ? `, ${zooms} auto zoom${zooms > 1 ? 's' : ''}` : ''}) and added to the end of the timeline`
      )
      onTakeSaved()
    } catch (e) {
      showToast(`Saving the take failed: ${(e as Error).message}. The raw file is kept in the recordings folder.`)
    } finally {
      recRef.current = null
      switchesRef.current = []
      if (followingInputRef.current) window.studio.input.stop().catch(() => undefined)
      followingInputRef.current = false
      setRecState('idle')
      setRecording(false)
    }
  }

  const togglePause = (): void => {
    const rec = recRef.current
    if (!rec) return
    if (rec.paused) rec.resume()
    else rec.pause()
    forceRender((n) => n + 1)
  }

  // Global hotkeys work even while Studio is minimized.
  const handlers = useRef({ startRecording, stopRecording, togglePause, switchScene, scenes })
  handlers.current = { startRecording, stopRecording, togglePause, switchScene, scenes }
  useEffect(
    () =>
      window.studio.window.onHotkey((key) => {
        const h = handlers.current
        if (key === 'toggle-record') recStateRef.current === 'idle' ? h.startRecording() : h.stopRecording()
        else if (key === 'toggle-pause') h.togglePause()
        else if (key.startsWith('scene-')) {
          const scene = h.scenes[Number(key.slice(6)) - 1]
          if (scene) h.switchScene(scene.id)
        }
      }),
    []
  )

  // Timer display.
  useEffect(() => {
    if (recState !== 'recording') return
    const t = setInterval(() => forceRender((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [recState])

  // ---- adding sources ----------------------------------------------------------------------
  const addItem = (item: Omit<SceneItem, 'id'>): void => {
    const id = newId()
    updateActive((s) => ({ ...s, items: [...s.items, { ...item, id }] }))
    setSelectedId(id)
  }
  const addCamera = (): void => {
    const [, bubble] = SCENE_PRESETS[0].build(W, H)
    addItem({ ...bubble, name: 'Camera', source: { type: 'camera', deviceId: cameras[0]?.deviceId, label: cameras[0]?.label } })
  }
  const addImage = async (): Promise<void> => {
    const files = await window.studio.dialog.pickMediaFiles()
    if (!files.length) return
    try {
      const [media] = await window.studio.media.import(projectPath, files.slice(0, 1))
      if (media.kind !== 'image') return showToast('Please choose an image file')
      dispatch({ op: 'addMedia', items: [media] })
      const w = 0.3
      const h = media.width && media.height ? (w * W * media.height) / media.width / H : 0.3
      addItem({ name: media.name, source: { type: 'image', mediaId: media.id }, rect: { x: 0.35, y: 0.35, w, h }, fit: 'contain', mask: 'none', flipH: false, visible: true })
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  if (!settings || !active || !shown) return <div className="flex-1" />
  const busy = recState !== 'idle'
  const errors = [...(live?.errors.values() ?? [])]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* ---- Left: scenes + sources ---- */}
        <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-auto border-r border-line bg-panel p-3">
          <section>
            <PanelTitle>Scenes</PanelTitle>
            <ul className="space-y-1">
              {scenes.map((s, n) => (
                <li key={s.id} className={`group flex items-center rounded px-2 py-1.5 ${s.id === active.id ? 'bg-accent/20 text-text' : 'text-muted hover:bg-panel-2'}`}>
                  {renaming === s.id ? (
                    <input
                      autoFocus
                      defaultValue={s.name}
                      className="flex-1 rounded bg-panel-2 px-1 outline-none"
                      onBlur={(e) => (saveScenes(scenes.map((x) => (x.id === s.id ? { ...x, name: e.target.value || x.name } : x))), setRenaming(null))}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    />
                  ) : (
                    <button
                      className="flex flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
                      disabled={recState === 'stopping' || recState === 'countdown'}
                      title={n < 8 ? `Ctrl+Shift+F${n + 1} switches to this scene, also while recording` : undefined}
                      onClick={() => switchScene(s.id)}
                      onDoubleClick={() => !busy && setRenaming(s.id)}
                    >
                      <span className="flex-1">{s.name}</span>
                      {n < 8 && <span className="font-mono text-[10px] text-muted">F{n + 1}</span>}
                    </button>
                  )}
                  {scenes.length > 1 && !busy && (
                    <button className="invisible text-muted group-hover:visible hover:text-danger" title="Delete scene" onClick={() => saveScenes(scenes.filter((x) => x.id !== s.id), s.id === active.id ? scenes.find((x) => x.id !== s.id)!.id : active.id)}>
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <select
              className="mt-2 w-full rounded border border-line bg-panel-2 px-2 py-1 text-muted"
              value=""
              disabled={busy}
              onChange={(e) => {
                const preset = SCENE_PRESETS.find((p) => p.key === e.target.value)
                if (!preset) return
                const scene = createScene(preset.name, preset, W, H)
                saveScenes([...scenes, scene], scene.id)
              }}
            >
              <option value="">+ New scene from layout…</option>
              {SCENE_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>{p.name}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted">
              {recState === 'recording' ? 'Click a scene (or Ctrl+Shift+F1…F8) to switch layout — it is recorded.' : 'Double-click a scene to rename it. You can switch scenes while recording.'}
            </p>
          </section>

          <section>
            <PanelTitle>Sources in “{active.name}”</PanelTitle>
            <ul className="space-y-1">
              {[...active.items].reverse().map((item) => {
                const idx = active.items.indexOf(item)
                const err = live?.error(item)
                return (
                  <li
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1.5 ${item.id === selectedId ? 'bg-panel-2 ring-1 ring-accent' : 'hover:bg-panel-2'}`}
                  >
                    <span className="w-5 text-center">{item.source.type === 'display' ? '🖥' : item.source.type === 'camera' ? '📷' : '🖼'}</span>
                    <span className={`flex-1 truncate ${item.visible ? '' : 'text-muted line-through'}`} title={err}>
                      {item.name} {err && <span className="text-danger">⚠</span>}
                    </span>
                    <IconBtn title="Move up (in front)" disabled={idx === active.items.length - 1} onClick={() => updateActive((s) => ({ ...s, items: swap(s.items, idx, idx + 1) }))}>▲</IconBtn>
                    <IconBtn title="Move down (behind)" disabled={idx === 0} onClick={() => updateActive((s) => ({ ...s, items: swap(s.items, idx, idx - 1) }))}>▼</IconBtn>
                    {item.source.type !== 'image' && (
                      <IconBtn title={item.flipH ? 'Mirrored — click to un-mirror' : 'Mirror (flip left-right)'} active={item.flipH} onClick={() => updateItem(item.id, { flipH: !item.flipH })}>
                        ⇋
                      </IconBtn>
                    )}
                    <IconBtn title={item.visible ? 'Hide' : 'Show'} onClick={() => updateItem(item.id, { visible: !item.visible })}>{item.visible ? '👁' : '–'}</IconBtn>
                    <IconBtn title="Remove" disabled={busy} onClick={() => updateActive((s) => ({ ...s, items: s.items.filter((i) => i.id !== item.id) }))}>✕</IconBtn>
                  </li>
                )
              })}
            </ul>
            <div className="mt-2 grid grid-cols-3 gap-1">
              <AddBtn disabled={busy} onClick={() => setPicker({})}>+ Screen</AddBtn>
              <AddBtn disabled={busy} onClick={addCamera}>+ Camera</AddBtn>
              <AddBtn disabled={busy} onClick={addImage}>+ Image</AddBtn>
            </div>
          </section>
        </aside>

        {/* ---- Center: live preview ---- */}
        <PreviewStage
          canvasRef={canvasRef}
          scene={shown}
          width={W}
          height={H}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRectChange={(id, rect, commit) => {
            if (commit) {
              updateItem(id, { rect })
              setDraft(null)
            } else setDraft({ id, rect })
          }}
          overlay={
            recState === 'countdown' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-8xl font-bold">{countdown}</div>
            ) : null
          }
        />

        {/* ---- Right: properties, audio, output ---- */}
        <aside className="flex w-72 shrink-0 flex-col gap-5 overflow-auto border-l border-line bg-panel p-3">
          {selected ? (
            <section className="space-y-2">
              <PanelTitle>{selected.name}</PanelTitle>
              {selected.source.type === 'display' && (
                <button className="w-full rounded bg-panel-2 px-2 py-1.5 text-left hover:bg-line" disabled={busy} onClick={() => setPicker({ itemId: selected.id })}>
                  {selected.source.name ?? 'Main screen'} <span className="float-right text-muted">Change</span>
                </button>
              )}
              {selected.source.type === 'camera' && (
                <Field label="Camera">
                  <select
                    className="w-full rounded border border-line bg-panel-2 px-2 py-1"
                    value={selected.source.deviceId ?? ''}
                    disabled={busy}
                    onChange={(e) => {
                      const d = cameras.find((c) => c.deviceId === e.target.value)
                      updateItem(selected.id, { source: { type: 'camera', deviceId: d?.deviceId, label: d?.label } })
                    }}
                  >
                    <option value="">Default camera</option>
                    {cameras.map((c) => (
                      <option key={c.deviceId} value={c.deviceId}>{c.label || 'Camera'}</option>
                    ))}
                  </select>
                </Field>
              )}
              {(() => {
                const d = live?.drawable(selected)
                if (!d || selected.source.type === 'image') return null
                const ratio = d.width / d.height
                const shape = Math.abs(ratio - 16 / 9) < 0.02 ? '16:9' : Math.abs(ratio - 4 / 3) < 0.02 ? '4:3' : ratio.toFixed(2)
                return (
                  <p className="text-[11px] text-muted">
                    Sending {d.width}×{d.height} ({shape}). {selected.fit === 'cover' ? '“Fill” crops the edges to fit the box; choose “Fit” to see the whole picture.' : ''}
                  </p>
                )
              })()}
              <Field label="Fit">
                <Segmented value={selected.fit} options={[['contain', 'Fit'], ['cover', 'Fill']]} onChange={(fit) => updateItem(selected.id, { fit })} />
              </Field>
              <Field label="Shape">
                <Segmented
                  value={selected.mask}
                  options={[['none', 'Square'], ['rounded', 'Rounded'], ['circle', 'Circle']]}
                  onChange={(mask) => updateItem(selected.id, mask === 'circle' ? { mask, fit: 'cover', rect: squareRect(selected.rect, W, H) } : { mask })}
                />
              </Field>
              {selected.source.type !== 'image' && (
                <Check label="Mirror (flip left-right)" checked={selected.flipH} onChange={(v) => updateItem(selected.id, { flipH: v })} />
              )}
              <button className="text-xs text-accent hover:underline" onClick={() => updateItem(selected.id, { rect: { x: 0, y: 0, w: 1, h: 1 } })}>
                Make full screen
              </button>
              <p className="text-[11px] text-muted">Drag in the preview to move. Corners resize keeping the shape (hold Shift to stretch); side handles stretch one side.</p>
            </section>
          ) : (
            <p className="text-muted">Select a source to edit it.</p>
          )}

          <section className="space-y-2">
            <PanelTitle>Audio</PanelTitle>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.micEnabled} disabled={busy} onChange={(e) => patchSettings({ micEnabled: e.target.checked })} />
              Microphone
            </label>
            {settings.micEnabled && (
              <>
                <select
                  className="w-full rounded border border-line bg-panel-2 px-2 py-1"
                  value={settings.micDeviceId ?? ''}
                  disabled={busy}
                  onChange={(e) => patchSettings({ micDeviceId: e.target.value || undefined })}
                >
                  <option value="">Default microphone</option>
                  {mics.filter((m) => m.deviceId !== 'default' && m.deviceId !== 'communications').map((m) => (
                    <option key={m.deviceId} value={m.deviceId}>{m.label || 'Microphone'}</option>
                  ))}
                </select>
                <MicMeter stream={live?.micStream} />
                <Check label="Automatic mic volume (recommended)" checked={settings.micAutoGain} disabled={busy} onChange={(v) => patchSettings({ micAutoGain: v })} />
              </>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={settings.systemAudio} disabled={busy} onChange={(e) => patchSettings({ systemAudio: e.target.checked })} />
              Computer sound (system audio)
            </label>
          </section>

          <section className="space-y-2">
            <PanelTitle>Recording</PanelTitle>
            <Field label="Frame rate">
              <Segmented value={String(settings.fps)} options={[['30', '30 fps'], ['60', '60 fps']]} onChange={(v) => !busy && patchSettings({ fps: Number(v) as 30 | 60 })} />
            </Field>
            <Check label="Also save the finished scene as one video" checked={settings.recordProgram} disabled={busy} onChange={(v) => patchSettings({ recordProgram: v })} />
            <Check label="Zoom in where I click or type (screens)" checked={settings.autoZoom} disabled={busy} onChange={(v) => patchSettings({ autoZoom: v })} />
            {settings.autoZoom && (
              <Field label="Zoom">
                <Segmented
                  value={String(settings.autoZoomScale)}
                  options={[['1.5', 'Light'], ['1.8', 'Medium'], ['2.2', 'Strong']]}
                  onChange={(v) => !busy && patchSettings({ autoZoomScale: Number(v) })}
                />
              </Field>
            )}
            <Check label="Hide Studio from screen recordings" checked={settings.hideStudio} onChange={(v) => patchSettings({ hideStudio: v })} />
            <Check label="Minimize Studio when recording starts" checked={settings.minimizeOnRecord} onChange={(v) => patchSettings({ minimizeOnRecord: v })} />
            <Field label="Countdown">
              <Segmented value={String(settings.countdownSeconds)} options={[['0', 'Off'], ['3', '3 s'], ['5', '5 s']]} onChange={(v) => patchSettings({ countdownSeconds: Number(v) })} />
            </Field>
            {settings.fps === 60 && <p className="text-[11px] text-yellow-400">60 fps is heavy for this laptop; 30 fps is recommended.</p>}
          </section>

          {errors.length > 0 && (
            <section className="space-y-1 text-xs text-danger">
              {errors.map((e) => <p key={e}>{e}</p>)}
            </section>
          )}
        </aside>
      </div>

      {/* ---- Bottom: record controls ---- */}
      <footer className="flex h-16 shrink-0 items-center gap-4 border-t border-line bg-panel px-4">
        {recState === 'idle' || recState === 'countdown' ? (
          <button className="flex items-center gap-2 rounded-full bg-danger px-5 py-2 font-semibold text-white" onClick={recState === 'idle' ? startRecording : stopRecording}>
            <span className="h-3 w-3 rounded-full bg-white" /> {recState === 'idle' ? 'Start recording' : 'Cancel'}
          </button>
        ) : (
          <>
            <button className="flex items-center gap-2 rounded-full bg-panel-2 px-5 py-2 font-semibold disabled:opacity-50" disabled={recState === 'stopping'} onClick={stopRecording}>
              <span className="h-3 w-3 bg-danger" /> {recState === 'stopping' ? 'Saving…' : 'Stop'}
            </button>
            <button className="rounded-full bg-panel-2 px-4 py-2 disabled:opacity-50" disabled={recState === 'stopping'} onClick={togglePause}>
              {recRef.current?.paused ? '▶ Resume' : '❚❚ Pause'}
            </button>
          </>
        )}
        <span className={`font-mono text-lg ${recState === 'recording' && !recRef.current?.paused ? 'text-danger' : 'text-muted'}`}>
          {recState === 'recording' && '● '}
          {formatTime(recRef.current?.elapsed ?? 0)}
        </span>
        <span className="ml-auto text-xs text-muted">
          Ctrl+Shift+F9 start/stop · F10 pause · F1–F8 switch scene — these work while Studio is minimized
        </span>
      </footer>

      {picker && (
        <SourcePicker
          onClose={() => setPicker(null)}
          onPick={(src) => {
            const source = { type: 'display' as const, sourceId: src.id, name: src.name }
            if (picker.itemId) updateItem(picker.itemId, { source, name: src.kind === 'screen' ? 'Screen' : src.name.slice(0, 40) })
            else addItem({ name: src.kind === 'screen' ? 'Screen' : src.name.slice(0, 40), source, rect: { x: 0, y: 0, w: 1, h: 1 }, fit: 'contain', mask: 'none', flipH: false, visible: true })
            setPicker(null)
          }}
        />
      )}
    </div>
  )
}

/** Largest square (in pixels) that fits in the rect, keeping its center. */
function squareRect(r: Rect, W: number, H: number): Rect {
  const size = Math.min(r.w * W, r.h * H)
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  return { x: cx - size / W / 2, y: cy - size / H / 2, w: size / W, h: size / H }
}

const swap = <T,>(arr: T[], i: number, j: number): T[] => {
  const out = [...arr]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{children}</h3>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function Segmented<T extends string>(props: { value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="flex rounded border border-line p-0.5">
      {props.options.map(([v, label]) => (
        <button key={v} className={`flex-1 rounded px-1 py-0.5 text-xs ${props.value === v ? 'bg-accent text-white' : 'text-muted hover:text-text'}`} onClick={() => props.onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function Check(props: { label: string; checked: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-0.5" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  )
}

function IconBtn(props: { title: string; disabled?: boolean; active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={(e) => (e.stopPropagation(), props.onClick())}
      className={`h-5 w-5 rounded text-[10px] disabled:opacity-20 ${props.active ? 'bg-accent text-white' : 'text-muted hover:bg-line hover:text-text'}`}
    >
      {props.children}
    </button>
  )
}

function AddBtn(props: { disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button disabled={props.disabled} onClick={props.onClick} className="rounded bg-panel-2 px-1 py-1.5 text-xs hover:bg-line disabled:opacity-40">
      {props.children}
    </button>
  )
}

/**
 * Clicks/typing per screen in take seconds (pauses skipped). The last moment of the take is
 * dropped: that is usually the click on Stop.
 */
function inputMarks(rec: TakeRecorder, events: Record<string, InputEvent[]>): Record<string, InputMark[]> {
  const end = rec.elapsed - 1
  return Object.fromEntries(
    Object.entries(events).map(([label, list]) => [
      label,
      list.flatMap((e) => {
        const t = rec.takeTime(e.at)
        return t === null || t > end ? [] : [{ t, kind: e.kind, x: e.x, y: e.y }]
      })
    ])
  )
}
