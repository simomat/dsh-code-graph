/**
 * Staged editing for one settings namespace.
 *
 * Every settings write is a durable, revision-fenced document mutation, so a
 * control that wrote as it settled would turn one edit into a write nobody
 * asked for and could not preview. This model stages what the user types and
 * writes only on save.
 *
 * The equivalent model inside the harness belongs to another plugin's package,
 * and a browser bundle may not import another plugin's code as a value — so
 * this is a deliberate reimplementation, not a copy waiting to be deduplicated.
 * Fencing, ordering and recovery are NOT reimplemented: those live in the
 * settings scope this form writes through.
 */
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** What saving one field would do to the document. */
export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** How one field converts between the document and the text a control shows. */
export interface FieldSpec {
  /** Top-level field name inside the section. */
  field: string
  /** Render a stored value as editable text. */
  format: (value: unknown) => string
  /** Read a draft back, or undefined when it is not a value this field accepts. */
  parse: (text: string) => FieldWrite | undefined
}

/** One field as a control should draw it. */
export interface FieldState {
  /** The text on screen: the staged draft, or the stored value formatted. */
  text: string
  /** Whether saving would leave this field set in the user layer. */
  overridden: boolean
  /** Whether the current draft blocks the save. */
  invalid: boolean
}

/** The card as a whole. */
export interface CardState {
  /** Whether a section has been read and can be edited. */
  available: boolean
  /** Whether the document accepts writes at all. */
  writable: boolean
  /** Whether anything is staged. */
  dirty: boolean
  /** Whether some draft cannot be parsed, which blocks the save. */
  invalid: boolean
  /** Whether a save is in flight. */
  saving: boolean
  /** Whether the last save did not land. */
  failed: boolean
  /** Per-field state, keyed by field name. */
  fields: Record<string, FieldState>
}

/** What a card's controls call. */
export interface CardActions {
  /** Stage new text for one field. */
  edit: (field: string, text: string) => void
  /** Stage a reset back to the composed value. */
  resetField: (field: string) => void
  /** Write every staged field, in order. */
  save: () => void
  /** Drop every draft. */
  discard: () => void
}

/** One staged edit. */
interface Draft {
  text: string
  /** True when the draft means "clear this field", not "store this text". */
  clear: boolean
}

/** Read one property off a layer that may be anything at all. */
function layerField(layer: unknown, field: string): unknown {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return undefined
  return (layer as Record<string, unknown>)[field]
}

/** Whether a layer carries the key at all — presence, not value, marks an override. */
function layerHas(layer: unknown, field: string): boolean {
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) return false
  return Object.hasOwn(layer as Record<string, unknown>, field)
}

/** The staged form over one namespace. */
export class SettingsForm<T> {
  private readonly scope: SettingsScope<T>
  private readonly specs: Map<string, FieldSpec>
  private readonly staged = new Map<string, Draft>()
  private store: SnapshotStore<CardState> | undefined
  private saving = false
  private failed = false

  constructor(scope: SettingsScope<T>, specs: readonly FieldSpec[]) {
    this.scope = scope
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
  }

  /**
   * Publish this form into a store the card reads.
   * @param store - the store to keep in step with scope and drafts.
   * @returns The disposer removing the scope subscription.
   */
  bind(store: SnapshotStore<CardState>): () => void {
    this.store = store
    this.publish()
    return this.scope.subscribe(() => { this.publish() })
  }

  /** The actions a card's controls call. */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      // A reset stages the composed value rather than writing it, so the user
      // sees what saving would do and can still change their mind.
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.composed(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /** The current projection, for tests and for the initial store value. */
  state(): CardState {
    const snapshot = this.scope.getSnapshot()
    const fields: Record<string, FieldState> = {}
    let invalid = false
    for (const [name, spec] of this.specs) {
      const draft = this.staged.get(name)
      const stored = this.stored(snapshot, name)
      const text = draft?.text ?? spec.format(stored)
      const bad = draft !== undefined && !draft.clear && spec.parse(draft.text) === undefined
      if (bad) invalid = true
      fields[name] = {
        text,
        // Previews the save rather than reporting the document: a staged clear
        // reads as no longer overridden the moment it is staged.
        overridden: draft?.clear === true ? false : draft !== undefined || layerHas(snapshot.user, name),
        invalid: bad,
      }
    }
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      invalid,
      saving: this.saving,
      failed: this.failed,
      fields,
    }
  }

  private spec(field: string): FieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`code-graph: no settings field named ${field}`)
    return spec
  }

  private stored(snapshot: SettingsScopeSnapshot<T>, field: string): unknown {
    return layerField(snapshot.value, field)
  }

  /** What a field reverts to once its override is cleared. */
  private composed(field: string): unknown {
    return layerField(this.scope.getSnapshot().base, field)
  }

  private stage(field: string, draft: Draft): void {
    this.spec(field)
    this.staged.set(field, draft)
    this.failed = false
    this.publish()
  }

  private publish(): void {
    this.store?.set(this.state())
  }

  /**
   * Write every staged field.
   *
   * The Host is the authority on whether a value was accepted — its `validate`
   * owns the constraints the schema cannot express — so each write is read back
   * rather than assumed, and drafts survive a save that did not land so the
   * user can correct them.
   */
  private async save(): Promise<void> {
    if (this.saving || this.staged.size === 0) return
    const plan: Array<{ field: string; write: FieldWrite }> = []
    for (const [field, draft] of this.staged) {
      if (draft.clear) {
        plan.push({ field, write: { kind: 'clear' } })
        continue
      }
      const write = this.spec(field).parse(draft.text)
      // One unparseable draft blocks the whole save: writing the rest would
      // half-apply an edit the user made as a unit.
      if (write === undefined) return
      plan.push({ field, write })
    }

    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const { field, write } of plan) {
      landed = await this.commit(field, write) && landed
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /** Perform one write and report whether the document now agrees. */
  private async commit(field: string, write: FieldWrite): Promise<boolean> {
    try {
      if (write.kind === 'clear') {
        await this.scope.unset(field)
        return !layerHas(this.scope.getSnapshot().user, field)
      }
      await this.scope.set(field, write.value)
      return layerHas(this.scope.getSnapshot().user, field)
    } catch {
      // A rejected write is a failed save, not a crash: the scope has already
      // reloaded Host state, and the drafts stay for the user to correct.
      return false
    }
  }
}
