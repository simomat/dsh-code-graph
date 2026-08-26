/**
 * Stand-ins for the browser half's collaborators.
 *
 * The settings scope and the snapshot store are both host-provided objects
 * with small, well-defined contracts; reimplementing them in memory is what
 * lets the pure models be tested without a browser.
 */
import { SettingsForm } from '../../src/client/settings-form.ts'
import { listField, numberField } from '../../src/client/settings-fields.ts'

/**
 * A settings scope over an in-memory document, with the same write contract.
 *
 * Records every write on `.writes` so a test can assert what a save *would*
 * have done, and `reject: true` makes every write fail the way a read-only
 * host does.
 */
export function fakeScope({ base = {}, user = {}, writable = true, status = 'ready', reject = false } = {}) {
  let snapshot = {
    status,
    value: { ...base, ...user },
    base,
    user: { ...user },
    revision: 1,
    writable,
    mode: 'host',
  }
  const listeners = new Set()
  const publish = () => {
    snapshot = { ...snapshot, value: { ...base, ...snapshot.user } }
    for (const listener of listeners) listener()
  }
  return {
    writes: [],
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async set(field, value) {
      this.writes.push({ field, value })
      if (reject) throw new Error('refused')
      snapshot.user[field] = value
      publish()
    },
    async unset(field) {
      this.writes.push({ field, clear: true })
      if (reject) throw new Error('refused')
      delete snapshot.user[field]
      publish()
    },
  }
}

/** A snapshot store with the shape the form publishes into. */
export function fakeStore(initial) {
  let state = initial
  return { getSnapshot: () => state, subscribe: () => () => {}, set: (next) => { state = next }, update: () => {} }
}

/**
 * A form already bound to a store, over one numeric and one list field —
 * enough shape for every staging, save, and discard path.
 */
export function boundForm(scope, fields = [numberField('defaultBudget'), listField('exclude')]) {
  const form = new SettingsForm(scope, fields)
  const store = fakeStore(form.state())
  form.bind(store)
  return { form, store, actions: form.actions() }
}
