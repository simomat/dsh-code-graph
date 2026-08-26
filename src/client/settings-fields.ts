/**
 * The six fields of the `code-graph` section, as controls edit them.
 *
 * Every field is staged as text, including the two that are not textual: a
 * checkbox group edits the same joined string the parser reads back. One
 * staging representation keeps save, discard, reset and the invalid-blocks-save
 * rule identical for every control, which is worth more than a bespoke draft
 * type per field.
 */
import { LANG_FAMILIES, type LangFamily } from '../config.ts'
import type { FieldSpec } from './settings-form.ts'

/** Split a user-typed list on commas and newlines, dropping blanks. */
function splitList(text: string): string[] {
  return text.split(/[\n,]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/**
 * A whole-number field. An empty draft clears the override.
 * @param field - the section field name.
 * @returns Its spec.
 */
export function numberField(field: string): FieldSpec {
  return {
    field,
    format: (value) => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return { kind: 'clear' }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return undefined
      return { kind: 'set', value: parsed }
    },
  }
}

/**
 * A free-text field. An empty draft clears the override.
 * @param field - the section field name.
 * @returns Its spec.
 */
export function textField(field: string): FieldSpec {
  return {
    field,
    format: (value) => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed.length === 0 ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/**
 * A list field. An empty draft clears the override rather than storing `[]`:
 * "I typed nothing" and "I want none" are the same gesture in a text control,
 * and re-inheriting is the recoverable reading of the two.
 * @param field - the section field name.
 * @returns Its spec.
 */
export function listField(field: string): FieldSpec {
  return {
    field,
    format: (value) => Array.isArray(value) ? value.join(', ') : '',
    parse: (text) => {
      const entries = splitList(text)
      return entries.length === 0 ? { kind: 'clear' } : { kind: 'set', value: entries }
    },
  }
}

/**
 * The language-family field. An unknown family is refused rather than dropped:
 * silently ignoring it would leave a user staring at a name that does nothing.
 * @param field - the section field name.
 * @returns Its spec.
 */
export function familiesField(field: string): FieldSpec {
  const known = new Set<string>(LANG_FAMILIES)
  return {
    field,
    format: (value) => Array.isArray(value) ? value.join(', ') : '',
    parse: (text) => {
      const entries = splitList(text)
      if (entries.length === 0) return { kind: 'clear' }
      if (entries.some((entry) => !known.has(entry))) return undefined
      return { kind: 'set', value: entries as LangFamily[] }
    },
  }
}
