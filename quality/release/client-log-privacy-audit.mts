import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex } from './inventory.mts';

export interface ClientLogPrivacySummary {
  readonly runtimeFiles: number;
  readonly clientLogCalls: number;
  readonly flaggedCalls: number;
  readonly retainedFindings: number;
}

const RUNTIME_PATH = /^(?:Webclient\.app|Webclient\.admin)\/src\//;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|fixture|mock)\.[^/]+$/i;
const IDENTIFIER = /[A-Za-z0-9_$]/;
const SENSITIVE_DIRECT_IDENTIFIER = /^(?:query|path|params|payload|record|item|selection|address|coordinates|location|geometry)$/i;
const SENSITIVE_PATH = /\b(?:pathForLog|numberingPathLabelV\d*)\s*\(/;
const SENSITIVE_SERIALIZATION = /\bJSON\s*\.\s*stringify\s*\(\s*(?:query|path|params|payload|record|item|selection|address|coordinates|location)\b/i;
const SENSITIVE_PROPERTY = /\b[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\?\.|\.)\s*(?:address|adres|latitude|longitude|coordinates|street|sokak|mahalle|door)\b/i;
const SENSITIVE_RUNTIME_SOURCE = /\b(?:latestQuery|mapPoint|mapEvent\s*(?:\?\.|\.)\s*mapPoint|item\s*(?:\?\.|\.)\s*(?:Title|title)|(?:query|params|payload|record|item|selection)\s*(?:\?\.|\.)\s*(?:name|districtName|nbhoodName))\b/i;
const SENSITIVE_TEMPLATE = /\$\{[^}]{0,150}\b(?:lat|lon|latitude|longitude|address|adres|street|sokak|mahalle|door|query|path|params|payload|record|item|selection|coordinates|location|geometry|mapPoint|searchText|queryText|latestQuery)\b[^}]*\}/i;
const SENSITIVE_NESTED_VALUE = /(?:[,:\[({]\s*|\.\.\.\s*)(?:query|path|params|payload|record|item|selection|address|coordinates|location|geometry|mapPoint|latestQuery|searchText|queryText)\s*(?=[,}\])]|$)/i;
const SENSITIVE_OBJECT_FIELD = /(?:^|[{,])\s*(?:['"])?(?:query|path|params|payload|record|item|selection|address|adres|coordinates|location|geometry|mapPoint|latestQuery|searchText|queryText)(?:['"])?\s*:/i;
const SENSITIVE_OBJECT_SHORTHAND = /(?:^|[{,])\s*(?:query|path|params|payload|record|item|selection|address|coordinates|location|geometry|mapPoint|latestQuery|searchText|queryText)\s*(?=[,}])/i;

export function isClientRuntimeSource(file: SourceFile): boolean {
  return RUNTIME_PATH.test(file.repositoryPath)
    && (file.kind === 'typescript' || file.kind === 'javascript')
    && !TEST_PATH.test(file.repositoryPath);
}

// Skip lexical literals and comments before searching for calls. This prevents
// a comment or a user-visible example string from becoming a release finding.
function skipLiteral(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
    } else if (text[index] === quote) {
      return index + 1;
    }
  }
  return text.length;
}

function skipComment(text: string, start: number): number {
  if (text[start + 1] === '/') {
    const newline = text.indexOf('\n', start + 2);
    return newline === -1 ? text.length : newline + 1;
  }
  const end = text.indexOf('*/', start + 2);
  return end === -1 ? text.length : end + 2;
}

export function callArguments(text: string, open: number): readonly string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  // A bounded scan prevents a malformed file from consuming the whole audit.
  const limit = Math.min(text.length, open + 8_192);
  for (let index = open + 1; index < limit; index += 1) {
    const character = text[index];
    if (character === "'" || character === '"' || character === '`') {
      index = skipLiteral(text, index) - 1;
      continue;
    }
    if (character === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      index = skipComment(text, index) - 1;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ')' && depth === 0) {
      args.push(text.slice(start, index).trim());
      return args;
    }
    if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth < 0) return null;
      continue;
    }
    if (character === ',' && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return null;
}

