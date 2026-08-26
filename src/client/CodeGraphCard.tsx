/**
 * The plugin's card on the web settings page.
 *
 * The card owns everything inside it — chrome, controls and copy — because the
 * section that hosts it supplies only the seat. Copy is plain English: the
 * localized `t` seat needs a namespace merged into the harness's own table, and
 * a bare key rendered on screen would be worse than an untranslated sentence.
 */
import { useState } from 'react'
import { Button, DisclosureRow, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the keyed slot's declaration. A value import of another plugin
// would either duplicate its runtime or ask the loader for a specifier it
// cannot answer.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { LANG_FAMILIES } from '../config.ts'
import type { CodeGraphCardFace } from './settings-controller.ts'
import type { FieldState } from './settings-form.ts'

/** Everything the renderer composes for this entry. */
export type CodeGraphCardProps =
  PropsRuntime<'settings.plugin.item'> & InjectFace<CodeGraphCardFace>

/** One field's label and the sentence explaining what it costs. */
const COPY: Record<string, { label: string; hint: string }> = {
  defaultBudget: {
    label: 'Default token budget',
    hint: 'Budget for a tool result that does not ask for one.',
  },
  maxBudget: {
    label: 'Maximum token budget',
    hint: 'Largest budget a single call may request.',
  },
  exclude: {
    label: 'Excluded paths',
    hint: 'Added to the built-in list. A bare name matches any directory; a name '
      + 'with a slash is a path from the repository root. Comma-separated.',
  },
  maxFileBytes: {
    label: 'Maximum file size (bytes)',
    hint: 'Files above this are skipped as generated rather than authored.',
  },
  languages: {
    label: 'Languages',
    hint: 'A family left off is never parsed and its grammar is never loaded.',
  },
  indexDir: {
    label: 'Index directory',
    hint: 'Where the index databases live. Empty means the harness home.',
  },
}

/** Fields drawn as a plain text input, in card order. */
const TEXT_FIELDS = ['defaultBudget', 'maxBudget', 'exclude', 'maxFileBytes'] as const

const row = { display: 'flex', flexDirection: 'column' as const, gap: '4px', padding: '8px 0' }
const hint = { fontSize: '12px', opacity: 0.7 }
const label = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }

/**
 * Render one labelled control plus its override marker.
 * @param props - the field's state and the actions its controls call.
 * @returns The field block.
 */
function Field(props: {
  name: string
  state: FieldState
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const copy = COPY[props.name]
  return (
    <div style={row}>
      <div style={label}>
        <span>{copy?.label ?? props.name}</span>
        {props.state.overridden
          ? (
              <Button size="sm" variant="ghost" onClick={props.onReset} disabled={props.disabled}>
                Reset
              </Button>
            )
          : null}
      </div>
      {props.children ?? (
        <Input
          value={props.state.text}
          disabled={props.disabled}
          aria-label={copy?.label ?? props.name}
          aria-invalid={props.state.invalid || undefined}
          onChange={(event) => { props.onEdit(event.target.value) }}
        />
      )}
      <span style={hint}>{copy?.hint}</span>
      {props.state.invalid ? <span style={hint}>This value cannot be saved.</span> : null}
    </div>
  )
}

/**
 * Render the code-graph settings card.
 * @param props - composed slot props.
 * @returns The card, or nothing while no section has been read.
 */
export function CodeGraphCard(props: CodeGraphCardProps): React.JSX.Element | null {
  const { useCodeGraphCard, edit, resetField, save, discard } = props
  const state = useCodeGraphCard((s) => s)
  const [open, setOpen] = useState(false)
  if (!state.available) return null

  const disabled = !state.writable || state.saving
  const families = new Set(state.fields['languages']?.text.split(/[\n,]/).map((f) => f.trim()) ?? [])

  return (
    <DisclosureRow
      icon={<span aria-hidden="true" />}
      title="Code graph"
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => { setOpen(!open) }}
      collapsedContent={state.dirty ? <span style={hint}>Unsaved changes</span> : undefined}
    >
      <div>
        <p style={hint}>
          Structural index behind the code_overview, code_find, code_relations and code_impact
          tools. Budgets apply to the next call; the rest rebuilds the index in the background.
        </p>

        {TEXT_FIELDS.map((name) => {
          const field = state.fields[name]
          return field === undefined ? null : (
            <Field
              key={name}
              name={name}
              state={field}
              disabled={disabled}
              onEdit={(text) => { edit(name, text) }}
              onReset={() => { resetField(name) }}
            />
          )
        })}

        {state.fields['languages'] === undefined ? null : (
          <Field
            name="languages"
            state={state.fields['languages']}
            disabled={disabled}
            onEdit={(text) => { edit('languages', text) }}
            onReset={() => { resetField('languages') }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              {LANG_FAMILIES.map((family) => (
                <label key={family} style={label}>
                  <input
                    type="checkbox"
                    checked={families.has(family)}
                    disabled={disabled}
                    onChange={() => {
                      const next = new Set(families)
                      if (next.has(family)) next.delete(family)
                      else next.add(family)
                      edit('languages', LANG_FAMILIES.filter((f) => next.has(f)).join(', '))
                    }}
                  />
                  {family}
                </label>
              ))}
            </div>
          </Field>
        )}

        {state.fields['indexDir'] === undefined ? null : (
          <Field
            name="indexDir"
            state={state.fields['indexDir']}
            disabled={disabled}
            onEdit={(text) => { edit('indexDir', text) }}
            onReset={() => { resetField('indexDir') }}
          />
        )}

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '8px' }}>
          <Button
            variant="primary"
            size="sm"
            disabled={disabled || !state.dirty || state.invalid}
            onClick={save}
          >
            {state.saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" size="sm" disabled={state.saving || !state.dirty} onClick={discard}>
            Discard
          </Button>
          {state.failed ? <span style={hint}>Some changes were not accepted.</span> : null}
          {state.writable ? null : <span style={hint}>Settings are read-only here.</span>}
        </div>
      </div>
    </DisclosureRow>
  )
}
