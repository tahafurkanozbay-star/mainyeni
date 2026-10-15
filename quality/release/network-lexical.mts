/**
 * Keep source positions stable while hiding comments, quoted strings and
 * non-executable template text from network-call pattern matching.
 *
 * Unlike a regex-only scan, template interpolation expressions remain visible.
 * This is an intentionally bounded lexical filter, not a JavaScript parser:
 * the canonical TypeScript/build checks still validate source syntax.
 */
export function maskNonExecutableNetworkText(text: string): string {
  const result = text.split('');
  type Mode = { kind: 'code'; depth?: number } | { kind: 'template' };
  const stack: Mode[] = [{ kind: 'code' }];

  const hide = (start: number, end: number): void => {
    for (let at = start; at < Math.min(end, text.length); at += 1) {
      if (text[at] !== '\n') result[at] = ' ';
    }
  };

  let offset = 0;
  while (offset < text.length) {
    const mode = stack[stack.length - 1];
    const current = text[offset] ?? '';
    const next = text[offset + 1] ?? '';

    if (mode?.kind === 'template') {
      if (current === '\\') {
        hide(offset, offset + 2);
        offset += 2;
      } else if (current === '\u0060') {
        hide(offset, offset + 1);
        stack.pop();
        offset += 1;
      } else if (current === '$' && next === '{') {
        hide(offset, offset + 2);
        stack.push({ kind: 'code', depth: 1 });
        offset += 2;
      } else {
        hide(offset, offset + 1);
        offset += 1;
      }
      continue;
    }

    if (current === "'" || current === '"') {
      const start = offset;
      offset += 1;
      while (offset < text.length) {
        if (text[offset] === '\\') {
          offset += 2;
          continue;
        }
        if (text[offset] === current) {
          offset += 1;
          break;
        }
        offset += 1;
      }
      hide(start, offset);
      continue;
    }

    if (current === '\u0060') {
      hide(offset, offset + 1);
      stack.push({ kind: 'template' });
      offset += 1;
      continue;
    }

    if (current === '/' && next === '/') {
      const start = offset;
      const newline = text.indexOf('\n', offset + 2);
      offset = newline < 0 ? text.length : newline;
      hide(start, offset);
      continue;
    }

    if (current === '/' && next === '*') {
      const start = offset;
      const end = text.indexOf('*/', offset + 2);
      offset = end < 0 ? text.length : end + 2;
      hide(start, offset);
      continue;
    }

    if (mode?.kind === 'code' && mode.depth !== undefined) {
      if (current === '{') mode.depth += 1;
      else if (current === '}') {
        mode.depth -= 1;
        if (mode.depth === 0) {
          hide(offset, offset + 1);
          stack.pop();
        }
      }
    }
    offset += 1;
  }
  return result.join('');
}
