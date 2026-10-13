import picomatch from 'picomatch'

/** A changed file as returned by the GitHub "list pull request files" endpoint. */
export interface PrFile {
  filename: string
  status: string
  additions: number
  deletions: number
  changes: number
  patch?: string | undefined
  previous_filename?: string | undefined
}

export type FileCategory = 'source' | 'test' | 'config' | 'docs'

export interface KeptFile extends PrFile {
  category: FileCategory
}

export type ExclusionReason = 'path' | 'generated' | 'binary'

export interface FilterResult {
  kept: KeptFile[]
  excluded: { filename: string; reason: ExclusionReason }[]
}

/** Noise that never helps to ask meaningful questions: lockfiles, build output, vendored or minified code. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  // Lockfiles
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/Gemfile.lock',
  '**/composer.lock',
  '**/poetry.lock',
  '**/Pipfile.lock',
  '**/uv.lock',
  '**/pdm.lock',
  '**/go.sum',
  '**/Podfile.lock',
  '**/Package.resolved',
  '**/pubspec.lock',
  '**/mix.lock',
  '**/flake.lock',
  '**/packages.lock.json',
  '**/gradle.lockfile',
  // Build output and dependencies
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/coverage/**',
  '**/node_modules/**',
  '**/vendor/**',
  // Minified, bundled, generated
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.bundle.js',
  '**/*.snap',
  '**/__snapshots__/**',
  '**/*.pb.go',
  '**/*_pb2.py',
  '**/*_pb2_grpc.py',
  '**/*.g.dart',
  '**/*.freezed.dart',
  '**/*.generated.*',
  '**/generated/**',
  '**/__generated__/**'
]

const GENERATED_MARKERS = [
  /@generated\b/,
  /\bCode generated .* DO NOT EDIT\b/i,
  /\bauto-?generated\b.*\b(do not|don't) (edit|modify)\b/i,
  /\bThis file (is|was) (automatically|auto-?) ?generated\b/i
]

/**
 * Splits PR files into the ones worth quizzing on and the ones we ignore.
 * Patterns are evaluated in order (built-in defaults first, then the user's), the last match wins,
 * and a pattern prefixed with "!" re-includes files, like in a .gitignore.
 */
export function filterFiles(
  files: readonly PrFile[],
  userPatterns: readonly string[]
): FilterResult {
  const matchers = [...DEFAULT_EXCLUDES, ...userPatterns].map(pattern => {
    const negated = pattern.startsWith('!')
    const glob = negated ? pattern.slice(1) : pattern
    return { negated, test: picomatch(glob, { dot: true }) }
  })

  const result: FilterResult = { kept: [], excluded: [] }
  for (const file of files) {
    let excluded = false
    for (const matcher of matchers) {
      if (matcher.test(file.filename)) excluded = !matcher.negated
    }
    if (excluded) {
      result.excluded.push({ filename: file.filename, reason: 'path' })
    } else if (isBinary(file)) {
      result.excluded.push({ filename: file.filename, reason: 'binary' })
    } else if (looksGenerated(file.patch)) {
      result.excluded.push({ filename: file.filename, reason: 'generated' })
    } else {
      result.kept.push({ ...file, category: categorize(file.filename) })
    }
  }
  return result
}

/** GitHub omits the patch of binary files; they also report zero changed lines. */
function isBinary(file: PrFile): boolean {
  return !file.patch && file.changes === 0 && file.status !== 'renamed' && file.status !== 'removed'
}

/** Detects the usual "generated, do not edit" banners near the top of the patch. */
export function looksGenerated(patch: string | undefined): boolean {
  if (!patch) return false
  const head = patch.split('\n', 12).join('\n')
  return GENERATED_MARKERS.some(marker => marker.test(head))
}

const TEST_PATTERNS = [
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|testdata|fixtures)\//i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /_test\.(go|py|rb|exs?)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(Test|Tests|Spec)\.(java|kt|swift|cs|scala)$/
]

const DOC_PATTERNS = [
  /\.(md|mdx|rst|adoc|txt)$/i,
  /(^|\/)docs?\//i,
  /(^|\/)(LICENSE|NOTICE|CHANGELOG|AUTHORS)[^/]*$/i
]

const CONFIG_PATTERNS = [
  /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|properties|xml|plist|env(\.\w+)?)$/i,
  /(^|\/)\.github\//,
  /(^|\/)\.[^/]+rc(\.\w+)?$/i,
  /(^|\/)(Dockerfile|docker-compose[^/]*|Containerfile|Procfile)$/i,
  /\.config\.[cm]?[jt]s$/i,
  /(^|\/)\.(gitignore|gitattributes|dockerignore|editorconfig|npmignore|prettierignore)$/
]

/** Rough categorisation used to spend the diff budget on what matters most: source code first. */
export function categorize(filename: string): FileCategory {
  if (TEST_PATTERNS.some(pattern => pattern.test(filename))) return 'test'
  if (DOC_PATTERNS.some(pattern => pattern.test(filename))) return 'docs'
  if (CONFIG_PATTERNS.some(pattern => pattern.test(filename))) return 'config'
  return 'source'
}

/** Number of changed lines that count towards "min-changed-lines". */
export function countChangedLines(files: readonly PrFile[]): number {
  return files.reduce((total, file) => total + file.additions + file.deletions, 0)
}
