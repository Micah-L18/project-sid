/**
 * LLM Client — Cerebras (OpenAI-compatible) for chat, Ollama for embeddings.
 */

import OpenAI from 'openai';
import { Ollama } from 'ollama';
import { Logger } from '../utils/Logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  /** Override provider for this call (per-agent routing) */
  provider?: LLMProvider;
  /** Override host URL for this call (per-agent Ollama/Cerebras instance) */
  host?: string;
  temperature?: number;
  maxTokens?: number;
  /** If true, return a JSON object */
  json?: boolean;
  /** Stop sequences */
  stop?: string[];
  /** Kept for backward compat — ignored for Cerebras (no think blocks). */
  think?: boolean;
}

export interface ChatResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

export interface EmbeddingOptions {
  model?: string;
}

export type LLMProvider = 'cerebras' | 'ollama';

export interface LLMConfig {
  /** Cerebras API base URL */
  host: string;
  /** Cerebras API key (env fallback: CEREBRAS_API_KEY) */
  apiKey: string;
  defaultModel: string;
  /** Ollama host — used for embeddings and optionally chat */
  ollamaHost: string;
  embeddingModel: string;
  defaultTemperature: number;
  defaultMaxTokens: number;
  maxConcurrency: number;
  timeoutMs: number;
  /** Which provider to use for chat: 'cerebras' or 'ollama' */
  provider: LLMProvider;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  host: 'https://api.cerebras.ai/v1',
  apiKey: '',
  defaultModel: 'gpt-oss-120b',
  ollamaHost: 'http://192.168.0.219:11434',
  embeddingModel: 'nomic-embed-text',
  defaultTemperature: 0.7,
  defaultMaxTokens: 5048,
  maxConcurrency: 8,
  timeoutMs: 60_000,
  provider: 'cerebras',
};

// ── Client ───────────────────────────────────────────────────────────────────

export class LLMClient {
  private openai: OpenAI;
  private ollama: Ollama;
  private config: LLMConfig;
  private logger: Logger;
  private inflight = 0;
  private queue: Array<() => void> = [];

  /** Cached per-host Ollama clients */
  private ollamaHosts: Map<string, Ollama> = new Map();
  /** Cached per-host OpenAI clients */
  private openaiHosts: Map<string, OpenAI> = new Map();

  public totalCalls = 0;
  public totalTokens = 0;
  public totalDurationMs = 0;

