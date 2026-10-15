/**
 * Hide comment-only URLs before collecting runtime network references.
 *
 * The network-call lexer masks quoted literals because call detection wants
 * executable expressions. URL discovery has the opposite requirement: URLs
 * in runtime string constants are relevant, while URLs in source comments are
 * not executable references. Keep this lexer separate from call detection.
 *
 * Offsets and newlines are preserved for accurate evidence line locations.
 */
export function maskNetworkReferenceComments(text: string): string {
  const characters = text.split('');
  type Frame = { kind: 'code'; braceDepth?: number } | { kind: 'template' };
  const stack: Frame[] = [{ kind: 'code' }];

  const hide = (start: number, end: number): void => {
    for (let i = start; i < Math.min(end, text.length); i += 1) {
      if (text[i] !== '\n') characters[i] = ' ';
    }
  };

  let offset = 0;
  while (offset < text.length) {
    const frame = stack[stack.length - 1];
    const current = text[offset] ?? '';
    const next = text[offset + 1] ?? '';

    if (frame?.kind === 'template') {
      if (current === '\\') {
        offset += 2;
      } else if (current === '\x60') {
        stack.pop();
        offset += 1;
      } else if (current === '$' && next === '{') {
        stack.push({ kind: 'code', braceDepth: 1 });
        offset += 2;
      } else {
        offset += 1;
      }
      continue;
    }

    if (current === "'" || current === '"') {
      const delimiter = current;
      offset += 1;
      while (offset < text.length) {
        if (text[offset] === '\\') {
          offset += 2;
        } else if (text[offset] === delimiter) {
          offset += 1;
          break;
        } else {
          offset += 1;
        }
      }
      continue;
    }

    if (current === '\x60') {
      stack.push({ kind: 'template' });
      offset += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      const end = text.indexOf('*/', offset + 2);
      const after = end < 0 ? text.length : end + 2;
      hide(offset, after);
      offset = after;
      continue;
    }

    if (current === '/' && next === '/') {
      // URLs may appear without quotes inside CSS url(https://host).
      // Do not parse their scheme separator as a JavaScript line comment.
      const context = text.slice(Math.max(0, offset - 7), offset);
      if (/https?:$/i.test(context)) {
        offset += 2;
        continue;
      }
      const newline = text.indexOf('\n', offset + 2);
      const after = newline < 0 ? text.length : newline;
      hide(offset, after);
      offset = after;
      continue;
    }

    if (frame?.kind === 'code' && frame.braceDepth !== undefined) {
      if (current === '{') frame.braceDepth += 1;
      if (current === '}') {
        frame.braceDepth -= 1;
        if (frame.braceDepth === 0) stack.pop();
      }
    }
    offset += 1;
  }
  return characters.join('');
}
