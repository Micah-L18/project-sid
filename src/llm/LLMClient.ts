/**
 * LLM Client — Unified interface to local LLMs via Ollama (OpenAI-compatible API).
 * Supports chat completions and embeddings. Model is configurable per-call.
 */

import { Ollama } from 'ollama';
import { Logger } from '../utils/Logger';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** If true, return a JSON object (model must support structured output) */
  json?: boolean;
  /** Stop sequences */
  stop?: string[];
  /**
   * Set to false to suppress <think> blocks on reasoning models (e.g. qwen3, andy-lite).
   * Defaults to true (thinking enabled) for plain chat; promptJSON overrides to false
   * so the model doesn't exhaust its token budget before writing JSON.
   */
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

export interface LLMConfig {
  host: string;        // e.g. "http://localhost:11434"
  defaultModel: string; // e.g. "qwen3.5:9b"
  embeddingModel: string; // e.g. "nomic-embed-text"
  defaultTemperature: number;
  defaultMaxTokens: number;
  /** Max concurrent requests */
  maxConcurrency: number;
  /** Timeout per request in ms */
  timeoutMs: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  host: 'http://192.168.0.219:11434',
  defaultModel: 'qwen3.5:9b',
  embeddingModel: 'nomic-embed-text',
  defaultTemperature: 0.7,
  defaultMaxTokens: 1024,
  maxConcurrency: 8,
  timeoutMs: 60_000,
};

// ── Client ───────────────────────────────────────────────────────────────────

export class LLMClient {
  private ollama: Ollama;
  private config: LLMConfig;
  private logger: Logger;
  private inflight = 0;
  private queue: Array<() => void> = [];

  // Metrics
  public totalCalls = 0;
  public totalTokens = 0;
  public totalDurationMs = 0;

  constructor(config: Partial<LLMConfig> = {}) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
    this.ollama = new Ollama({ host: this.config.host });
    this.logger = new Logger('LLMClient');
  }

  // ── Chat Completion ──────────────────────────────────────────────────────

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const model = options.model ?? this.config.defaultModel;
    const maxRetries = 2; // up to 3 total attempts for transient errors

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.acquireConcurrency();
      const start = Date.now();

      try {
        const response = await this.withTimeout(
          this.ollama.chat({
            model,
            messages,
            options: {
              temperature: options.temperature ?? this.config.defaultTemperature,
              num_predict: options.maxTokens ?? this.config.defaultMaxTokens,
              stop: options.stop,
            },
            think: options.think,
            format: options.json ? 'json' : undefined,
          }),
          this.config.timeoutMs,
          `Chat call to ${model}`
        );

        const durationMs = Date.now() - start;
        const result: ChatResponse = {
          content: response.message.content,
          model,
          promptTokens: response.prompt_eval_count ?? 0,
          completionTokens: response.eval_count ?? 0,
          totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
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
           error.message.includes('socket hang up') || error.message.includes('fetch failed'));

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
    // Should never reach here
    throw new Error(`Chat exhausted all retries for ${model}`);
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
      // On retries append an explicit JSON reminder so the model doesn't produce only a think block
      const effectiveUserPrompt = attempt === 1
        ? userPrompt
        : `${userPrompt}\n\n[IMPORTANT: Your previous response contained no JSON. You MUST reply with ONLY a valid JSON object, nothing else.]`;

      let raw: string;
      try {
        raw = await this.prompt(systemPrompt, effectiveUserPrompt, {
          ...options,
          json: true,
          think: options.think ?? false, // disable think block by default — avoids exhausting token budget before JSON is written
          maxTokens: options.maxTokens ?? 2048,
        });
      } catch (err) {
        // Wrap network/timeout errors into the retry loop instead of throwing immediately
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(`Attempt ${attempt}/${maxAttempts}: prompt call failed (${lastError.message.substring(0, 80)}), retrying...`);
        continue;
      }

      // Strip thinking model artifacts (<think>...</think>) before any parse attempt.
      const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      // If the model returned only a think block with no JSON, retry immediately.
      if (!stripped) {
        this.logger.warn(`Attempt ${attempt}/${maxAttempts}: model returned only think block, retrying...`);
        lastError = new Error('Model returned only think block with no JSON content');
        continue;
      }

      try {
        return JSON.parse(stripped) as T;
      } catch {
        this.logger.warn(`Failed to parse JSON response, attempting extraction...`);
        // Strategy 1: Extract from markdown code blocks
        const codeBlock = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) {
          try { return JSON.parse(codeBlock[1].trim()) as T; } catch { /* continue */ }
        }
        // Strategy 2: Find first { ... } or [ ... ] in the response
        const braceMatch = stripped.match(/(\{[\s\S]*\})/);
        if (braceMatch) {
          try { return JSON.parse(braceMatch[1]) as T; } catch { /* continue */ }
        }
        const bracketMatch = stripped.match(/(\[[\s\S]*\])/);
        if (bracketMatch) {
          try { return JSON.parse(bracketMatch[1]) as T; } catch { /* continue */ }
        }
        // Strategy 3: Strip leading/trailing non-JSON text from the already-cleaned string
        const cleaned = stripped
          .replace(/^[^{[]*/, '')
          .replace(/[^}\]]*$/, '')
          .trim();
        if (cleaned) {
          try { return JSON.parse(cleaned) as T; } catch { /* continue */ }
        }
        // Strategy 4: Repair truncated JSON by closing open structures
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

  /**
   * Attempt to repair truncated JSON by closing unclosed structures.
   * Handles the common case where token limit cuts off the response mid-JSON.
   */
  private repairTruncatedJSON(raw: string): string | null {
    // Find where the JSON starts
    const jsonStart = raw.search(/[{\[]/);
    if (jsonStart === -1) return null;

    let json = raw.substring(jsonStart);

    // Remove any trailing incomplete string value (cut mid-word)
    json = json.replace(/,\s*"[^"]*$/s, '');          // trailing incomplete key
    json = json.replace(/:\s*"[^"]*$/s, ': ""');      // trailing incomplete string value
    json = json.replace(/,\s*$/s, '');                  // trailing comma

    // Count open/close brackets and braces
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

    // Close any unclosed structures
    if (stack.length > 0) {
      json += stack.reverse().join('');
      return json;
    }
    return null;
  }

  // ── Embeddings ───────────────────────────────────────────────────────────

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
      await this.ollama.list();
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.ollama.list();
    return response.models.map(m => m.name);
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
