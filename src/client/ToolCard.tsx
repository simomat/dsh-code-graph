/**
 * The conversation row for a graph tool call.
 *
 * One component serves all four tools: what differs between them is the subject
 * in the title, and everything the row exists to show — is the index built, how
 * far along, how current — is the same question in each. The row deliberately
 * says nothing about the result body; the generic card's own summary already
 * covers that, and repeating it would make a busy transcript busier.
 *
 * It shows a snapshot, not a live build. The block is frozen at the moment the
 * call settled, and there is no progress event to follow, so a row that said
 * "42%" while the number stood still would be lying about being live.
 */
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { type ToolCard as ToolCardModel, toolCard } from './tool-card-model.ts'

const wrap = { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px' }
const dim = { opacity: 0.7 }

/** Map the call and index state onto the shared status-dot vocabulary. */
function dotState(card: ToolCardModel): 'ok' | 'error' | 'pending' | 'idle' {
  if (card.state === 'running') return 'pending'
  if (card.state === 'error') return 'error'
  if (card.state === 'stopped') return 'idle'
  return card.index === 'building' || card.index === 'unavailable' ? 'pending' : 'ok'
}

/** How long ago the index was built, in words a person reads at a glance. */
function age(builtAt: number | null): string | null {
  if (builtAt === null) return null
  const minutes = Math.floor((Date.now() - builtAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** The sentence describing what the index did for this call. */
function indexLine(card: ToolCardModel): string | null {
  if (card.index === 'building') {
    const progress = card.progress
    return progress === undefined || progress.total === 0
      ? 'index building'
      : `index building — ${progress.phase} ${progress.parsed}/${progress.total}`
  }
  if (card.index === 'unavailable') return 'no index for this workspace'
  if (card.freshness === undefined) return null
  const parts: string[] = []
  const built = age(card.freshness.builtAt)
  if (built !== null) parts.push(`indexed ${built}`)
  if (card.index === 'stale') parts.push('refreshing')
  if (card.freshness.dirtyFiles > 0) parts.push(`${card.freshness.dirtyFiles} changed`)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** The repository summary `code_overview` carries and the others do not. */
function totalsLine(card: ToolCardModel): string | null {
  const totals = card.totals
  if (totals === undefined) return null
  const languages = (card.languages ?? []).map((entry) => entry.lang).join(', ')
  const size = `${totals.files} files · ${totals.symbols} symbols · ${totals.edges} edges`
  return languages.length === 0 ? size : `${size} · ${languages}`
}

/**
 * Render one graph tool call.
 * @param props - composed slot props.
 * @returns The row.
 */
export function ToolCard({ block, toolName, inspect }: ToolCallViewProps): React.JSX.Element {
  const card = toolCard(block)
  const index = indexLine(card)
  const totals = totalsLine(card)
  return (
    <div
      style={{ ...wrap, flexDirection: 'column', alignItems: 'stretch' }}
      onDoubleClick={inspect}
    >
      <div style={wrap}>
        <StateDot state={dotState(card)} />
        <span>{toolName}</span>
        {card.subject === null ? null : <span style={dim}>{card.subject}</span>}
        {card.state === 'stopped' ? <span style={dim}>interrupted</span> : null}
        {card.state === 'error' ? <span style={dim}>failed</span> : null}
      </div>
      {index === null ? null : <span style={{ ...dim, paddingLeft: '18px' }}>{index}</span>}
      {totals === null ? null : <span style={{ ...dim, paddingLeft: '18px' }}>{totals}</span>}
    </div>
  )
}