interface ClientLogCall {
  readonly offset: number;
  readonly arguments: readonly string[] | null;
}

function findClientLogCalls(text: string): readonly ClientLogCall[] {
  const calls: ClientLogCall[] = [];
  const name = 'safeClientLog';
  const maxTemplateDepth = 32;

  // A template's ordinary text is inert, but ${...} is executable
  // JavaScript. Skipping the entire backtick literal loses privacy violations
  // inside interpolations (including nested templates in TSX components).
  function scanTemplate(start: number, depth: number): number {
    if (depth > maxTemplateDepth) return skipLiteral(text, start);
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === '\\') {
        index += 1;
        continue;
      }
      if (text[index] === '`') return index + 1;
      if (text[index] === '$' && text[index + 1] === '{') {
        index = scanCode(index + 2, true, depth + 1) - 1;
      }
    }
    return text.length;
  }

  function scanCode(start: number, inInterpolation: boolean, depth: number): number {
    let braces = 0;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (character === "'" || character === '"') {
        index = skipLiteral(text, index) - 1;
        continue;
      }
      if (character === '`') {
        index = scanTemplate(index, depth + 1) - 1;
        continue;
      }
      if (character === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
        index = skipComment(text, index) - 1;
        continue;
      }
      if (inInterpolation && character === '{') {
        braces += 1;
        continue;
      }
      if (inInterpolation && character === '}') {
        if (braces === 0) return index + 1;
        braces -= 1;
        continue;
      }
      if (!text.startsWith(name, index) ||
          (index > 0 && IDENTIFIER.test(text[index - 1] ?? '')) ||
          IDENTIFIER.test(text[index + name.length] ?? '')) continue;

      let open = index + name.length;
      while (open < text.length && /\s/.test(text[open] ?? '')) open += 1;
      if (text.startsWith('?.', open)) open += 2;
      while (open < text.length && /\s/.test(text[open] ?? '')) open += 1;
      if (text[open] !== '(') continue;
      const args = callArguments(text, open);
      // Keep fail-closed malformed/oversized call behavior and never record
      // the source argument text in findings or serialized audit evidence.
      calls.push({ offset: index, arguments: args });
      index = open;
    }
    return text.length;
  }

  scanCode(0, false, 0);
  return calls;
}

