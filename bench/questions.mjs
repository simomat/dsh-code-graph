/**
 * The fixed question set, and the workflows.
 *
 * Hand-written per repository against the pinned tree, so every symbol named
 * here exists at the pinned SHA. They are the whole input to `corpus-baseline`
 * and `agent-baseline`: change one and every number for that repository moves,
 * which is why they live in committed data rather than being generated.
 *
 * Each question names the single tool call a graph-backed agent would make to
 * answer it. That is the comparison being drawn — one structured call against
 * the grep-and-read loop for the same question — so a question whose graph
 * answer needs three calls belongs in `workflows` instead.
 *
 * A `terms` override replaces the derived search terms where the derivation
 * would drop the very identifier the question is about (`bench/config.mjs`
 * explains why `handle` and friends are stopwords). Overrides are data, so the
 * agent baseline stays as reproducible as the derivation it replaces.
 */

/** Questions per repository, keyed by repo name. */
export const QUESTIONS = {
  express: [
    { id: 'express-etag', text: 'Where is createETagGenerator defined?', tool: 'code_find', args: { query: 'createETagGenerator' } },
    { id: 'express-view', text: 'Where is the View constructor and what is its signature?', tool: 'code_find', args: { query: 'View' } },
    { id: 'express-route-rel', text: 'What are all the relations of Route?', tool: 'code_relations', args: { symbol: 'Route' } },
    { id: 'express-utils-impact', text: 'What would a change to lib/utils.js affect?', tool: 'code_impact', args: { paths: ['lib/utils.js'] } },
    { id: 'express-layout', text: 'What is the module layout of this repository?', tool: 'code_overview', args: {} },
  ],
  hono: [
    { id: 'hono-trie', text: 'Where is TrieRouter defined?', tool: 'code_find', args: { query: 'TrieRouter' } },
    { id: 'hono-exception-rel', text: 'What are all the relations of HTTPException?', tool: 'code_relations', args: { symbol: 'HTTPException' } },
    { id: 'hono-validator', text: 'Where is the validator middleware defined?', tool: 'code_find', args: { query: 'validator' } },
    { id: 'hono-context-impact', text: 'What would a change to src/context.ts affect?', tool: 'code_impact', args: { paths: ['src/context.ts'] } },
    { id: 'hono-layout', text: 'What is the module layout of this repository?', tool: 'code_overview', args: {} },
  ],
  gin: [
    { id: 'gin-routergroup', text: 'Where is RouterGroup defined?', tool: 'code_find', args: { query: 'RouterGroup' } },
    { id: 'gin-setmode-rel', text: 'What are all the relations of SetMode?', tool: 'code_relations', args: { symbol: 'SetMode' } },
    { id: 'gin-handlerschain', text: 'Where is the HandlersChain type declared?', tool: 'code_find', args: { query: 'HandlersChain' } },
    { id: 'gin-routergroup-impact', text: 'What would a change to routergroup.go affect?', tool: 'code_impact', args: { paths: ['routergroup.go'] } },
    { id: 'gin-layout', text: 'What is the module layout of this repository?', tool: 'code_overview', args: {} },
  ],
  gson: [
    { id: 'gson-typetoken', text: 'Where is TypeToken defined?', tool: 'code_find', args: { query: 'TypeToken' } },
    {
      id: 'gson-builder-rel',
      text: 'What are all the relations of GsonBuilder?',
      tool: 'code_relations',
      args: { symbol: 'gson/src/main/java/com/google/gson/GsonBuilder.java::GsonBuilder' },
      terms: ['gsonbuilder'],
    },
    { id: 'gson-jsonwriter', text: 'Where is JsonWriter declared and what is its signature?', tool: 'code_find', args: { query: 'JsonWriter' } },
    {
      id: 'gson-typetoken-impact',
      text: 'What would a change to the TypeToken source file affect?',
      tool: 'code_impact',
      args: { paths: ['gson/src/main/java/com/google/gson/reflect/TypeToken.java'] },
      terms: ['typetoken'],
    },
    { id: 'gson-layout', text: 'What is the module layout of this repository?', tool: 'code_overview', args: {} },
  ],
  ripgrep: [
    { id: 'ripgrep-searcher', text: 'Where is Searcher defined?', tool: 'code_find', args: { query: 'Searcher' } },
    { id: 'ripgrep-linebuffer-rel', text: 'What are all the relations of LineBuffer?', tool: 'code_relations', args: { symbol: 'LineBuffer' } },
    { id: 'ripgrep-standardbuilder', text: 'Where is StandardBuilder and what is its signature?', tool: 'code_find', args: { query: 'StandardBuilder' } },
    {
      id: 'ripgrep-linebuffer-impact',
      text: 'What would a change to crates/searcher/src/line_buffer.rs affect?',
      tool: 'code_impact',
      args: { paths: ['crates/searcher/src/line_buffer.rs'] },
    },
    { id: 'ripgrep-layout', text: 'What is the module layout of this repository?', tool: 'code_overview', args: {} },
  ],
  self: [
    { id: 'self-findsymbols', text: 'Where is findSymbols defined?', tool: 'code_find', args: { query: 'findSymbols' } },
    { id: 'self-fitrows-rel', text: 'What are all the relations of fitRows?', tool: 'code_relations', args: { symbol: 'fitRows' } },
    { id: 'self-computeimpact', text: 'Where is computeImpact and what is its signature?', tool: 'code_find', args: { query: 'computeImpact' } },
    { id: 'self-budget-impact', text: 'What would a change to src/query/budget.ts affect?', tool: 'code_impact', args: { paths: ['src/query/budget.ts'] } },
    { id: 'self-layout', text: 'What is the module layout of this repository?', tool: 'code_overview', args: {} },
  ],
}

