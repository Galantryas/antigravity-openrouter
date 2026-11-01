import { ChatRequest, OpenRouterModelInfo, StreamChunk } from './types';

const BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export class OpenRouterClient {
  constructor(
    private readonly getApiKey: () => Promise<string | undefined>,
    private readonly userAgent = 'antigravity-openrouter',
  ) {}

  async hasKey(): Promise<boolean> {
    return Boolean(await this.getApiKey());
  }

  async listModels(): Promise<OpenRouterModelInfo[]> {
    const response = await this.request('/models', { method: 'GET' });
    const json = (await response.json()) as { data?: OpenRouterModelInfo[] };
    return json.data ?? [];
  }

  /** Cheap authenticated call used by the "test key" command. */
  async validateKey(): Promise<{ ok: boolean; message: string }> {
    try {
      const models = await this.listModels();
      return { ok: true, message: `${models.length} models available` };
    } catch (error) {
      const err = error as OpenRouterError;
      if (err.status === 401) return { ok: false, message: 'API key rejected (401)' };
      return { ok: false, message: err.message };
    }
  }

  async *streamChat(body: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const response = await this.request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ ...body, stream: true, usage: { include: true } }),
      signal,
    });

    if (!response.body) throw new OpenRouterError('empty response body', 0);

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload) as StreamChunk;
        } catch {
          // keep-alive comments and partial JSON are skipped
        }
      }
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const key = await this.getApiKey();
    if (!key) throw new OpenRouterError('OpenRouter API key is not set', 401);

    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'user-agent': this.userAgent,
        'x-title': 'Antigravity OpenRouter',
        'http-referer': 'https://antigravity.google',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OpenRouterError(`OpenRouter HTTP ${response.status}: ${text.slice(0, 500)}`, response.status, text);
    }
    return response;
  }
}

export const userAgentHeader = { 'user-agent': 'antigravity-openrouter' };
