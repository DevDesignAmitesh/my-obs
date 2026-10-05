import { useState } from 'react'
import { MediaBin } from './MediaBin'
import { CreatePanel } from './CreatePanel'
import { TranscriptPanel } from './TranscriptPanel'
import { Inspector } from './Inspector'
import { CaptionsPanel } from './CaptionsPanel'
import { AssistantPanel } from './AssistantPanel'
import { BinPanel } from './BinPanel'
import { useStudio } from '../store'

function Tabs<T extends string>(props: { tabs: [T, string][]; value: T; onChange(v: T): void }) {
  return (
    <div className="flex shrink-0 border-b border-line">
      {props.tabs.map(([v, label]) => (
        <button
          key={v}
          onClick={() => props.onChange(v)}
          className={`flex-1 whitespace-nowrap px-2 py-2 text-sm font-semibold ${props.value === v ? 'border-b-2 border-accent text-text' : 'text-muted hover:text-text'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

type LeftTab = 'media' | 'create' | 'transcript' | 'bin'

export function LeftPanel({ onOpenSettings }: { onOpenSettings(): void }) {
  const [tab, setTab] = useState<LeftTab>(window.studio.dev.mode === 'demo' ? 'transcript' : 'media')
  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-panel">
      <Tabs<LeftTab> tabs={[['media', 'Media'], ['create', '✨ Create'], ['transcript', 'Transcript'], ['bin', '♻ Bin']]} value={tab} onChange={setTab} />
      {tab === 'media' ? (
        <MediaBin />
      ) : tab === 'create' ? (
        <CreatePanel onOpenSettings={onOpenSettings} />
      ) : tab === 'transcript' ? (
        <TranscriptPanel onOpenSettings={onOpenSettings} />
      ) : (
        <BinPanel />
      )}
    </aside>
  )
}

type RightTab = 'clip' | 'captions' | 'ai'

export function RightPanel({ onOpenSettings }: { onOpenSettings(): void }) {
  const tab = useStudio((s) => s.rightTab)
  const setTab = useStudio((s) => s.setRightTab)
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
      <Tabs<RightTab> tabs={[['clip', 'Clip'], ['captions', 'Captions'], ['ai', '✨ AI']]} value={tab} onChange={setTab} />
      {tab === 'ai' ? (
        <AssistantPanel onOpenSettings={onOpenSettings} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">{tab === 'clip' ? <Inspector /> : <CaptionsPanel />}</div>
      )}
    </aside>
  )
}
