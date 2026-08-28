/**
 * Counting tokens, and being honest about which kind of token was counted.
 *
 * The default is `chars / 4` — the same heuristic `src/query/budget.ts` budgets
 * against, so a measured result and the budget that shaped it are on one scale.
 * It is an estimate, and every row it produces says so in an `estimated` column
 * rather than leaving a reader to assume a tokenizer ran.
 *
 * `--verify` recounts with a real tokenizer (`gpt-tokenizer`, `cl100k_base`) and
 * emits both columns plus their ratio. Note what that does and does not prove:
 * this plugin targets DeepSeek Harness models, so a cl100k calibration says the
 * `chars / 4` shortcut is sane, not that the absolute number is what a DeepSeek
 * model would bill. Indicative, not model-accurate.
 */

/**
 * The characters a value costs, serialised the way a tool result reaches a model.
 * @param value - a string, or any JSON-serialisable value.
 * @returns Character length; 0 for `undefined`.
 */
export function charsOf(value) {
  if (value === undefined) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.length
}

/**
 * The `chars / 4` estimate.
 *
 * Deliberately identical to `estimateTokens` in `src/query/budget.ts`: the
 * benchmark must not measure on a different scale from the one the budget
 * enforces, or every truncation row would be unreadable.
 * @param value - a string, or any JSON-serialisable value.
 * @returns Estimated tokens.
 */
export function estimateTokens(value) {
  return Math.ceil(charsOf(value) / 4)
}

/**
 * Load the real tokenizer, lazily.
 *
 * A dev dependency the default path never touches: importing it eagerly would
 * make a plain `pnpm run bench` pay for an encoder it does not use.
 * @returns An encode function over `cl100k_base`.
 */
async function loadRealEncoder() {
  const { encode } = await import('gpt-tokenizer/encoding/cl100k_base')
  return encode
}

/**
 * A counter over one run's chosen mode.
 * @param options - `verify` turns on the real tokenizer.
 * @param options.verify - whether to also count with `gpt-tokenizer`.
 * @returns A counter whose `count` reports estimated tokens, and real ones when verifying.
 */
export async function createCounter({ verify = false } = {}) {
  const encode = verify ? await loadRealEncoder() : null

  return {
    verify,
    /**
     * Count one value.
     * @param value - a string, or any JSON-serialisable value.
     * @returns `{ estimated, real, ratio }`; `real` and `ratio` are null unless verifying.
     */
    count(value) {
      const estimated = estimateTokens(value)
      if (!encode) return { estimated, real: null, ratio: null }
      const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value) ?? ''
      const real = text.length === 0 ? 0 : encode(text).length
      return { estimated, real, ratio: ratioOf(estimated, real) }
    },
  }
}

/**
 * The estimate-to-real ratio, guarded against an empty denominator.
 *
 * A zero real count means there was nothing to tokenize, not that the estimate
 * was infinitely wrong — so the ratio is absent rather than `Infinity`.
 * @param estimated - the `chars / 4` figure.
 * @param real - the tokenizer's figure.
 * @returns The ratio rounded to three places, or null when undefined.
 */
export function ratioOf(estimated, real) {
  if (!Number.isFinite(real) || real === 0) return null
  return Math.round((estimated / real) * 1000) / 1000
}
