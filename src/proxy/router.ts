import { randomUUID } from 'node:crypto';
import { OpenRouterClient, OpenRouterError } from '../openrouter/client';
import { ModelEntry, ModelRegistry } from '../openrouter/models';
import { GeminiEnvelope, toOpenRouterRequest } from './translate/request';
import { GeminiStreamTranslator, toGenerateContentResponse } from './translate/response';
import { ProxyContext } from './server';
import { injectCatalogModels } from './catalog';
import { Logger } from '../util/log';

const GENERATION_PATH = /:(streamGenerateContent|generateContent)\b/;
const CATALOG_PATH = ':fetchAvailableModels';

const MISSING_KEY_TEXT =
  '**OpenRouter is not configured.** Open the Command Palette (`Ctrl+Shift+P`) and run ' +
  '`Antigravity OpenRouter: Set OpenRouter API key`, then send the message again. ' +
  '([set key now](command:antigravityOpenRouter.setApiKey))';

export class ChatRouter {
  readonly counters = { requests: 0, errors: 0, streamedBytes: 0 };
  /** Timestamps of recent provider failures, used to break retry storms. */
  private recentFailures: number[] = [];

  constructor(
    private readonly registry: ModelRegistry,
    private readonly client: OpenRouterClient,
    private readonly log: Logger,
  ) {}

  /**
   * Handles generation requests whose model id belongs to an injected OpenRouter
   * entry. Everything else returns false and is forwarded to Google untouched.
   */
  async intercept(ctx: ProxyContext): Promise<boolean> {
    if (!GENERATION_PATH.test(ctx.url)) return false;

    let envelope: GeminiEnvelope;
    try {
      envelope = JSON.parse(ctx.body.toString('utf8')) as GeminiEnvelope;
    } catch {
      return false;
    }

    const entry = envelope.model ? this.registry.byPickerId(envelope.model) : undefined;
    if (!entry) return false;

    const streaming = ctx.url.includes('streamGenerateContent');
    this.counters.requests++;
    try {
      if (streaming) await this.stream(ctx, envelope, entry);
      else await this.once(ctx, envelope, entry);
    } catch (error) {
      this.counters.errors++;
      this.log.error(`generation via ${entry.modelId} failed`, error);
    }
    return true;
  }

  transformCatalog(body: string): string {
    return injectCatalogModels(body, this.registry, this.log);
  }

  isCatalogRequest(url: string): boolean {
    return url.includes(CATALOG_PATH);
  }

  private async stream(ctx: ProxyContext, envelope: GeminiEnvelope, entry: ModelEntry): Promise<void> {
    const res = ctx.res;
    const started = Date.now();
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const traceId = randomUUID().slice(0, 16);

    if (!(await this.client.hasKey())) {
      this.log.warn('OpenRouter API key is not set; answering with an explanation instead of failing');
      this.notice(ctx, traceId, MISSING_KEY_TEXT);
      return;
    }

    if (!this.allowRequest()) {
      this.log.warn('too many consecutive OpenRouter failures; suppressing this request');
      this.notice(ctx, traceId, '**OpenRouter is failing repeatedly.** Check `Antigravity OpenRouter: Show log`.');
      return;
    }

    const translator = new GeminiStreamTranslator(traceId);
    let frames = 0;
    try {
      const chat = toOpenRouterRequest(envelope, entry);
      this.log.info(
        `${entry.modelId} ← ${envelope.requestType ?? 'agent'} request (${chat.messages.length} messages, ` +
          `${chat.tools?.length ?? 0} tools, ${ctx.body.length}B)`,
      );
      for await (const chunk of this.client.streamChat(chat, abort.signal)) {
        for (const frame of translator.push(chunk)) {
          res.write(frame);
          this.counters.streamedBytes += frame.length;
          frames++;
        }
      }
      for (const frame of translator.finish()) res.write(frame);
      res.end();
      this.log.info(`${entry.modelId} → ${frames} frames in ${Date.now() - started}ms`);
    } catch (error) {
      if (abort.signal.aborted) {
        this.log.info(`${entry.modelId} cancelled by the IDE after ${Date.now() - started}ms`);
        res.end();
        return;
      }
      this.counters.errors++;
      this.recentFailures.push(Date.now());
      this.log.error(`${entry.modelId} failed after ${Date.now() - started}ms: ${(error as Error).message}`);
      this.notice(ctx, traceId, this.failureText(error));
    }
  }

  private async once(ctx: ProxyContext, envelope: GeminiEnvelope, entry: ModelEntry): Promise<void> {
    const res = ctx.res;
    const started = Date.now();
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const traceId = randomUUID().slice(0, 16);

    const respond = (text: string): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          response: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] },
          traceId,
          metadata: {},
        }),
      );
    };

    if (!(await this.client.hasKey())) {
      respond(MISSING_KEY_TEXT);
      return;
    }

    const translator = new GeminiStreamTranslator(traceId);
    const frames: string[] = [];
    try {
      const chat = toOpenRouterRequest(envelope, entry);
      for await (const chunk of this.client.streamChat(chat, abort.signal)) frames.push(...translator.push(chunk));
      frames.push(...translator.finish());

      const payload = JSON.stringify({
        response: toGenerateContentResponse(frames),
        traceId,
        metadata: {},
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
      this.log.info(`${entry.modelId} → single response in ${Date.now() - started}ms`);
    } catch (error) {
      if (abort.signal.aborted) return;
      this.counters.errors++;
      this.recentFailures.push(Date.now());
      this.log.error(`${entry.modelId} failed: ${(error as Error).message}`);
      respond(this.failureText(error));
    }
  }

  /**
   * A provider failure is answered as a normal (short) assistant turn. Answering
   * with an SSE error frame made the agent retry immediately — hundreds of
   * requests per minute — while the UI stayed on "Working".
   */
  private notice(ctx: ProxyContext, traceId: string, text: string): void {
    const res = ctx.res;
    const frame = (candidates: unknown[]) =>
      `data: ${JSON.stringify({ response: { candidates }, traceId, metadata: {} })}\n\n`;
    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    }
    res.write(frame([{ content: { role: 'model', parts: [{ text }] } }]));
    res.write(frame([{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }]));
    res.end();
  }

  private allowRequest(): boolean {
    const now = Date.now();
    this.recentFailures = this.recentFailures.filter((at) => now - at < 15_000);
    return this.recentFailures.length < 4;
  }

  private failureText(error: unknown): string {
    if (error instanceof OpenRouterError) {
      switch (error.status) {
        case 401:
          return '**OpenRouter rejected the API key (401).** Update it with `Antigravity OpenRouter: Set OpenRouter API key`.';
        case 402:
          return '**OpenRouter reports insufficient credits (402).** Top up the account or pick a different model.';
        case 429:
          return '**OpenRouter rate limit (429).** Wait a moment and send the message again.';
        case 404:
          return `**Model unavailable (404).** ${error.message}`;
        default:
          return `**OpenRouter error ${error.status}.** ${error.message}`;
      }
    }
    return `**OpenRouter request failed.** ${(error as Error)?.message ?? 'unknown error'}`;
  }
}
