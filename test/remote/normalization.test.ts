/**
 * Tests for cross-protocol response normalization
 * (src/remote/adapters/normalization.ts).
 *
 * Covers: normalizeChatCompletionText (plain string + content-block shapes),
 * normalizeCompletionsText (legacy /v1/completions format),
 * normalizeResponseAPIText (OpenAI Responses API output shapes),
 * normalizeModelName (model extraction from response),
 * normalizeAnthropicMessagesText (Anthropic content-block array handling,
 * multi-block concatenation, empty/missing data).
 */
import { describe, test, expect } from "vitest";
import { normalizeChatCompletionText, normalizeCompletionsText, normalizeResponseAPIText, normalizeModelName, normalizeAnthropicMessagesText } from "../../src/remote/adapters/normalization.js";


// =============================================================================
// Shared normalization helpers
// =============================================================================

describe('normalizeChatCompletionText', () => {
  test('extracts message content from standard response', () => {
    const data = {
      choices: [{ message: { content: 'Hello, world!' } }],
      model: 'gpt-4',
    };
    expect(normalizeChatCompletionText(data)).toBe('Hello, world!');
  });

  test('returns empty string for missing choices', () => {
    expect(normalizeChatCompletionText({ model: 'm' })).toBe('');
    expect(normalizeChatCompletionText({})).toBe('');
    expect(normalizeChatCompletionText(null)).toBe('');
    expect(normalizeChatCompletionText(undefined)).toBe('');
  });

  test('returns empty string for empty choices array', () => {
    expect(normalizeChatCompletionText({ choices: [] })).toBe('');
  });

  test('returns empty string when content is missing', () => {
    expect(normalizeChatCompletionText({
      choices: [{ message: {} }],
    })).toBe('');
  });

  test('handles non-object data gracefully', () => {
    expect(normalizeChatCompletionText('string')).toBe('');
    expect(normalizeChatCompletionText(42)).toBe('');
  });

  test('extracts text from content blocks array (multimodal shape)', () => {
    const data = {
      choices: [{
        message: {
          content: [
            { type: 'text', text: 'Hello from blocks' },
            { type: 'image_url', image_url: { url: '...' } },
          ],
        },
      }],
    };
    expect(normalizeChatCompletionText(data)).toBe('Hello from blocks');
  });

  test('returns empty for content blocks without text type', () => {
    const data = {
      choices: [{
        message: {
          content: [{ type: 'image_url', image_url: { url: '...' } }],
        },
      }],
    };
    expect(normalizeChatCompletionText(data)).toBe('');
  });
});

describe('normalizeCompletionsText', () => {
  test('extracts text from legacy completions response', () => {
    const data = {
      choices: [{ text: 'Generated text', index: 0 }],
      model: 'gpt-3.5-turbo-instruct',
    };
    expect(normalizeCompletionsText(data)).toBe('Generated text');
  });

  test('returns empty string for malformed data', () => {
    expect(normalizeCompletionsText(null)).toBe('');
    expect(normalizeCompletionsText({})).toBe('');
    expect(normalizeCompletionsText({ choices: [] })).toBe('');
  });
});

describe('normalizeResponseAPIText', () => {
  test('extracts text from output_text blocks', () => {
    const data = {
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Response text here' },
          ],
        },
      ],
      model: 'gpt-4o',
    };
    expect(normalizeResponseAPIText(data)).toBe('Response text here');
  });

  test('skips non-message output types', () => {
    const data = {
      output: [
        { type: 'reasoning', content: '...' },
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'Actual response' },
          ],
        },
      ],
    };
    expect(normalizeResponseAPIText(data)).toBe('Actual response');
  });

  test('returns empty string when no message output', () => {
    expect(normalizeResponseAPIText({ output: [{ type: 'reasoning' }] })).toBe('');
    expect(normalizeResponseAPIText({ output: [] })).toBe('');
    expect(normalizeResponseAPIText(null)).toBe('');
  });

  test('handles top-level output_text shortcut', () => {
    const data = { output_text: 'direct output text' };
    expect(normalizeResponseAPIText(data)).toBe('direct output text');
  });

  test('handles content blocks with type: "text" variant', () => {
    const data = {
      output: [
        {
          type: 'message',
          content: [{ type: 'text', text: 'Variant text shape' }],
        },
      ],
    };
    expect(normalizeResponseAPIText(data)).toBe('Variant text shape');
  });

  test('prefers output_text over text when both present', () => {
    const data = {
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'output_text wins' },
            { type: 'text', text: 'text variant' },
          ],
        },
      ],
    };
    expect(normalizeResponseAPIText(data)).toBe('output_text wins');
  });
});

describe('normalizeModelName', () => {
  test('extracts model name from response', () => {
    expect(normalizeModelName({ model: 'gpt-4o' }, 'fallback')).toBe('gpt-4o');
  });

  test('returns fallback when model is missing', () => {
    expect(normalizeModelName({}, 'fallback')).toBe('fallback');
    expect(normalizeModelName(null, 'fallback')).toBe('fallback');
  });
});

// =============================================================================
// Anthropic Messages normalization: text extraction from content blocks
// =============================================================================

describe('normalizeAnthropicMessagesText', () => {
  test('extracts text from standard content block', () => {
    const data = {
      id: 'msg_001',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Claude' }],
      model: 'claude-3-opus-20240229',
    };
    expect(normalizeAnthropicMessagesText(data)).toBe('Hello from Claude');
  });

  test('joins multiple text blocks with newline separation (no word-merging)', () => {
    const data = {
      content: [
        { type: 'text', text: 'Part one. ' },
        { type: 'text', text: 'Part two.' },
      ],
    };
    expect(normalizeAnthropicMessagesText(data)).toBe('Part one.\nPart two.');
  });

  test('skips non-text content blocks (tool_use, etc.)', () => {
    const data = {
      content: [
        { type: 'text', text: 'Here is some text' },
        { type: 'tool_use', id: 'tool_1', name: 'calculator', input: {} },
        { type: 'text', text: ' more text.' },
      ],
    };
    expect(normalizeAnthropicMessagesText(data)).toBe('Here is some text\nmore text.');
  });

  test('returns empty string for missing content', () => {
    expect(normalizeAnthropicMessagesText({ id: 'msg' })).toBe('');
    expect(normalizeAnthropicMessagesText({ content: [] })).toBe('');
    expect(normalizeAnthropicMessagesText({})).toBe('');
  });

  test('returns empty string for non-object data', () => {
    expect(normalizeAnthropicMessagesText(null)).toBe('');
    expect(normalizeAnthropicMessagesText(undefined)).toBe('');
    expect(normalizeAnthropicMessagesText('string')).toBe('');
    expect(normalizeAnthropicMessagesText(42)).toBe('');
  });

  test('handles mixed block types with null/empty entries', () => {
    const data = {
      content: [
        null,
        { type: 'text', text: 'valid text' },
        undefined,
        {},
        { type: 'image', source: {} },
        { type: 'text', text: ' more text' },
      ],
    };
    expect(normalizeAnthropicMessagesText(data)).toBe('valid text\nmore text');
  });
});

// =============================================================================
// Adapter registry: format → adapter mapping
// =============================================================================