/**
 * Multi-call workflows for `workflow-cost`, keyed by repo name.
 *
 * Absolute cost, no baseline: what a realistic sequence of tool calls actually
 * costs a session end to end. The shape is the one the plugin's own
 * `code_overview` result recommends in its `next` field — orient, locate,
 * inspect, then scope the blast radius — so it is the sequence a model
 * following the tools' own advice would produce.
 */
export const WORKFLOWS = {
  express: [{
    id: 'express-locate-and-scope',
    text: 'Where is createETagGenerator defined, who calls it, and what would changing its file affect?',
    steps: [
      { tool: 'code_overview', args: {} },
      { tool: 'code_find', args: { query: 'createETagGenerator' } },
      { tool: 'code_relations', args: { symbol: 'createETagGenerator' } },
      { tool: 'code_impact', args: { paths: ['lib/utils.js'] } },
    ],
  }],
  hono: [{
    id: 'hono-locate-and-scope',
    text: 'Where is TrieRouter defined, who calls it, and what would changing its file affect?',
    steps: [
      { tool: 'code_overview', args: {} },
      { tool: 'code_find', args: { query: 'TrieRouter' } },
      { tool: 'code_relations', args: { symbol: 'TrieRouter' } },
      { tool: 'code_impact', args: { paths: ['src/router/trie-router/router.ts'] } },
    ],
  }],
  gin: [{
    id: 'gin-locate-and-scope',
    text: 'Where is RouterGroup defined, who calls it, and what would changing its file affect?',
    steps: [
      { tool: 'code_overview', args: {} },
      { tool: 'code_find', args: { query: 'RouterGroup' } },
      { tool: 'code_relations', args: { symbol: 'RouterGroup' } },
      { tool: 'code_impact', args: { paths: ['routergroup.go'] } },
    ],
  }],
  gson: [{
    id: 'gson-locate-and-scope',
    text: 'Where is TypeToken defined, who calls it, and what would changing its file affect?',
    steps: [
      { tool: 'code_overview', args: {} },
      { tool: 'code_find', args: { query: 'TypeToken' } },
      { tool: 'code_relations', args: { symbol: 'gson/src/main/java/com/google/gson/reflect/TypeToken.java::TypeToken' } },
      { tool: 'code_impact', args: { paths: ['gson/src/main/java/com/google/gson/reflect/TypeToken.java'] } },
    ],
  }],
  ripgrep: [{
    id: 'ripgrep-locate-and-scope',
    text: 'Where is LineBuffer defined, who calls it, and what would changing its file affect?',
    steps: [
      { tool: 'code_overview', args: {} },
      { tool: 'code_find', args: { query: 'LineBuffer' } },
      { tool: 'code_relations', args: { symbol: 'LineBuffer' } },
      { tool: 'code_impact', args: { paths: ['crates/searcher/src/line_buffer.rs'] } },
    ],
  }],
  self: [{
    id: 'self-locate-and-scope',
    text: 'Where is fitRows defined, who calls it, and what would changing its file affect?',
    steps: [
      { tool: 'code_overview', args: {} },
      { tool: 'code_find', args: { query: 'fitRows' } },
      { tool: 'code_relations', args: { symbol: 'fitRows' } },
      { tool: 'code_impact', args: { paths: ['src/query/budget.ts'] } },
    ],
  }],
}
