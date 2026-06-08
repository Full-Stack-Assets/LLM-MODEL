import { test } from 'node:test';
import assert from 'node:assert/strict';

// The GeminiService constructor requires an API key; set a dummy one before the
// module (and its singleton) is loaded via dynamic import.
process.env.GEMINI_API_KEY = 'test-key';

async function newService() {
  const { GeminiService } = await import('../src/services/gemini.service');
  return new GeminiService();
}

test('convertToolsToGemini groups every function under a single Tool object', async () => {
  const service = await newService();
  const tools = [
    { name: 'a', description: 'tool a', inputSchema: { type: 'object' } },
    { name: 'b', description: 'tool b', inputSchema: { type: 'object' } },
  ];

  const result = service.convertToolsToGemini(tools);

  // Must be ONE Tool object, not one per function.
  assert.equal(result.length, 1);
  assert.equal(result[0].functionDeclarations.length, 2);
  assert.deepEqual(
    result[0].functionDeclarations.map((d: any) => d.name),
    ['a', 'b']
  );
});

test('convertToolsToGemini returns an empty array when there are no tools', async () => {
  const service = await newService();
  assert.deepEqual(service.convertToolsToGemini([]), []);
});

test('cleanJsonSchema strips non-standard metadata fields', async () => {
  const service = await newService();
  const dirty = {
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'q' },
    },
    required: ['query'],
  };

  const cleaned = service.cleanJsonSchema(dirty as any);

  assert.equal('$schema' in cleaned, false);
  assert.equal('additionalProperties' in cleaned, false);
  assert.deepEqual(cleaned.required, ['query']);
  assert.equal(cleaned.properties?.query.description, 'q');
});

test('cleanJsonSchema falls back to an object schema for invalid input', async () => {
  const service = await newService();
  assert.deepEqual(service.cleanJsonSchema(undefined), {
    type: 'object',
    properties: {},
  });
});
