/**
 * The staged settings form, with no browser in it.
 *
 * The settings card is only as good as the model behind it: what a save would
 * write, what a discard throws away, and what a read-only host does to both.
 * The rendered surface itself cannot be reached from this suite.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { familiesField, listField, numberField, textField } from '../../src/client/settings-fields.ts'
import { boundForm, fakeScope } from '../helpers/fakes.mjs'

describe('field specs', () => {
  it('reads a whole number and clears on empty', () => {
    const spec = numberField('n')
    assert.deepEqual(spec.parse('42'), { kind: 'set', value: 42 })
    assert.deepEqual(spec.parse('  '), { kind: 'clear' })
    assert.equal(spec.parse('4.5'), undefined)
    assert.equal(spec.parse('-1'), undefined)
    assert.equal(spec.parse('lots'), undefined)
    assert.equal(spec.format(42), '42')
    assert.equal(spec.format(undefined), '')
  })

  it('splits a list on commas and newlines', () => {
    const spec = listField('exclude')
    assert.deepEqual(spec.parse('generated, vendor/lib\n  fixtures '),
      { kind: 'set', value: ['generated', 'vendor/lib', 'fixtures'] })
    assert.deepEqual(spec.parse(' , '), { kind: 'clear' })
    assert.equal(spec.format(['a', 'b']), 'a, b')
  })

  it('refuses a language family it does not know', () => {
    const spec = familiesField('languages')
    assert.deepEqual(spec.parse('typescript, go'), { kind: 'set', value: ['typescript', 'go'] })
    assert.equal(spec.parse('typescript, cobol'), undefined)
    assert.deepEqual(spec.parse(''), { kind: 'clear' })
  })

  it('trims free text and clears on empty', () => {
    const spec = textField('indexDir')
    assert.deepEqual(spec.parse('  /var/idx '), { kind: 'set', value: '/var/idx' })
    assert.deepEqual(spec.parse(''), { kind: 'clear' })
  })
})

describe('staged form', () => {
  it('shows the stored value until something is typed', () => {
    const { form } = boundForm(fakeScope({ base: { defaultBudget: 1500, exclude: [] } }))
    assert.equal(form.state().fields['defaultBudget'].text, '1500')
    assert.equal(form.state().dirty, false)
    assert.equal(form.state().fields['defaultBudget'].overridden, false)
  })

  it('marks a field overridden from the user layer, not from its value', () => {
    const { form } = boundForm(fakeScope({
      base: { defaultBudget: 1500 },
      user: { defaultBudget: 1500 },
    }))
    assert.equal(form.state().fields['defaultBudget'].overridden, true)
  })

  it('stages an edit without writing', () => {
    const scope = fakeScope({ base: { defaultBudget: 1500 } })
    const { form, actions } = boundForm(scope)
    actions.edit('defaultBudget', '900')
    assert.equal(form.state().fields['defaultBudget'].text, '900')
    assert.equal(form.state().dirty, true)
    assert.deepEqual(scope.writes, [])
  })

  it('writes every staged field on save and clears the drafts', async () => {
    const scope = fakeScope({ base: { defaultBudget: 1500, exclude: [] } })
    const { form, actions } = boundForm(scope)
    actions.edit('defaultBudget', '900')
    actions.edit('exclude', 'generated')
    actions.save()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(scope.writes, [
      { field: 'defaultBudget', value: 900 },
      { field: 'exclude', value: ['generated'] },
    ])
    assert.equal(form.state().dirty, false)
    assert.equal(form.state().failed, false)
  })

  it('blocks the save entirely while one draft cannot be read', async () => {
    const scope = fakeScope({ base: { defaultBudget: 1500, exclude: [] } })
    const { form, actions } = boundForm(scope)
    actions.edit('exclude', 'generated')
    actions.edit('defaultBudget', 'lots')
    assert.equal(form.state().invalid, true)
    actions.save()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(scope.writes, [], 'a partial save would half-apply one edit')
    assert.equal(form.state().dirty, true)
  })

  it('keeps the drafts and reports failure when a write does not land', async () => {
    const scope = fakeScope({ base: { defaultBudget: 1500 }, reject: true })
    const { form, actions } = boundForm(scope)
    actions.edit('defaultBudget', '900')
    actions.save()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(form.state().failed, true)
    assert.equal(form.state().dirty, true, 'the user keeps what they typed')
  })

  it('stages a reset as the composed value and writes it as a clear', async () => {
    const scope = fakeScope({ base: { defaultBudget: 1500 }, user: { defaultBudget: 900 } })
    const { form, actions } = boundForm(scope)
    actions.resetField('defaultBudget')
    assert.equal(form.state().fields['defaultBudget'].text, '1500')
    assert.equal(form.state().fields['defaultBudget'].overridden, false, 'the reset previews the save')
    actions.save()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(scope.writes, [{ field: 'defaultBudget', clear: true }])
  })

  it('drops every draft on discard', () => {
    const { form, actions } = boundForm(fakeScope({ base: { defaultBudget: 1500 } }))
    actions.edit('defaultBudget', '900')
    actions.discard()
    assert.equal(form.state().dirty, false)
    assert.equal(form.state().fields['defaultBudget'].text, '1500')
  })

  it('reports a section it cannot edit', () => {
    const loading = boundForm(fakeScope({ status: 'loading' }))
    assert.equal(loading.form.state().available, false)
    const readonly = boundForm(fakeScope({ writable: false }))
    assert.equal(readonly.form.state().writable, false)
  })
})
