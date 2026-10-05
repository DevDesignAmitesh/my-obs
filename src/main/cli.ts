import { execFile } from 'child_process'
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import { AI_HISTORY_FILE, compileEdits, describeEdit, fmt, type ChatTurn, type Selection } from '@shared/assistant'
import { timelineWords } from '@shared/captions'
import { applyOps } from '@shared/ops'
import { newId, type Project } from '@shared/project'
import { sectionFor } from '@shared/sections'
import { createProjectFolder, importMedia, openProject, saveProject } from './project-store'
import { ffmpegPath } from './ffmpeg'
import { transcribeMedia } from './ai/transcribe'
import { runAssistant, type AssistLog } from './ai/assistant'
import { refineFeedback } from './ai/refine'
import { buildModeRequest, modeById, MODES, REFINER_SYSTEM } from '@shared/modes'
import { getSettings } from './settings'

const run = promisify(execFile)

/**
 * Studio from the command line — the same code the app runs, with every step written to
 * <project>/AUTO-EDIT-LOG.md (readable) and <project>/logs/*.json (raw AI traffic).
 *
 *   electron . --cli setup  --source <video> --name <project name>
 *   electron . --cli ask    --project <dir> --prompt-file <txt> [--frames 10,95,170] [--from <s> --to <s>] [--apply]
 *   electron . --cli export --project <dir>        (handled in index.ts: needs a window)
 */

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

/** `--from <s> --to <s>`: limit the request to that part of the timeline. */
function scopeArg(): Selection | null {
  const from = Number(arg('from'))
  const to = Number(arg('to'))
  return Number.isFinite(from) && Number.isFinite(to) && to > from && arg('from') !== undefined ? { start: from, end: to } : null
}

const stamp = (): string => new Date().toLocaleString('en-IN', { hour12: false })

export class RunLog {
  constructor(private projectPath: string) {}
  get file(): string {
    return join(this.projectPath, 'AUTO-EDIT-LOG.md')
  }
  async write(md: string): Promise<void> {
    await appendFile(this.file, `${md}\n`)
    console.log(md.split('\n')[0])
  }
  async step(title: string, body = ''): Promise<void> {
    await this.write(`\n## ${title}\n_${stamp()}_\n\n${body}`)
  }
}

const fence = (s: string, lang = ''): string => `\`\`\`${lang}\n${s.replace(/```/g, '`​``')}\n\`\`\``
const details = (summary: string, body: string): string => `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`

export async function runCli(cmd: string): Promise<void> {
  if (cmd === 'setup') return setup()
  if (cmd === 'ask') return ask()
  if (cmd === 'generate') return generate()
  if (cmd === 'feedback') return feedback()
  if (cmd === 'modes-doc') return modesDoc()
  throw new Error(`Unknown --cli command "${cmd}"`)
}

/**
 * `--cli generate --project <dir> [--mode explainer|demo|happening] [--extra "<mood / instructions>"] [--from <s> --to <s>] [--frames …] [--apply]`
 * With --from/--to only that part is edited, with its own mode and mood (--extra).
 */
async function generate(): Promise<void> {
  const projectPath = arg('project')
  if (!projectPath) throw new Error('generate needs --project')
  let { project } = await openProject(projectPath)
  const mode = arg('mode') as Project['mode'] | undefined
  const extra = arg('extra')
  const scope = scopeArg()
  let genMode = project.mode
  let genMood = project.extraPrompt
  if (scope) {
    const old = sectionFor(project, scope.start, scope.end)
    const section = { id: old?.id ?? newId(), start: scope.start, end: scope.end, mode: mode ?? old?.mode ?? project.mode, mood: extra ?? old?.mood ?? '' }
    project = applyOps(project, [{ op: 'setSection', section }])
    genMode = section.mode
    genMood = section.mood
  } else if (mode || extra !== undefined) {
    project = applyOps(project, [{ op: 'setMode', mode, extraPrompt: extra }])
    genMode = project.mode
    genMood = project.extraPrompt
  }
  await saveProject(projectPath, project)
  const m = modeById(genMode)
  await new RunLog(projectPath).step(
    `Generate — ${scope ? `part ${fmt(scope.start)}–${fmt(scope.end)}, ` : ''}${m.name} mode`,
    `Mode: **${m.name}** (learned from ${m.reference}).\nMood & extra instructions: ${genMood.trim() ? `“${genMood.trim()}”` : '(none — the mode’s default look is used)'}.\n${scope ? 'Only this part may change; edits outside it are rejected.\n' : ''}The request below is built automatically from the mode recipe + these instructions.`
  )
  await ask({ prompt: buildModeRequest(genMode, genMood, { scope, project, standing: scope ? project.extraPrompt : '' }), kind: 'generate', shown: `${scope ? `${fmt(scope.start)}–${fmt(scope.end)} · ` : ''}${m.name} mode${genMood.trim() ? ` · “${genMood.trim()}”` : ''}` })
}

