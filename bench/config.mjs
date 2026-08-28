/**
 * Everything a run is allowed to vary, in one place.
 *
 * Reference repositories are pinned to release tags rather than to a branch
 * head, so a pin is an artifact somebody can look up rather than whatever `main`
 * happened to be. `express` and `gin` are deliberately shared with the reference
 * project's own benchmark set, so the two projects' numbers can be put side by
 * side; the rest cover the four languages this plugin supports.
 *
 * Each `sha` is the **commit** a tag points at, peeled where the tag is an
 * annotated one (`git rev-parse <tag>^{commit}`). Pinning the tag object instead
 * makes `prepareRepo`'s post-checkout verification fail, which is the guard
 * working: `git checkout` resolves the tag to its commit and the two disagree.
 *
 * Questions are fixed and hand-written per repository, naming symbols that
 * actually exist in the pinned tree. There is no randomness anywhere in a run.
 */

/** Reference repositories, pinned. */
export const REPOS = [
  {
    name: 'express',
    url: 'https://github.com/expressjs/express.git',
    tag: 'v5.2.1',
    sha: 'dbac741a49a5a64336b70c06e85c2e2706e36336',
    lang: 'javascript',
  },
  {
    name: 'hono',
    url: 'https://github.com/honojs/hono.git',
    tag: 'v4.13.5',
    sha: '06880c4a2b04de9dd74217f26dd831209b9c01f1',
    lang: 'typescript',
  },
  {
    name: 'gin',
    url: 'https://github.com/gin-gonic/gin.git',
    tag: 'v1.10.1',
    sha: 'b5af7796535d97d9c7af42539af01d787fcb3b4d',
    lang: 'go',
  },
  {
    name: 'gson',
    url: 'https://github.com/google/gson.git',
    tag: 'gson-parent-2.14.0',
    sha: '3ff35d6269894901ab8006258395aafc4b9765cd',
    lang: 'java',
  },
  {
    name: 'ripgrep',
    url: 'https://github.com/BurntSushi/ripgrep.git',
    tag: '14.1.1',
    sha: '4649aa9700619f94cf9c66876e9549d83420e16c',
    lang: 'rust',
  },
  {
    // Cloned from this working copy rather than measured in place, so the tree
    // under test is clean even when the developer's is not. The commit is
    // whatever is committed here, and it is recorded in the run manifest.
    name: 'self',
    self: true,
    lang: 'typescript',
  },
]

/**
 * The budgets every scenario runs at.
 *
 * Two, always. `graph_tokens` is bounded by configuration as much as by what the
 * graph found, so a single-budget table would be reporting the setting as if it
 * were a finding.
 */
export const BUDGETS = [
  { name: 'default', limit: 1500 },
  { name: 'max', limit: 6000 },
]

/**
 * Words dropped when deriving search terms from a question.
 *
 * Committed rather than computed: the agent baseline has to be reproducible, and
 * a stopword list that drifted would move every baseline number with it.
 *
 * It includes question-framing verbs — `defined`, `calls`, `handles`, `uses` —
 * and not only English function words, and that choice runs *against* this
 * plugin's interest. Left in, they are high-frequency noise: the top-ranked
 * files become whichever large files say "defined" most often, which inflates
 * the baseline and so the ratio. Dropping them models a competent agent that
 * greps for the identifier it wants, which is the harder comparison to win.
 *
 * The cost is that a few of these words are also real identifiers (express has a
 * `router.handle`). A question genuinely about one of those carries an explicit
 * `terms` array instead, which is committed data and so just as reproducible.
 */
export const STOPWORDS = new Set([
  'about', 'after', 'all', 'and', 'any', 'are', 'back', 'been', 'before', 'being', 'both', 'but',
  'call', 'called', 'calls', 'can', 'code', 'come', 'could', 'defined', 'define', 'defines', 'did',
  'does', 'doing', 'done', 'each', 'file', 'files', 'find', 'for', 'from', 'get', 'gets', 'give',
  'goes', 'going', 'handle', 'handled', 'handles', 'has', 'have', 'her', 'here', 'him', 'his', 'how',
  'implemented', 'implements', 'into', 'its', 'just', 'like', 'made', 'make', 'makes', 'many', 'may',
  'much', 'must', 'need', 'needs', 'not', 'now', 'off', 'one', 'only', 'other', 'our', 'out', 'over',
  'own', 'part', 'per', 'put', 'same', 'see', 'set', 'she', 'should', 'show', 'shows', 'some', 'such',
  'take', 'takes', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'too', 'top', 'two', 'under', 'until', 'upon', 'use', 'used', 'uses', 'using',
  'very', 'via', 'want', 'was', 'way', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'why', 'will', 'with', 'within', 'would', 'you', 'your',
])

/** Shortest token kept when deriving search terms. */
export const MIN_TERM_LENGTH = 3

/**
 * The reference MCP server measured in `tool-schema-overhead`.
 *
 * Pinned so the 30-tool figure is reproducible; the committed snapshot under
 * `bench/fixtures/` is what a run without `uvx` (and every CI run) reads.
 */
export const REFERENCE = {
  package: 'code-review-graph',
  version: '2.3.7',
  command: 'uvx',
}

/** Every scenario, in run order. */
export const SCENARIOS = [
  'corpus-baseline',
  'agent-baseline',
  'workflow-cost',
  'tool-schema-overhead',
  'index-profile',
]
