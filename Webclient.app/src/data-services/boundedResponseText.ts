/**
 * Read a JSON response with an enforced *in-flight* byte budget.
 *
 * Response.text() buffers the entire remote payload before a size check
 * can run. A broken upstream could exhaust browser memory long before
 * its declared Content-Length is verified.
 */
export const readBoundedResponseText = async (
  response: Response,
  maxBytes: number,
  source: string,
): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('Invalid response byte budget.');
  }

  const stream = response.body;
  if (!stream) {
    throw new TypeError(`${source} response has no readable body.`);
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let totalBytes = 0;
  let complete = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new RangeError(`${source} response exceeded the payload budget.`);
      }

      // Streaming decoder preserves multibyte Turkish characters split
      // across arbitrary network chunks without creating an extra byte copy.
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    if (!complete) {
      // Stop the upstream as soon as the limit is exceeded, or if decoding
      // fails. Consume cancellation rejection so it cannot go unhandled.
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
};