/** `--cli feedback --project <dir> --text "<feedback>" [--apply]`: refine first, then edit. */
async function feedback(): Promise<void> {
  const projectPath = arg('project')
  const text = arg('text')
  if (!projectPath || !text) throw new Error('feedback needs --project and --text')
  let { project } = await openProject(projectPath)
  const log = new RunLog(projectPath)
  let turns: ChatTurn[] = []
  try {
    turns = JSON.parse(await readFile(join(projectPath, AI_HISTORY_FILE), 'utf8')).turns ?? []
  } catch {
    // no chat yet
  }
  await log.step('Feedback — step 1: understand it', `**Your feedback:**\n\n> ${text}\n\nSent to the refiner AI with the mode recipe, the standing instructions, the timeline and the recent chat.`)
  const r = await refineFeedback({ project, feedback: text, history: turns.map((t) => ({ role: t.role, text: t.text })), selection: scopeArg(), playhead: 0 })
  await log.write(
    `${details('What the refiner was given', fence(r.prompt))}\n\n${details('Refiner’s raw answer', fence(r.raw))}\n\n` +
      `**Understood:** ${r.intent || '(no summary)'}\n\n**Instruction for the editor:** ${r.instruction}${r.remember ? `\n\n📌 **Remembered for this project:** ${r.remember}` : ''}`
  )
  if (r.remember) {
    project = applyOps(project, [{ op: 'setMode', extraPrompt: [project.extraPrompt.trim(), r.remember].filter(Boolean).join('\n') }])
    await saveProject(projectPath, project)
  }
  await ask({ prompt: `${r.instruction}\n\n(The user's own words: "${text}")`, kind: 'feedback', shown: text, refined: { intent: r.intent, instruction: r.instruction, remember: r.remember } })
}

/** `--cli modes-doc --out <file.md>`: writes the three mode prompts as a readable document. */
async function modesDoc(): Promise<void> {
  const out = arg('out')
  if (!out) throw new Error('modes-doc needs --out')
  const parts = MODES.map(
    (m) =>
      `## ${m.name}\n\n_${m.tagline}_ — learned from ${m.reference}\n\n### Editing recipe (always applied)\n\n${fence(m.recipe)}\n\n### Default look (only when you give no mood)\n\n${m.defaultLook.description}\n\n${details('Theme and caption values', fence(JSON.stringify(m.defaultLook, null, 2), 'json'))}`
  )
  const example = buildModeRequest('demo', 'warm and playful, pastel colours, keep it under 90 seconds')
  await writeFile(
    out,
    `# Studio video modes\n\nThe three editing styles Studio's AI can apply. “✨ Generate edit” combines the chosen mode's recipe with your mood & extra instructions. If you describe a mood, it replaces the default look; the editing structure stays.\n\n${parts.join('\n\n')}\n\n## How a request is built\n\nExample: Project demo mode + “warm and playful, pastel colours, keep it under 90 seconds”:\n\n${fence(example)}\n\n## Feedback\n\nWhen you send feedback, a first AI call reads it with the mode recipe, your standing instructions, the timeline and the recent chat, and answers with:\n\n${fence(REFINER_SYSTEM)}\n\nIts “instruction” is then sent to the editing AI; anything it “remembers” is added to your project's standing instructions.\n`
  )
  console.log(`MODES DOC ${out}`)
}

