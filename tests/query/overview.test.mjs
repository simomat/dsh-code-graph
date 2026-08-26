/**
 * `code_overview`'s focus argument is a directory prefix and nothing else.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { overview } from '../../src/query/overview.ts'
import { createFixture } from '../helpers/fixture.mjs'

// ---------------------------------------------------------------------------
// `focus` is a directory prefix and nothing else.
//
// The filter is `focus + '/%'`, so a file path or a symbol name matched no row
// and every total came back 0 under `status: 'ready'` — indistinguishable from
// an empty repository, and silent about the caller's actual mistake.
// ---------------------------------------------------------------------------

describe('overview focus that matches no directory', () => {
  const fx = createFixture('cg-m12-')
  let db

  before(async () => {
    fx.write('src/util.ts', 'export function helper(): number { return 1 }\n')
    fx.write('src/deep/inner.ts', "import { helper } from '../util.ts'\nexport function inner(): number { return helper() }\n")
    db = await fx.build()
  })

  after(() => fx.cleanup())

  it('reports a real directory as ready', () => {
    const result = overview(db, 'src', 1500)
    assert.equal(result.status, 'ready')
    assert.equal(result.totals.files, 2)
  })

  it('reports a file path as empty rather than a zero-filled ready', () => {
    const result = overview(db, 'src/util.ts', 1500)
    assert.equal(result.status, 'empty')
    assert.equal(result.focus, 'src/util.ts')
    assert.deepEqual(result.totals, { files: 0, symbols: 0, edges: 0, tests: 0, callResolution: 0 })
    assert.match(result.next[0], /directory prefix, not a file or symbol/)
  })

  it('reports a symbol name as empty', () => {
    const result = overview(db, 'helper', 1500)
    assert.equal(result.status, 'empty')
    assert.match(result.next[0], /No indexed files under "helper"/)
  })

  it('still reports an unfocused repository as ready', () => {
    const result = overview(db, undefined, 1500)
    assert.equal(result.status, 'ready')
    assert.equal(result.focus, null)
    assert.equal(result.totals.files, 2)
  })
})
