import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron'
import { rm, writeFile } from 'fs/promises'
import { basename } from 'path'
import { join } from 'path'
import { registerIpc } from './ipc'
import { handleMediaProtocol, registerMediaScheme } from './media-protocol'
import { registerCapture, registerHotkeys } from './capture'
import { registerInputCapture } from './input-capture'
import { registerRecording } from './recording'
import { registerAiIpc } from './ai/ipc'

registerMediaScheme()

// Keep capture, compositing and encoding running at full speed while Studio is minimized.
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

/** Project folder to export when started with `--cli export --project <dir>`. */
let CLI_EXPORT = ''

const SELFTEST = process.argv.includes('--selftest-record')
  ? 'selftest'
  : process.argv.includes('--selftest-export')
    ? 'selftest-export'
    : ''

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f1115',
    title: 'Studio',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      // Keep compositing and encoding at full speed while minimized during a recording.
      backgroundThrottling: false,
      additionalArguments: [
        ...(SELFTEST || process.env['STUDIO_DEV_MODE'] ? ['--selftest'] : []),
        ...(CLI_EXPORT ? [`--cli-export=${CLI_EXPORT}`] : [])
      ]
    }
  })
  win.once('ready-to-show', () => win.show())
  // Dev: STUDIO_SCREENSHOT=<file.png> saves a screenshot of the window after a delay, then quits.
  const shot = process.env['STUDIO_SCREENSHOT']
  if (shot) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        await writeFile(shot, (await win.webContents.capturePage()).toPNG())
        app.exit(0)
      }, Number(process.env['STUDIO_SCREENSHOT_DELAY'] ?? 8000))
    )
  }
  registerHotkeys(win)
  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const hash = SELFTEST
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

if (SELFTEST || process.env['STUDIO_DEV_MODE']) {
  // Test media for the export self-test: two tone+pattern clips and a PNG.
  ipcMain.handle('selftest:makeMedia', async (_e, dir: string) => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const { ffmpegPath } = await import('./ffmpeg')
    const run = promisify(execFile)
    const make = (name: string, video: string, tone: number, secs: number) =>
      run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `${video}=size=640x360:rate=30:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, name)])
    await make('a.mp4', 'testsrc', 440, 10)
    await make('b.mp4', 'testsrc2', 880, 8)
    await run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=200x200', '-frames:v', '1', join(dir, 'logo.png')])
    await run(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=12', '-c:a', 'aac', join(dir, 'music.m4a')])
    return ['a.mp4', 'b.mp4', 'logo.png', 'music.m4a'].map((f) => join(dir, f))
  })
}
if (SELFTEST) {
  ipcMain.once('selftest:done', async (_e, result: { ok?: boolean; projectPath?: string }) => {
    console.log(`SELFTEST ${JSON.stringify(result, null, 2)}`)
    // Remove the throwaway test project unless asked to keep it.
    if (result.projectPath && basename(result.projectPath).startsWith('selftest-') && !process.argv.includes('--keep')) {
      await rm(result.projectPath, { recursive: true, force: true })
    }
    app.exit(result.ok ? 0 : 1)
  })
}

// `electron . --cli <setup|ask|export> …` runs Studio steps from the command line (see cli.ts).
const cliCmd = process.argv.includes('--cli') ? process.argv[process.argv.indexOf('--cli') + 1] : ''
if (cliCmd === 'export') {
  const i = process.argv.indexOf('--project')
  CLI_EXPORT = i > 0 ? process.argv[i + 1] : ''
  ipcMain.once('selftest:done', async (_e, result: { ok?: boolean; error?: string }) => {
    console.log(`EXPORT ${JSON.stringify(result, null, 2)}`)
    try {
      const { RunLog } = await import('./cli')
      const log = new RunLog(CLI_EXPORT)
      await log.step(
        'Export',
        result.ok ? `Rendered the timeline to MP4 (same renderer as the preview), balanced loudness to YouTube level, saved subtitles.\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`` : `Export failed: ${result.error}`
      )
    } catch {
      // logging is best-effort
    }
    app.exit(result.ok ? 0 : 1)
  })
}
if (cliCmd && cliCmd !== 'export') {
  app.whenReady().then(async () => {
    try {
      const { runCli } = await import('./cli')
      await runCli(cliCmd)
      app.exit(0)
    } catch (e) {
      console.error(`CLI failed: ${(e as Error).stack ?? e}`)
      app.exit(1)
    }
  })
} else if (process.argv.indexOf('--transcribe-file') > 0) {
  // Dev: `electron . --transcribe-file <media> --out <json>` transcribes one file with the saved key and exits.
  const transcribeArg = process.argv.indexOf('--transcribe-file')
  app.whenReady().then(async () => {
    const file = process.argv[transcribeArg + 1]
    const out = process.argv[process.argv.indexOf('--out') + 1]
    try {
      const { probe } = await import('./ffmpeg')
      const { transcribeMedia } = await import('./ai/transcribe')
      const info = await probe(file)
      const media = { id: 'cli', kind: 'audio' as const, name: basename(file), path: file, linked: true, duration: info.duration, hasAudio: true }
      const t = await transcribeMedia(join(out, '..'), media, (d, n) => console.log(`TRANSCRIBE ${d}/${n}`))
      await writeFile(out, JSON.stringify(t, null, 2))
      console.log(`TRANSCRIBE done: ${t.words.length} words`)
      app.exit(0)
    } catch (e) {
      console.error(`TRANSCRIBE failed: ${(e as Error).message}`)
      app.exit(1)
    }
  })
} else
app.whenReady().then(() => {
  handleMediaProtocol()
  registerIpc()
  registerCapture()
  registerInputCapture()
  registerRecording()
  registerAiIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