async function setup(): Promise<void> {
  const source = arg('source')
  const name = arg('name')
  if (!source || !name) throw new Error('setup needs --source and --name')
  const { path, project } = await createProjectFolder(name)
  const log = new RunLog(path)
  await log.write(`# Auto-edit log — ${name}\n\nEverything Studio did for this project, step by step: the commands, every request sent to the AI and every answer it gave, and the edits applied. Newest steps are at the bottom.\n\n- Source video: \`${source}\` (copied in; the original is never changed)\n- Project folder: \`${path}\``)

  await log.step('Step 1 — Import the video', 'Copied the video into `media/` and probed it.')
  const [media] = await importMedia(path, [source], 'copy')
  await log.write(`- ${media.name}: ${media.width}×${media.height}, ${media.fps?.toFixed(2)} fps, ${fmt(media.duration)} long, sound: ${media.hasAudio ? 'yes' : 'no'}`)

  let p: Project = applyOps(project, [
    { op: 'addMedia', items: [media] },
    { op: 'insertClip', trackId: project.tracks[0].id, mediaId: media.id, start: 0, clipId: 'main' }
  ])
  await log.write(`- Placed it on track V1 as clip \`main\` (0:00 → ${fmt(media.duration)}). Its own sound plays from the video clip.`)

  const { ai } = await getSettings()
  await log.step('Step 2 — Transcribe', `Provider **${ai.transcription.provider}**, model **${ai.transcription.model}**, language ${ai.transcription.language}, filler words kept: ${ai.transcription.keepFillers}.`)
  const t = await transcribeMedia(path, media, (d, n) => console.log(`  transcribing ${d}/${n}`))
  p = applyOps(p, [{ op: 'setTranscript', mediaId: media.id, transcript: t }])
  const words = timelineWords(p)
  const lines: string[] = []
  let line = ''
  let start = 0
  for (const w of words) {
    if (!line) start = w.start
    line += `${w.text} `
    if (/[.!?]$/.test(w.text) || line.length > 120) {
      lines.push(`[${fmt(start)}] ${line.trim()}`)
      line = ''
    }
  }
  if (line) lines.push(`[${fmt(start)}] ${line.trim()}`)
  await log.write(`- ${t.words.length} words, detected language: ${t.language ?? '?'}\n\n${details('Full transcript (click to open)', fence(lines.join('\n')))}`)

  await saveProject(path, p)
  await log.write(`\nSaved \`project.json\`. Next: ask the AI to restyle the video.`)
  console.log(`PROJECT ${path}`)
}

async function framesAsImages(projectPath: string, p: Project, times: number[]): Promise<string[]> {
  const clip = p.tracks[0].clips[0]
  const media = p.media.find((m) => m.id === clip?.mediaId)
  if (!media) return []
  const dir = join(projectPath, 'cache', 'ai-frames')
  await mkdir(dir, { recursive: true })
  const out: string[] = []
  for (const t of times) {
    const file = join(dir, `frame-${t}.jpg`)
    await run(ffmpegPath, ['-y', '-v', 'error', '-ss', String(t), '-i', join(projectPath, media.path), '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', file])
    out.push(`data:image/jpeg;base64,${(await readFile(file)).toString('base64')}`)
  }
  return out
}