  constructor(config: Partial<LLMConfig> = {}) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };

    // Resolve API key: explicit config > env > empty
    if (!this.config.apiKey) {
      this.config.apiKey = process.env.CEREBRAS_API_KEY ?? '';
    }

    this.openai = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.host,
    });
    this.ollama = new Ollama({ host: this.config.ollamaHost });
    this.logger = new Logger('LLMClient');
  }

  // ── Provider / Model Switching ──────────────────────────────────────────

  getProvider(): LLMProvider { return this.config.provider; }
  getModel(): string { return this.config.defaultModel; }
  getConfig(): Readonly<LLMConfig> { return this.config; }

  setProvider(provider: LLMProvider): void {
    this.config.provider = provider;
    this.logger.info(`Switched chat provider to: ${provider}`);
  }

  setModel(model: string): void {
    this.config.defaultModel = model;
    this.logger.info(`Switched default model to: ${model}`);
  }

  /** List models available from Cerebras */
  async listCerebrasModels(): Promise<string[]> {
    try {
      const response = await this.openai.models.list();
      return response.data.map(m => m.id);
    } catch {
      return ['gpt-oss-120b'];
    }
  }

  /** List models available from Ollama */
  async listOllamaModels(): Promise<string[]> {
    try {
      const response = await this.ollama.list();
      return response.models.map(m => m.name);
    } catch {
      return [];
    }
  }

  // ── Per-host client accessors (cached) ──────────────────────────────────

  private getOllamaClient(host?: string): Ollama {
    if (!host || host === this.config.ollamaHost) return this.ollama;
    let client = this.ollamaHosts.get(host);
    if (!client) {
      client = new Ollama({ host });
      this.ollamaHosts.set(host, client);
      this.logger.info(`Created Ollama client for host: ${host}`);
    }
    return client;
  }

  private getOpenAIClient(host?: string): OpenAI {
    if (!host || host === this.config.host) return this.openai;
    let client = this.openaiHosts.get(host);
    if (!client) {
      client = new OpenAI({ apiKey: this.config.apiKey, baseURL: host });
      this.openaiHosts.set(host, client);
      this.logger.info(`Created OpenAI client for host: ${host}`);
    }
    return client;
  }

  // ── Chat Completion (dispatches to Cerebras or Ollama) ──────────────────

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const effectiveProvider = options.provider ?? this.config.provider;
    if (effectiveProvider === 'ollama') {
      return this.chatOllama(messages, options);
    }
    return this.chatCerebras(messages, options);
  }

  private async chatCerebras(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const model = options.model ?? this.config.defaultModel;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.acquireConcurrency();
      const start = Date.now();

      try {
        const client = this.getOpenAIClient(options.host);
        const response = await this.withTimeout(
          client.chat.completions.create({
            model,
            messages,
            temperature: options.temperature ?? this.config.defaultTemperature,
            max_completion_tokens: options.maxTokens ?? this.config.defaultMaxTokens,
            stop: options.stop ?? undefined,
            response_format: options.json ? { type: 'json_object' } : undefined,
          }),
          this.config.timeoutMs,
          `Chat call to ${model}`
        );

        const durationMs = Date.now() - start;
        const choice = response.choices?.[0];
        const result: ChatResponse = {
          content: choice?.message?.content ?? '',
          model,
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
          durationMs,
        };

        this.totalCalls++;
        this.totalTokens += result.totalTokens;
        this.totalDurationMs += durationMs;

        this.logger.debug(`Chat completed: ${model} (${result.totalTokens} tokens, ${durationMs}ms)`);
        this.releaseConcurrency();
        return result;
      } catch (error) {
        this.releaseConcurrency();
        const isTransient = error instanceof Error &&
          (error.message.includes('timeout') || error.message.includes('ECONNRESET') ||
           error.message.includes('EHOSTDOWN') || error.message.includes('ECONNREFUSED') ||
           error.message.includes('socket hang up') || error.message.includes('fetch failed') ||
           error.message.includes('429') || error.message.includes('rate'));

        if (isTransient && attempt < maxRetries) {
          const backoffMs = 2000 * (attempt + 1);
          this.logger.warn(`Chat attempt ${attempt + 1}/${maxRetries + 1} failed (${error instanceof Error ? error.message.substring(0, 80) : error}), retrying in ${backoffMs}ms...`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        this.logger.error(`Chat failed: ${model}`, error);
        throw error;
      }
    }
    throw new Error(`Chat exhausted all retries for ${model}`);
  }

  private async chatOllama(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const model = options.model ?? this.config.defaultModel;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.acquireConcurrency();
      const start = Date.now();

      try {
        const client = this.getOllamaClient(options.host);
        const response = await this.withTimeout(
          client.chat({
            model,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            format: options.json ? 'json' : undefined,
            options: {
              temperature: options.temperature ?? this.config.defaultTemperature,
              num_predict: options.maxTokens ?? this.config.defaultMaxTokens,
            },
          }),
          this.config.timeoutMs,
          `Ollama chat to ${model}`
        );

        const durationMs = Date.now() - start;
        const result: ChatResponse = {
          content: response.message?.content ?? '',
          model,
          promptTokens: response.prompt_eval_count ?? 0,
          completionTokens: response.eval_count ?? 0,
          totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
          durationMs,
        };

        this.totalCalls++;
        this.totalTokens += result.totalTokens;
        this.totalDurationMs += durationMs;

        this.logger.debug(`Ollama chat completed: ${model} (${result.totalTokens} tokens, ${durationMs}ms)`);
        this.releaseConcurrency();
        return result;
      } catch (error) {
        this.releaseConcurrency();
        const isTransient = error instanceof Error &&
          (error.message.includes('timeout') || error.message.includes('ECONNRESET') ||
           error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed'));

        if (isTransient && attempt < maxRetries) {
          const backoffMs = 2000 * (attempt + 1);
          this.logger.warn(`Ollama chat attempt ${attempt + 1}/${maxRetries + 1} failed (${error instanceof Error ? error.message.substring(0, 80) : error}), retrying in ${backoffMs}ms...`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        this.logger.error(`Ollama chat failed: ${model}`, error);
        throw error;
      }
    }
    throw new Error(`Ollama chat exhausted all retries for ${model}`);
  }

  // ── Convenience: single prompt → string ──────────────────────────────────

  async prompt(systemPrompt: string, userPrompt: string, options: ChatOptions = {}): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const response = await this.chat(messages, options);
    return response.content;
  }

  // ── Convenience: prompt → parsed JSON ────────────────────────────────────

  async promptJSON<T = unknown>(
    systemPrompt: string,
    userPrompt: string,
    options: ChatOptions = {}
  ): Promise<T> {
    const maxAttempts = 3;
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const effectiveUserPrompt = attempt === 1
        ? userPrompt
        : `${userPrompt}\n\n[IMPORTANT: Your previous response contained no JSON. You MUST reply with ONLY a valid JSON object, nothing else.]`;

      let raw: string;
      try {
        raw = await this.prompt(systemPrompt, effectiveUserPrompt, {
          ...options,
          json: true,
          maxTokens: options.maxTokens ?? 2048,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(`Attempt ${attempt}/${maxAttempts}: prompt call failed (${lastError.message.substring(0, 80)}), retrying...`);
        continue;
      }

      // Strip any residual think blocks (shouldn't happen with Cerebras, but safe)
      let stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (!stripped && raw.includes('<think>')) {
        stripped = raw.replace(/<think>[\s\S]*/gi, '').trim();
      }

      if (!stripped) {
        this.logger.warn(`Attempt ${attempt}/${maxAttempts}: empty response, retrying...`);
        lastError = new Error('Model returned empty response');
        continue;
      }

      try {
        return JSON.parse(stripped) as T;
      } catch {
        this.logger.warn(`Failed to parse JSON response, attempting extraction...`);
        this.logger.warn(`Raw response (first 500 chars): ${raw.substring(0, 500)}`);
        // Strategy 1: code blocks
        const codeBlock = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) {
          try { return JSON.parse(codeBlock[1].trim()) as T; } catch { /* continue */ }
        }
        // Strategy 2: brace match
        const braceMatch = stripped.match(/(\{[\s\S]*\})/);
        if (braceMatch) {
          try { return JSON.parse(braceMatch[1]) as T; } catch { /* continue */ }
        }
        // Strategy 3: bracket match
        const bracketMatch = stripped.match(/(\[[\s\S]*\])/);
        if (bracketMatch) {
          try { return JSON.parse(bracketMatch[1]) as T; } catch { /* continue */ }
        }
        // Strategy 4: strip non-JSON prefix/suffix
        const cleaned = stripped.replace(/^[^{[]*/, '').replace(/[^}\]]*$/, '').trim();
        if (cleaned) {
          try { return JSON.parse(cleaned) as T; } catch { /* continue */ }
        }
        // Strategy 5: repair truncated JSON
        const repaired = this.repairTruncatedJSON(stripped);
        if (repaired) {
          try { return JSON.parse(repaired) as T; } catch { /* continue */ }
        }
        lastError = new Error(`LLM returned invalid JSON: ${raw.substring(0, 200)}`);
        this.logger.warn(`Attempt ${attempt}/${maxAttempts}: extraction failed, retrying...`);
      }
    }

    this.logger.error(`All ${maxAttempts} attempts failed. Last error: ${lastError.message}`);
    throw lastError;
  }

  private repairTruncatedJSON(raw: string): string | null {
    const jsonStart = raw.search(/[{\[]/);
    if (jsonStart === -1) return null;

    let json = raw.substring(jsonStart);
    json = json.replace(/,\s*"[^"]*$/s, '');
    json = json.replace(/:\s*"[^"]*$/s, ': ""');
    json = json.replace(/,\s*$/s, '');

    let inString = false;
    let escape = false;
    const stack: string[] = [];

    for (const ch of json) {
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }

    if (stack.length > 0) {
      json += stack.reverse().join('');
      return json;
    }
    return null;
  }

  // ── Embeddings (Ollama) ──────────────────────────────────────────────────

  async embed(text: string, options: EmbeddingOptions = {}): Promise<number[]> {
    const model = options.model ?? this.config.embeddingModel;
    try {
      const response = await this.withTimeout(
        this.ollama.embed({ model, input: text }),
        this.config.timeoutMs,
        `Embed call to ${model}`
      );
      return response.embeddings[0];
    } catch (error) {
      this.logger.error(`Embedding failed: ${model}`, error);
      throw error;
    }
  }

  async embedBatch(texts: string[], options: EmbeddingOptions = {}): Promise<number[][]> {
    const model = options.model ?? this.config.embeddingModel;
    try {
      const response = await this.withTimeout(
        this.ollama.embed({ model, input: texts }),
        this.config.timeoutMs,
        `Batch embed call to ${model}`
      );
      return response.embeddings;
    } catch (error) {
      this.logger.error(`Batch embedding failed: ${model}`, error);
      throw error;
    }
  }

  // ── Health Check ─────────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      if (this.config.provider === 'ollama') {
        await this.ollama.list();
      } else {
        await this.openai.models.list();
      }
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    if (this.config.provider === 'ollama') {
      return this.listOllamaModels();
    }
    return this.listCerebrasModels();
  }

  // ── Timeout Helper ────────────────────────────────────────────────────────

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`LLM timeout after ${ms}ms: ${label}`));
      }, ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  // ── Concurrency Control ──────────────────────────────────────────────────

  private acquireConcurrency(): Promise<void> {
    if (this.inflight < this.config.maxConcurrency) {
      this.inflight++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => {
        this.inflight++;
        resolve();
      });
    });
  }

  private releaseConcurrency(): void {
    this.inflight--;
    const next = this.queue.shift();
    if (next) next();
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  getStats() {
    return {
      provider: this.config.provider,
      model: this.config.defaultModel,
      totalCalls: this.totalCalls,
      totalTokens: this.totalTokens,
      totalDurationMs: this.totalDurationMs,
      avgTokensPerCall: this.totalCalls > 0 ? Math.round(this.totalTokens / this.totalCalls) : 0,
      avgDurationMs: this.totalCalls > 0 ? Math.round(this.totalDurationMs / this.totalCalls) : 0,
      inflight: this.inflight,
      queued: this.queue.length,
    };
  }
}
