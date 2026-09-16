import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  extname,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  normalizeRepositoryPath,
  safeJsonParse,
  type FileKind,
  type JsonResult,
  type LanguageStats,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface InventoryOptions {
  readonly root: string;
  readonly maxTextBytes?: number;
  readonly includeTests?: boolean;
  readonly ignoreDirectories?: readonly string[];
  readonly ignorePaths?: readonly RegExp[];
}

export interface LineIndex {
  readonly offsets: readonly number[];
  lineAt(index: number): number;
  columnAt(index: number): number;
}

export interface JsonDocument<T = unknown> {
  readonly file: SourceFile;
  readonly result: JsonResult<T>;
}

export interface ManifestInventory {
  readonly packageJson: readonly JsonDocument<Record<string, unknown>>[];
  readonly packageLocks: readonly JsonDocument<Record<string, unknown>>[];
  readonly projectFiles: readonly SourceFile[];
  readonly solutionFiles: readonly SourceFile[];
  readonly workflowFiles: readonly SourceFile[];
  readonly configFiles: readonly SourceFile[];
}

export const DEFAULT_IGNORE_DIRECTORIES = Object.freeze([
  '.git',
  '.idea',
  '.vs',
  '.vscode',
  'node_modules',
  'build',
  'dist',
  'coverage',
  'bin',
  'obj',
  'TestResults',
  'artifacts',
  'qa-artifacts',
]);

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.md',
  '.mdx',
  '.cs',
  '.csproj',
  '.props',
  '.targets',
  '.sln',
  '.xml',
  '.yml',
  '.yaml',
  '.sh',
  '.ps1',
  '.env',
  '.example',
  '.txt',
]);

const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

export function classifyFile(path: string): FileKind {
  const lower = path.toLowerCase();
  const extension = extname(lower);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript';
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) return 'typescript';
  if (extension === '.json') return 'json';
  if (['.css', '.scss', '.sass', '.less'].includes(extension)) return 'css';
  if (['.html', '.htm'].includes(extension)) return 'html';
  if (['.md', '.mdx'].includes(extension)) return 'markdown';
  if (extension === '.cs') return 'csharp';
  if (['.xml', '.csproj', '.props', '.targets', '.sln'].includes(extension)) return 'xml';
  if (['.yml', '.yaml'].includes(extension)) return 'yaml';
  if (['.sh', '.ps1'].includes(extension)) return 'shell';
  return 'other';
}

export function isTextCandidate(path: string): boolean {
  const extension = extname(path).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return true;
  const name = basename(path).toLowerCase();
  return [
    'dockerfile',
    'makefile',
    '.gitignore',
    '.gitattributes',
    '.editorconfig',
    '.npmrc',
    '.nvmrc',
    'global.json',
  ].includes(name);
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export function createLineIndex(text: string): LineIndex {
  const offsets: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) offsets.push(index + 1);
  }

  const locate = (index: number): number => {
    const target = Math.max(0, Math.min(text.length, index));
    let low = 0;
    let high = offsets.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const value = offsets[middle] ?? 0;
      if (value === target) return middle;
      if (value < target) low = middle + 1;
      else high = middle - 1;
    }
    return Math.max(0, high);
  };

  return {
    offsets,
    lineAt(index: number): number {
      return locate(index) + 1;
    },
    columnAt(index: number): number {
      const lineIndex = locate(index);
      const lineStart = offsets[lineIndex] ?? 0;
      return Math.max(1, index - lineStart + 1);
    },
  };
}

export function snippetAround(text: string, index: number, radius = 120): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, radius * 2);
}

export function safeReadText(path: string, maxTextBytes: number): string | null {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > maxTextBytes) return null;
    const text = readFileSync(path, 'utf8');
    if (text.includes('\u0000')) return null;
    return text;
  } catch {
    return null;
  }
}

function shouldIgnoreDirectory(name: string, ignored: ReadonlySet<string>): boolean {
  return ignored.has(name) || name.startsWith('.cache') || name.startsWith('coverage-');
}

function shouldIgnorePath(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(path));
}

function isInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRepositoryPath(realpathSync(root));
  const normalizedCandidate = normalizeRepositoryPath(realpathSync(candidate));
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function collectSourceFiles(options: InventoryOptions): SourceFile[] {
  const root = resolve(options.root);
  const maxTextBytes = options.maxTextBytes ?? 2 * 1024 * 1024;
  const includeTests = options.includeTests ?? true;
  const ignoredDirectories = new Set([
    ...DEFAULT_IGNORE_DIRECTORIES,
    ...(options.ignoreDirectories ?? []),
  ]);
  const ignorePaths = options.ignorePaths ?? [];
  const files: SourceFile[] = [];

  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && shouldIgnoreDirectory(entry.name, ignoredDirectories)) continue;
      const absolutePath = join(directory, entry.name);
      const repositoryPath = normalizeRepositoryPath(relative(root, absolutePath));
      if (!repositoryPath || repositoryPath.startsWith('../')) continue;
      if (shouldIgnorePath(repositoryPath, ignorePaths)) continue;

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isTextCandidate(repositoryPath)) continue;
      if (!includeTests && TEST_PATH.test(repositoryPath)) continue;

      const text = safeReadText(absolutePath, maxTextBytes);
      if (text === null) continue;
      const stats = statSync(absolutePath);
      files.push({
        absolutePath,
        repositoryPath,
        extension: extname(repositoryPath).toLowerCase(),
        kind: classifyFile(repositoryPath),
        bytes: stats.size,
        lines: countLines(text),
        text,
      });
    }
  };

  if (existsSync(root)) walk(root);
  return files.sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath, 'en'));
}