async function ask(given?: { prompt: string; kind: 'generate' | 'feedback'; shown?: string; refined?: ChatTurn['refined'] }): Promise<void> {
  const projectPath = arg('project')
  const promptFile = arg('prompt-file')
  if (!projectPath || (!promptFile && !given)) throw new Error('ask needs --project and --prompt-file')
  const { project } = await openProject(projectPath)
  const prompt = given ? given.prompt : (await readFile(promptFile!, 'utf8')).trim()
  const log = new RunLog(projectPath)
  const historyFile = join(projectPath, AI_HISTORY_FILE)
  let turns: ChatTurn[] = []
  try {
    turns = JSON.parse(await readFile(historyFile, 'utf8')).turns ?? []
  } catch {
    // first request
  }
  const n = turns.filter((t) => t.role === 'user').length + 1
  const frameTimes = (arg('frames') ?? '').split(',').filter(Boolean).map(Number)
  const images = frameTimes.length ? await framesAsImages(projectPath, project, frameTimes) : []

  await log.step(`Step ${n + 2} — Ask the AI (request #${n})`, `**What I asked (sent exactly like this):**\n\n${prompt.split('\n').map((l) => `> ${l}`).join('\n')}${images.length ? `\n\nAlso sent ${images.length} frames from the video at ${frameTimes.map((t) => fmt(t)).join(', ')} so the AI can see it.` : ''}`)

  const raw: unknown[] = []
  const assistLog: AssistLog = {
    request(info) {
      raw.push({ kind: 'request', ...info, tools: info.tools.map((t) => t.name) })
      void log.write(
        `Sent to **${info.provider} / ${info.model}** with ${info.tools.length} tools (${info.tools.map((t) => t.name).join(', ')}).\n\n` +
          details('System prompt (Studio’s standing instructions to the AI)', fence(info.system)) +
          '\n\n' +
          details('Everything the AI was given about the project (context)', fence(info.userText))
      )
    },
    event(e) {
      raw.push(e)
      if (e.type === 'model') {
        const calls = e.toolCalls.map((c) => `- calls **${c.name}**\n\n${details('arguments', fence(JSON.stringify(c.input, null, 2), 'json'))}`).join('\n')
        void log.write(`\n**AI → step ${e.step + 1}** (stop: ${e.stopReason ?? '?'})${e.text ? `\n\n${e.text.split('\n').map((l) => `> ${l}`).join('\n')}` : ''}${calls ? `\n\n${calls}` : ''}`)
      } else {
        void log.write(`\n**Studio → AI** (result of ${e.name}):\n\n${fence(e.output.length > 1500 ? `${e.output.slice(0, 1500)}…` : e.output)}`)
      }
    }
  }

  const history = turns.filter((t) => !t.error).slice(-8).map((t) => ({ role: t.role, content: t.text || t.proposal?.summary || '' }))
  const { ai } = await getSettings()
  const started = Date.now()
  const scope = scopeArg()
  const result = await runAssistant({ project, selection: scope, playhead: 0, prompt, history, images }, (s) => console.log(`  ${s}`), assistLog)
  await new Promise((r) => setTimeout(r, 50)) // let queued log writes finish in order

  const time = new Date().toISOString()
  const userText =
    given?.kind === 'generate' ? `✨ Generate edit — ${given.shown ?? `${modeById(project.mode).name} mode`}`
    : given?.kind === 'feedback' ? `💬 ${given.shown ?? prompt}`
    : prompt
  const userTurn: ChatTurn = { role: 'user', text: userText, time, scope, kind: given?.kind ?? 'ask' }
  const refinedTurn: ChatTurn[] = given?.refined
    ? [{ role: 'assistant', text: `🎯 Understood: ${given.refined.intent}\n→ ${given.refined.instruction}${given.refined.remember ? `\n📌 Remembered for this project: ${given.refined.remember}` : ''}`, time, refined: given.refined }]
    : []
  const aiTurn: ChatTurn = { role: 'assistant', text: result.reply, time, provider: ai.assistant.provider, model: ai.assistant.model, scope }
  let body = `**AI’s final answer** (${((Date.now() - started) / 1000).toFixed(0)} s):\n\n${result.reply.split('\n').map((l) => `> ${l}`).join('\n')}\n`
  if (result.proposal) {
    const list = result.proposal.edits.map((e, i) => `${i + 1}. ${describeEdit(e, project)}`).join('\n')
    body += `\n**Proposed:** ${result.proposal.summary}\n\n${list}\n`
    aiTurn.proposal = result.proposal
    aiTurn.picked = result.proposal.edits.map(() => true)
    if (process.argv.includes('--apply')) {
      const { after } = compileEdits(project, result.proposal.edits, { scope })
      await saveProject(projectPath, after)
      aiTurn.state = 'applied'
      body += `\n✅ **Applied** all ${result.proposal.edits.length} edits and saved the project (one undo step in the app).`
    } else aiTurn.state = 'pending'
  } else body += '\nNo edits were proposed.'
  await log.write(body)

  await writeFile(historyFile, JSON.stringify({ version: 1, turns: [...turns, userTurn, ...refinedTurn, aiTurn] }, null, 2))
  await mkdir(join(projectPath, 'logs'), { recursive: true })
  await writeFile(join(projectPath, 'logs', `ask-${String(n).padStart(2, '0')}.json`), JSON.stringify({ prompt, result, events: raw }, null, 2))
  console.log(`ASK done: ${result.proposal ? `${result.proposal.edits.length} edits` : 'no edits'}`)
}
