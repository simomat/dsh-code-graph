/**
 * The settings card's own state: a staged form over the `code-graph` namespace,
 * projected into a store the component reads through its selector hook.
 */
import {
  createSnapshotStore,
  type SettingsScope,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { CodeGraphConfig } from '../config.ts'
import { familiesField, listField, numberField, textField } from './settings-fields.ts'
import { type CardActions, type CardState, SettingsForm } from './settings-form.ts'

/** The business face this card injects into its slot entry. */
export interface CodeGraphCardFace extends CardActions {
  /** Bare observable sources; the renderer binds each into a `use<Name>` hook. */
  hooks: { codeGraphCard: SnapshotStore<CardState> }
}

/** Field order on the card, which is also the order a save writes in. */
export const CARD_FIELDS = [
  'defaultBudget',
  'maxBudget',
  'exclude',
  'maxFileBytes',
  'languages',
  'indexDir',
] as const

/** Owns the staged form and the store the card renders from. */
export class CodeGraphCardController {
  private readonly form: SettingsForm<CodeGraphConfig>
  private readonly store: SnapshotStore<CardState>

  constructor(scope: SettingsScope<CodeGraphConfig>) {
    this.form = new SettingsForm(scope, [
      numberField('defaultBudget'),
      numberField('maxBudget'),
      listField('exclude'),
      numberField('maxFileBytes'),
      familiesField('languages'),
      textField('indexDir'),
    ])
    this.store = createSnapshotStore(this.form.state())
  }

  /**
   * Start following the scope.
   * @returns The disposer, for the caller's effect.
   */
  start(): () => void {
    return this.form.bind(this.store)
  }

  /** The face the slot registration injects. */
  inject(): CodeGraphCardFace {
    return { hooks: { codeGraphCard: this.store }, ...this.form.actions() }
  }
}
