import { describe, expect, it, vi } from 'vitest';
import { readBoundedResponseText } from './boundedResponseText';

describe('bounded municipal HTTP response streaming', () => {
  it('decodes split UTF-8 characters without changing Turkish text', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x43, 0xCC, 0xA7])); // C + combining cedilla
        controller.enqueue(new Uint8Array([0xC4]));
        controller.enqueue(new Uint8Array([0xB1])); // ı split across chunks
        controller.close();
      },
    });

    const response = new Response(source);
    await expect(readBoundedResponseText(response, 5, 'PlanASKI'))
      .resolves.toBe('Çı');
  });

  it('rejects an oversized stream before reading the entire HTTP body', async () => {
    const cancelled = vi.fn();
    let chunks = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(7));
        // The source deliberately does not close: the reader must reject
        // after the second chunk and cancel instead of waiting for all data.
      },
      cancel: cancelled,
    });

    const response = new Response(source);
    await expect(readBoundedResponseText(response, 10, 'PlanASKI'))
      .rejects.toThrow('payload budget');
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(chunks).toBeLessThan(5);
  });

  it('accepts exactly the byte budget, not more', async () => {
    const source = new Response('1234567890');
    await expect(readBoundedResponseText(source, 10, 'PlanASKI'))
      .resolves.toBe('1234567890');
  });

  it('fails closed for invalid UTF-8, a missing body, or an invalid budget', async () => {
    const malformed = new Response(new Uint8Array([0xC3, 0x28]));
    await expect(readBoundedResponseText(malformed, 10, 'PlanASKI'))
      .rejects.toThrow();
    await expect(readBoundedResponseText(new Response(null), 10, 'PlanASKI'))
      .rejects.toThrow('no readable body');
    await expect(readBoundedResponseText(new Response('ok'), 0, 'PlanASKI'))
      .rejects.toThrow('byte budget');
  });
});
