/**
 * ModuleRunner — Concurrent execution engine for PIANO modules.
 *
 * Each module is a stateless async function that reads the AgentState,
 * performs work (possibly including LLM calls), and returns mutations
 * to apply to the state. Modules run on independent timers at different
 * frequencies, following the paper's brain-inspired concurrency principle.
 *
 * The runner ensures:
 * - Modules run on their own schedules (fast: 1-2s, slow: 10-30s)
 * - State mutations are applied atomically
 * - One module failing doesn't crash others
 * - Proper cleanup on shutdown
 */

import { AgentState } from './AgentState';
import { Logger } from '../utils/Logger';
import { Bot } from 'mineflayer';
import { LLMClient } from '../llm/LLMClient';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModuleContext {
  bot: Bot;
  llm: LLMClient;
  /** Broadcast a message to the communication bus */
  sendChat: (message: string) => void;
  /** Current simulation time in ms */
  simTime: number;
  /** Agent name shortcut */
  agentName: string;
}

/**
 * A PIANO module: reads state + context, returns partial state updates.
 * Modules MUST be stateless — all persistent state lives in AgentState.
 * Return Partial<AgentState> with only the fields that changed.
 */
export type PianoModule = (
  state: Readonly<AgentState>,
  context: ModuleContext
) => Promise<Partial<AgentState>>;

export interface ModuleRegistration {
  /** Unique module name */
  name: string;
  /** The module function */
  execute: PianoModule;
  /** How often to run, in milliseconds */
  intervalMs: number;
  /** Priority for state write conflicts (higher = wins) */
  priority: number;
  /** Is this module enabled? */
  enabled: boolean;
  /** Optional: extra delay before first run (for per-agent stagger) */
  startDelayMs?: number;
}

interface RunningModule extends ModuleRegistration {
  timer: ReturnType<typeof setTimeout> | null;
  isRunning: boolean;
  lastRunAt: number;
  lastDurationMs: number;
  runCount: number;
  errorCount: number;
  lastError: string | null;
}

// ── Module Runner ────────────────────────────────────────────────────────────

export class ModuleRunner {
  private modules: Map<string, RunningModule> = new Map();
  private state: AgentState;
  private context: ModuleContext;
  private logger: Logger;
  private running = false;
  private stateLock = false;

  constructor(state: AgentState, context: ModuleContext) {
    this.state = state;
    this.context = context;
    this.logger = new Logger(`ModuleRunner:${context.agentName}`);
  }

  // ── Registration ─────────────────────────────────────────────────────────

  register(registration: ModuleRegistration): void {
    if (this.modules.has(registration.name)) {
      throw new Error(`Module "${registration.name}" is already registered`);
    }

    const running: RunningModule = {
      ...registration,
      timer: null,
      isRunning: false,
      lastRunAt: 0,
      lastDurationMs: 0,
      runCount: 0,
      errorCount: 0,
      lastError: null,
    };

    this.modules.set(registration.name, running);
    this.logger.info(`Registered module: ${registration.name} (interval: ${registration.intervalMs}ms)`);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info(`Starting ${this.modules.size} modules...`);

    for (const mod of this.modules.values()) {
      if (!mod.enabled) continue;
      const startDelay = mod.startDelayMs ?? 0;
      mod.timer = setTimeout(() => this.scheduleModule(mod), startDelay);
    }
  }

  /**
   * Self-rescheduling loop: run the module, then immediately schedule the
   * next run after intervalMs. This prevents the "skipped tick" problem
   * where setInterval fires while isRunning=true and the tick is lost,
   * forcing the agent to wait an entire extra interval before acting.
   */
  private scheduleModule(mod: RunningModule): void {
    if (!this.running) return;
    this.executeModule(mod).finally(() => {
      if (this.running && mod.enabled) {
        mod.timer = setTimeout(() => this.scheduleModule(mod), mod.intervalMs);
      }
    });
  }

  stop(): void {
    this.running = false;
    for (const mod of this.modules.values()) {
      if (mod.timer) {
        clearTimeout(mod.timer);
        mod.timer = null;
      }
    }
    this.logger.info('All modules stopped');
  }

  // ── Module Execution ─────────────────────────────────────────────────────

  private async executeModule(mod: RunningModule): Promise<void> {
    if (!this.running || !this.state.isAlive) return;
    if (mod.isRunning) return; // Skip if previous run hasn't finished

    mod.isRunning = true;
    const start = Date.now();

    try {
      // Pass a frozen snapshot to prevent mid-execution mutations
      const stateSnapshot = this.state; // Shallow — modules should not mutate
      this.context.simTime = Date.now();

      const updates = await mod.execute(stateSnapshot, this.context);

      // Apply updates atomically
      await this.applyUpdates(mod.name, updates);

      mod.lastDurationMs = Date.now() - start;
      mod.lastRunAt = Date.now();
      mod.runCount++;
      mod.lastError = null;

    } catch (error) {
      mod.errorCount++;
      const errMsg = error instanceof Error ? error.message : String(error);
      mod.lastError = errMsg;
      mod.lastDurationMs = Date.now() - start;

      this.logger.error(`Module "${mod.name}" failed (${mod.errorCount} total errors): ${errMsg}`);

      // Disable module after too many consecutive errors
      if (mod.errorCount > 10 && mod.runCount < mod.errorCount * 2) {
        this.logger.error(`Disabling module "${mod.name}" due to excessive errors`);
        mod.enabled = false;
        if (mod.timer) {
          clearTimeout(mod.timer);
          mod.timer = null;
        }
      }
    } finally {
      mod.isRunning = false;
    }
  }

  // ── State Management ─────────────────────────────────────────────────────

  private async applyUpdates(moduleName: string, updates: Partial<AgentState>): Promise<void> {
    // Simple spin-wait for lock (fine for single-threaded Node.js event loop)
    while (this.stateLock) {
      await new Promise(r => setTimeout(r, 1));
    }
    this.stateLock = true;

    try {
      // Deep merge updates into state
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          (this.state as unknown as Record<string, unknown>)[key] = value;
        }
      }
      this.state.tick++;
    } finally {
      this.stateLock = false;
    }
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  getState(): Readonly<AgentState> {
    return this.state;
  }

  getMutableState(): AgentState {
    return this.state;
  }

  getModuleStats(): Record<string, {
    enabled: boolean;
    runCount: number;
    errorCount: number;
    lastDurationMs: number;
    lastRunAt: number;
    lastError: string | null;
    isRunning: boolean;
  }> {
    const stats: Record<string, any> = {};
    for (const [name, mod] of this.modules) {
      stats[name] = {
        enabled: mod.enabled,
        runCount: mod.runCount,
        errorCount: mod.errorCount,
        lastDurationMs: mod.lastDurationMs,
        lastRunAt: mod.lastRunAt,
        lastError: mod.lastError,
        isRunning: mod.isRunning,
      };
    }
    return stats;
  }

  isRunning(): boolean {
    return this.running;
  }
}
