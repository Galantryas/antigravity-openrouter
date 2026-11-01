import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiEnvelope, toOpenRouterRequest, toTools } from '../src/proxy/translate/request.ts';
import { GeminiStreamTranslator } from '../src/proxy/translate/response.ts';
import { injectCatalogModels } from '../src/proxy/catalog.ts';
import type { ModelEntry, ModelRegistry } from '../src/openrouter/models.ts';

const entry: ModelEntry = {
  alias: 'anthropic-claude-sonnet-4-5',
  displayName: 'Claude Sonnet 4.5 (OpenRouter)',
  modelId: 'anthropic/claude-sonnet-4.5',
  contextLength: 200_000,
};

const envelope: GeminiEnvelope = {
  model: 'or/anthropic-claude-sonnet-4-5',
  requestType: 'agent',
  request: {
    systemInstruction: { parts: [{ text: 'You are Antigravity.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'read the file' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: { Path: 'a.txt' } }, thoughtSignature: 'sig' } as never],
      },
      { role: 'model', parts: [{ functionResponse: { name: 'read_file', response: { output: 'hello' } } }] },
      { role: 'user', parts: [{ text: 'thanks' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
    ],
    tools: [{ functionDeclarations: [{ name: 'read_file', description: 'read', parameters: { type: 'OBJECT', properties: { Path: { type: 'STRING' } }, required: ['Path'] } }] }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } },
  },
};

test('system prompt becomes a system message', () => {
  const chat = toOpenRouterRequest(envelope, entry);
  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages[0].content, 'You are Antigravity.');
  assert.equal(chat.model, 'anthropic/claude-sonnet-4.5');
});

test('functionCall becomes assistant tool_calls and functionResponse becomes a tool message', () => {
  const chat = toOpenRouterRequest(envelope, entry);
  const assistant = chat.messages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.deepEqual(assistant.tool_calls, [
    { id: 'call_1_0', type: 'function', function: { name: 'read_file', arguments: '{"Path":"a.txt"}' } },
  ]);

  const tool = chat.messages.find((message) => message.role === 'tool');
  assert.ok(tool);
  assert.equal(tool.tool_call_id, 'call_1_0');
  assert.deepEqual(JSON.parse(tool.content as string), { output: 'hello' });
});

test('images become image_url parts', () => {
  const chat = toOpenRouterRequest(envelope, entry);
  const last = chat.messages.at(-1);
  assert.ok(Array.isArray(last?.content));
  const parts = last.content as Array<{ type: string; image_url?: { url: string } }>;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.match(parts[1].image_url!.url, /^data:image\/png;base64,/);
});

test('thinking level maps to reasoning effort and maxOutputTokens to max_tokens', () => {
  const chat = toOpenRouterRequest(envelope, entry);
  assert.deepEqual(chat.reasoning, { effort: 'high' });
  assert.equal(chat.max_tokens, 8192);
});

test('tool schemas are lowercased JSON Schema', () => {
  const tools = toTools(envelope.request!.tools);
  assert.equal(tools.length, 1);
  const schema = tools[0].function.parameters as { type: string; properties: { Path: { type: string } } };
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.Path.type, 'string');
});

test('stream chunks become Cloud Code SSE frames', () => {
  const translator = new GeminiStreamTranslator('trace-1');
  const frames = [
    ...translator.push({ choices: [{ index: 0, delta: { reasoning: 'thinking…' } }] }),
    ...translator.push({ choices: [{ index: 0, delta: { content: 'Hi' } }] }),
    ...translator.push({ choices: [{ index: 0, delta: { content: ' there' } }] }),
    ...translator.finish(),
  ];

  assert.equal(frames.length, 4);
  for (const frame of frames) assert.match(frame, /^data: \{.*\}\n\n$/s);

  const parsed = frames.map((frame) => JSON.parse(frame.replace(/^data: /, '')));
  assert.deepEqual(parsed[0].response.candidates[0].content.parts[0], { thought: true, text: 'thinking…' });
  assert.deepEqual(parsed[1].response.candidates[0].content.parts[0], { text: 'Hi' });
  assert.equal(parsed[3].response.candidates[0].finishReason, 'STOP');
  assert.equal(parsed[0].traceId, 'trace-1');
  assert.equal(parsed[0].metadata !== undefined, true);
});

test('tool call deltas are buffered and emitted as one functionCall part', () => {
  const translator = new GeminiStreamTranslator('trace-2');
  const frames = [
    ...translator.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call_a', function: { name: 'run_command', arguments: '{"Comm' } }],
          },
        },
      ],
    }),
    ...translator.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'andLine":"dir"}' } }] } }] }),
    ...translator.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
    ...translator.finish(),
  ];

  const parsed = frames.map((frame) => JSON.parse(frame.replace(/^data: /, '')));
  const call = parsed.find((frame) => frame.response.candidates[0].content.parts[0].functionCall);
  assert.deepEqual(call.response.candidates[0].content.parts[0].functionCall, {
    name: 'run_command',
    args: { CommandLine: 'dir' },
  });

  const final = parsed.at(-1);
  assert.equal(final.response.candidates[0].finishReason, 'STOP');
  assert.deepEqual(final.response.usageMetadata, { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 });
});

test('catalog injection adds models and a picker group', () => {
  const registry = {
    entries: () => [entry],
    identityFor: () => 'MODEL_PLACEHOLDER_M1600',
  } as unknown as ModelRegistry;
  const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

  const upstream = JSON.stringify({
    models: { 'gemini-4-argon-medium': { displayName: 'Gemini 4 Argon (Medium)', model: 'MODEL_PLACEHOLDER_M418' } },
    defaultAgentModelId: 'gemini-4-argon-medium',
    agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-4-argon-medium'] }] }],
  });

  const injected = JSON.parse(injectCatalogModels(upstream, registry, log));
  assert.equal(injected.models['gemini-4-argon-medium'].model, 'MODEL_PLACEHOLDER_M418');
  assert.equal(injected.models['or/anthropic-claude-sonnet-4-5'].model, 'MODEL_PLACEHOLDER_M1600');
  assert.equal(injected.models['or/anthropic-claude-sonnet-4-5'].displayName, 'Claude Sonnet 4.5 (OpenRouter)');
  assert.deepEqual(injected.agentModelSorts[0].groups[0].modelIds, ['or/anthropic-claude-sonnet-4-5']);
  assert.deepEqual(injected.agentModelSorts[0].groups[1].modelIds, ['gemini-4-argon-medium']);
});

test('catalog injection leaves upstream untouched without models', () => {
  const registry = { entries: () => [] } as unknown as ModelRegistry;
  const log = { info: () => {}, warn: () => {}, error: () => {} } as never;
  const upstream = '{"models":{}}';
  assert.equal(injectCatalogModels(upstream, registry, log), upstream);
});
