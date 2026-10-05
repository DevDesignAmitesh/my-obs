import { useEffect, useState } from 'react'
import { useStudio } from '../store'

/**
 * A media item's name that turns into a text box on double-click (or when `editing` is set, e.g. by F2).
 * Enter or clicking away saves, Esc cancels. Renaming a media item renames every timeline clip that uses it.
 */
export function RenameField(props: { mediaId: string; name: string; className?: string; editing?: boolean; onDone?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    if (props.editing) setDraft(props.name)
  }, [props.editing])

  const finish = (save: boolean): void => {
    const name = draft?.trim()
    if (save && name && name !== props.name) useStudio.getState().dispatch({ op: 'updateMedia', mediaId: props.mediaId, patch: { name } })
    setDraft(null)
    props.onDone?.()
  }

  if (draft === null) {
    return (
      <div
        className={`truncate ${props.className ?? ''}`}
        title={`${props.name}\nDouble-click to rename`}
        onDoubleClick={(e) => (e.stopPropagation(), setDraft(props.name))}
      >
        {props.name}
      </div>
    )
  }
  return (
    <input
      autoFocus
      className={`w-full min-w-0 rounded bg-panel px-1 outline outline-1 outline-accent ${props.className ?? ''}`}
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation() // keep Backspace, S, Space… out of the editor shortcuts
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
    />
  )
}