function riskReason(argument: string): string | null {
  const value = argument.trim();
  const executable = privacyMask(argument);
  if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/.test(value) && !value.includes('${')) return null;
  if (SENSITIVE_DIRECT_IDENTIFIER.test(argument.trim())) return 'raw-record-or-query';
  if (SENSITIVE_PATH.test(executable)) return 'address-path-label';
  if (SENSITIVE_SERIALIZATION.test(executable)) return 'serialized-record-or-query';
  // Interpolated template payloads are expressions, not object-literal keys.
  // Prefer their privacy classification over static label text such as
  // `coordinates: ${mapPoint}` before inspecting object-key syntax.
  if (SENSITIVE_TEMPLATE.test(argument)) return 'sensitive-template';
  if (/\b(?:address|adres|latitude|longitude|coordinates|mahalle)\s*:/.test(executable)) return 'sensitive-object-key';
  if (/\[\s*['"](?:address|adres|latitude|longitude|coordinates|mahalle)['"]\s*\]/.test(argument)) return 'sensitive-bracket-property';
  if (/\b(?:String|Number|encodeURIComponent)\s*\(\s*(?:lat|lon|latitude|longitude|searchText|queryText|query|path|params|payload|record|item|selection|address|coordinates|location|geometry|mapPoint|latestQuery)\b/.test(executable)) return 'wrapped-location-value';
  if (/['"](?:address|adres|latitude|longitude|coordinates|mahalle)['"]\s*:/.test(argument)) return 'sensitive-object-key';
  if (SENSITIVE_PROPERTY.test(executable)) return 'sensitive-property';
  // Object shorthand ({ query }) is equivalent to { query: query }.
  // Mask inert comments/strings first so examples do not cause false findings.
  if (SENSITIVE_OBJECT_SHORTHAND.test(executable)) return 'shorthand-sensitive-value';
  if (SENSITIVE_OBJECT_FIELD.test(argument)) return 'sensitive-object-key';
  if (SENSITIVE_NESTED_VALUE.test(executable)) return 'nested-sensitive-value';
  if (SENSITIVE_RUNTIME_SOURCE.test(executable)) return 'location-or-search-value';
  return null;
}


/**
 * The direct argument scanner cannot see identifiers whose values came from
 * private map/address data. Review bounded local aliases without retaining
 * payload values in audit evidence or following imports/network references.
 *
 * Scopes are tracked lexically. Declarations in a sibling function must never
 * taint a separate function's safe diagnostic counter.
 */
interface AliasBinding {
  readonly identifier: string;
  readonly expression: string;
  readonly position: number;
  readonly scope: readonly number[];
  readonly mutable: boolean;
}

function privacyMask(text: string): string {
  const characters = text.split(''); // Preserve UTF-16 offsets for astral symbols.
  const blank = (index: number): void => {
    if (characters[index] !== '\n') characters[index] = ' ';
  };
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    if (current === "'" || current === '"' || current === '\x60') {
      const end = skipLiteral(text, index);
      for (let cursor = index; cursor < end; cursor += 1) blank(cursor);
      index = end - 1;
    } else if (current === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      const end = skipComment(text, index);
      for (let cursor = index; cursor < end; cursor += 1) blank(cursor);
      index = end - 1;
    }
  }
  return characters.join('');
}

function initializerEnd(masked: string, start: number): number {
  const limit = Math.min(masked.length, start + 4_096);
  const openers: string[] = [];
  for (let position = start; position < limit; position += 1) {
    const character = masked[position];
    if (character === '(' || character === '[' || character === '{') {
      openers.push(character);
    } else if (character === ')' || character === ']' || character === '}') {
      const expected = character === ')' ? '(' : character === ']' ? '[' : '{';
      if (openers.at(-1) !== expected) return position;
      openers.pop();
    } else if (openers.length === 0 && (character === ';' || character === ',' || character === '\n')) {
      return position;
    }
  }
  return limit;
}


const PRIVATE_DESTRUCTURED_FIELD = /^(?:address|adres|latitude|longitude|coordinates|street|sokak|mahalle|door)$/i;

/**
 * Track explicitly private fields renamed by shallow destructuring. Without
 * this step, address: locationLabel is invisible at the logging call because
 * the payload is passed under a harmless-looking local name.
 *
 * Only bounded local declarations are considered; imported and nested object
 * destructuring are not inferred without a trustworthy AST.
 */
function destructuredBindings(text: string, masked: string): readonly AliasBinding[] {
  const bindings: AliasBinding[] = [];
  const objectPattern =
    /\b(const|let|var)\s*\{([^{}]{1,768})\}\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
  const arrays =
    /\b(const|let|var)\s*\[([A-Za-z_$][\w$\s,]{0,192})\]\s*=\s*(coordinates|location|geometry|query|record)\b/g;
  for (const declaration of masked.matchAll(objectPattern)) {
    const statement = text.slice(declaration.index, declaration.index + declaration[0].length);
    const parts = /\{([^{}]+)\}/.exec(statement)?.[1] ?? '';
    const source = declaration[3] ?? '';
    if (!source) continue;
    const scope = scopeAt(masked, declaration.index);
    for (const item of parts.split(',').slice(0, 24)) {
      const field = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*(?:=.*)?$/.exec(item);
      if (!field || !PRIVATE_DESTRUCTURED_FIELD.test(field[1] ?? '')) continue;
      bindings.push({
        identifier: field[2] ?? '',
        expression: source + '.' + (field[1] ?? ''),
        position: declaration.index,
        scope,
        mutable: declaration[1] !== 'const',
      });
      if (bindings.length >= 256) return bindings;
    }
    // A rest binding retains original source fields, not just safe counters.
    const rest = /\.{3}\s*([A-Za-z_$][\w$]*)\s*$/.exec(parts);
    if (rest && /^(?:query|record|payload|selection|params)$/i.test(source)) {
      bindings.push({
        identifier: rest[1] ?? '',
        expression: source,
        position: declaration.index,
        scope,
        mutable: declaration[1] !== 'const',
      });
    }
  }
  for (const declaration of masked.matchAll(arrays)) {
    const values = (declaration[2] ?? '').split(',').map(value => value.trim()).filter(Boolean);
    const source = declaration[3] ?? '';
    const scope = scopeAt(masked, declaration.index);
    for (const value of values.slice(0, 12)) {
      bindings.push({
        identifier: value,
        expression: source,
        position: declaration.index,
        scope,
        mutable: declaration[1] !== 'const',
      });
      if (bindings.length >= 256) return bindings;
    }
  }
  return bindings;
}

function localBindings(text: string, masked: string): readonly AliasBinding[] {
  const declarations = /\b(?:(const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?!=|>)/g;
  const destructured = destructuredBindings(text, masked);
  const scopes: number[] = [];
  const bindings: AliasBinding[] = [];
  let cursor = 0;
  let declaration: RegExpExecArray | null;
  while ((declaration = declarations.exec(masked)) !== null && bindings.length < 1_024) {
    const position = declaration.index;
    for (; cursor < position; cursor += 1) {
      if (masked[cursor] === '{') scopes.push(cursor);
      else if (masked[cursor] === '}') scopes.pop();
    }
    const identifier = declaration[2] ?? '';
    const declarationKind = declaration[1];
    const preceding = masked[position - 1] ?? '';
    // Writes through object properties are not local identifier assignments.
    if (!declarationKind && (preceding === '.' || preceding === '?')) continue;
    // Reassignment is meaningful only for a visible mutable local. Constants
    // cannot legitimately be assigned, and a parameter/default assignment does
    // not establish a local binding for privacy provenance.
    const direct = declarationKind ? undefined : visibleBinding(bindings, identifier, position, scopes);
    const unpacked = declarationKind ? undefined : visibleBinding(destructured, identifier, position, scopes);
    const earlier = direct && unpacked
      ? direct.position >= unpacked.position ? direct : unpacked
      : direct ?? unpacked;
    if (!declarationKind && (!earlier || !earlier.mutable)) continue;
    const expressionStart = position + declaration[0].length;
    const end = initializerEnd(masked, expressionStart);
    if (end > expressionStart && end - expressionStart < 4_096) {
      bindings.push({
        identifier,
        expression: text.slice(expressionStart, end),
        position,
        scope: [...scopes],
        mutable: earlier?.mutable ?? declarationKind !== 'const',
      });
    }
  }
  return [...bindings, ...destructured]
    .sort((left, right) => left.position - right.position);
}

function scopeAt(masked: string, position: number): readonly number[] {
  const scopes: number[] = [];
  for (let cursor = 0; cursor < Math.min(position, masked.length); cursor += 1) {
    if (masked[cursor] === '{') scopes.push(cursor);
    else if (masked[cursor] === '}') scopes.pop();
  }
  return scopes;
}

function visibleBinding(
  bindings: readonly AliasBinding[],
  identifier: string,
  before: number,
  scopes: readonly number[],
): AliasBinding | undefined {
  for (let index = bindings.length - 1; index >= 0; index -= 1) {
    const binding = bindings[index];
    if (!binding || binding.identifier !== identifier || binding.position >= before) continue;
    if (binding.scope.length > scopes.length) continue;
    if (!binding.scope.every((scope, depth) => scopes[depth] === scope)) continue;
    return binding;
  }
  return undefined;
}

function aliasPrivacyReason(
  argument: string,
  position: number,
  masked: string,
  bindings: readonly AliasBinding[],
): string | null {
  const context = scopeAt(masked, position);
  const observed = new Set<string>();
  const search = (expression: string, limit: number, prior: number): string | null => {
    const direct = riskReason(expression);
    if (direct) return direct;
    if (limit === 0 || observed.size >= 32) return null;
    // Ignore quoted literals so a harmless label naming a private field does
    // not become a false positive. The direct scanner handles interpolations.
    const tokens = privacyMask(expression).match(/[A-Za-z_$][\w$]*/g) ?? [];
    for (const token of tokens.slice(0, 64)) {
      const binding = visibleBinding(bindings, token, prior, context);
      if (!binding || observed.has(token)) continue;
      observed.add(token);
      const reason = search(binding.expression, limit - 1, binding.position);
      if (reason) return 'derived-' + reason;
    }
    return null;
  };
  return search(argument, 8, position);
}

export function createClientPrivacyClassifier(
  source: string,
): (argument: string, position: number) => string | null {
  const masked = privacyMask(source);
  const bindings = localBindings(source, masked);
  return (argument, position) => aliasPrivacyReason(argument, position, masked, bindings);
}

export function auditClientLogPrivacy(inventory: RepositoryInventory): AuditSection<ClientLogPrivacySummary> {
  const start = performance.now();
  const files = inventory.files.filter(isClientRuntimeSource);
  const findings: Finding[] = [];
  let clientLogCalls = 0;
  let detectedUnsafeCalls = 0;
  for (const file of files) {
    const index = createLineIndex(file.text);
    const classify = createClientPrivacyClassifier(file.text);
    const fileFindingStart = findings.length;
    let flaggedInFile = 0;
    for (const call of findClientLogCalls(file.text)) {
      clientLogCalls += 1;
      // Continue inspecting all calls even after the per-file evidence cap:
      // otherwise the ninth unsafe payload is invisible to exact-base QA.
      // The third argument is the payload, not the logger or event name.
      const reason = call.arguments === null
        ? 'unreviewable-client-log-call'
        : call.arguments.length >= 3 ? classify(call.arguments[2] ?? '', call.offset) : null;
      if (!reason) continue;
      flaggedInFile += 1;
      detectedUnsafeCalls += 1;
      if (flaggedInFile > 8) continue;
      findings.push({
        id: 'client-log-sensitive-payload',
        domain: 'security',
        severity: 'high',
        title: 'Potential sensitive client-log payload',
        message: 'Client logs should carry bounded, non-identifying event metadata rather than address, location or serialized query content.',
        location: { file: file.repositoryPath, line: index.lineAt(call.offset) },
        evidence: { metadata: { reason } },
        remediation: 'Log a constant event marker or bounded non-identifying count and verify that raw address/query values never reach the logger.',
        tags: ['privacy', 'logging', 'data-minimization'],
      });
    }
    if (flaggedInFile > 8) {
      // Reserve one of the eight evidence slots for the aggregate overflow.
      // evidence.value contributes to findingKey()/exact-base regression; it
      // contains only a numeric count, never raw query or address material.
      const firstOverflow = findings[fileFindingStart + 7];
      findings[fileFindingStart + 7] = {
        id: 'client-log-sensitive-payload-overflow',
        domain: 'security',
        severity: 'high',
        title: 'Additional sensitive client logging beyond evidence budget',
        message: 'Sensitive logging continues beyond the seven itemized findings and requires remediation.',
        ...(firstOverflow?.location ? { location: firstOverflow.location } : {}),
        evidence: { value: flaggedInFile - 7, metadata: { retainedFindings: 7 } },
        remediation: 'Remove raw address, location and query logging. Preserve the per-file evidence cap without suppressing detection of later calls.',
        tags: ['privacy', 'logging', 'data-minimization', 'overflow'],
      };
    }
  }
  return {
    domain: 'security',
    title: 'Client log payload privacy',
    summary: { runtimeFiles: files.length, clientLogCalls, flaggedCalls: detectedUnsafeCalls, retainedFindings: findings.length },
    findings: stableSortFindings(findings),
    elapsedMs: performance.now() - start,
  };
}