export function summarizeLanguages(files: readonly SourceFile[]): LanguageStats[] {
  const buckets = new Map<FileKind, { files: number; lines: number; bytes: number }>();
  for (const file of files) {
    const bucket = buckets.get(file.kind) ?? { files: 0, lines: 0, bytes: 0 };
    bucket.files += 1;
    bucket.lines += file.lines;
    bucket.bytes += file.bytes;
    buckets.set(file.kind, bucket);
  }
  return [...buckets.entries()]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((left, right) => right.lines - left.lines || left.kind.localeCompare(right.kind, 'en'));
}

export function buildRepositoryInventory(options: InventoryOptions): RepositoryInventory {
  const root = resolve(options.root);
  const files = collectSourceFiles(options);
  const languageStats = summarizeLanguages(files);
  return {
    root,
    files,
    ignoredDirectories: [...new Set([
      ...DEFAULT_IGNORE_DIRECTORIES,
      ...(options.ignoreDirectories ?? []),
    ])].sort((a, b) => a.localeCompare(b, 'en')),
    languageStats,
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: new Date().toISOString(),
  };
}

export function findFile(inventory: RepositoryInventory, repositoryPath: string): SourceFile | undefined {
  const normalized = normalizeRepositoryPath(repositoryPath);
  return inventory.files.find(file => file.repositoryPath === normalized);
}

export function findFiles(inventory: RepositoryInventory, pattern: RegExp): SourceFile[] {
  return inventory.files.filter(file => pattern.test(file.repositoryPath));
}

export function parseJsonDocument<T = unknown>(file: SourceFile): JsonDocument<T> {
  return { file, result: safeJsonParse<T>(file.text) };
}

export function collectManifestInventory(inventory: RepositoryInventory): ManifestInventory {
  const packageJson: JsonDocument<Record<string, unknown>>[] = [];
  const packageLocks: JsonDocument<Record<string, unknown>>[] = [];
  const projectFiles: SourceFile[] = [];
  const solutionFiles: SourceFile[] = [];
  const workflowFiles: SourceFile[] = [];
  const configFiles: SourceFile[] = [];

  for (const file of inventory.files) {
    const name = basename(file.repositoryPath).toLowerCase();
    if (name === 'package.json') packageJson.push(parseJsonDocument<Record<string, unknown>>(file));
    else if (name === 'package-lock.json') packageLocks.push(parseJsonDocument<Record<string, unknown>>(file));
    else if (file.repositoryPath.endsWith('.csproj')) projectFiles.push(file);
    else if (file.repositoryPath.endsWith('.sln')) solutionFiles.push(file);
    else if (/^\.github\/workflows\/.*\.ya?ml$/i.test(file.repositoryPath)) workflowFiles.push(file);

    if (
      name === 'global.json'
      || name === 'directory.build.props'
      || name === 'directory.packages.props'
      || name === 'tsconfig.json'
      || name.startsWith('tsconfig.')
      || name === 'vite.config.ts'
      || name === 'vite.config.js'
      || name === '.eslintrc'
      || name === '.eslintrc.json'
    ) {
      configFiles.push(file);
    }
  }

  return {
    packageJson,
    packageLocks,
    projectFiles,
    solutionFiles,
    workflowFiles,
    configFiles,
  };
}

export function repositoryPathExists(inventory: RepositoryInventory, repositoryPath: string): boolean {
  return findFile(inventory, repositoryPath) !== undefined;
}

export function filesUnder(inventory: RepositoryInventory, directory: string): SourceFile[] {
  const normalized = normalizeRepositoryPath(directory).replace(/\/$/, '');
  return inventory.files.filter(file => file.repositoryPath.startsWith(`${normalized}/`));
}

export function selectSourceCode(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => ['javascript', 'typescript', 'csharp'].includes(file.kind));
}

export function selectWebSource(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file =>
    file.repositoryPath.startsWith('Webclient.app/src/')
    && ['javascript', 'typescript', 'css', 'html', 'json'].includes(file.kind),
  );
}

export function selectBackendSource(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => file.kind === 'csharp');
}

export function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export function resolveRepositoryFile(root: string, repositoryPath: string): string | null {
  const absolute = resolve(root, repositoryPath);
  if (!existsSync(absolute)) return null;
  try {
    return isInsideRoot(root, absolute) ? absolute : null;
  } catch {
    return null;
  }
}
