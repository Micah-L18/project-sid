/**
 * CommunicationBus — Manages proximity-based chat between agents.
 *
 * Since Mineflayer's bot.chat() broadcasts globally to the Minecraft server,
 * we intercept all chat at the orchestrator level and only deliver messages
 * to agents within the configured hearing radius.
 *
 * Supports:
 * - Proximity-based broadcast (heard by agents within HEARING_RADIUS)
 * - Direct whisper (unlimited range, point-to-point)
 * - Chat history logging for benchmarks
 */

import { ChatEntry } from '../agent/AgentState';
import { Logger } from '../utils/Logger';
import { Vec3 } from 'vec3';
import { WorldState } from './WorldState';

// ── Meme Keywords ────────────────────────────────────────────────────────────

const TRACKED_MEMES = [
  'pastafarian', 'flying spaghetti', 'fsm', 'noodle', 'pasta',
  'ramen', 'colander', 'pirate', 'community', 'constitution',
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentHandle {
  name: string;
  getPosition: () => Vec3 | null;
  deliverChat: (entry: ChatEntry) => void;
}

export interface ChatLogEntry extends ChatEntry {
  receivedBy: string[];
  position: Vec3 | null;
}

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_HEARING_RADIUS = 32;

// ── Communication Bus ────────────────────────────────────────────────────────

export class CommunicationBus {
  private agents: Map<string, AgentHandle> = new Map();
  private hearingRadius: number;
  private chatLog: ChatLogEntry[] = [];
  private logger: Logger;
  private worldState: WorldState | null = null;

  constructor(hearingRadius: number = DEFAULT_HEARING_RADIUS) {
    this.hearingRadius = hearingRadius;
    this.logger = new Logger('CommunicationBus');
  }

  setWorldState(worldState: WorldState): void {
    this.worldState = worldState;
  }

  registerAgent(handle: AgentHandle): void {
    this.agents.set(handle.name, handle);
    this.logger.info(`Registered agent: ${handle.name}`);
  }

  unregisterAgent(name: string): void {
    this.agents.delete(name);
    this.logger.info(`Unregistered agent: ${name}`);
  }

  broadcast(senderName: string, message: string): void {
    const sender = this.agents.get(senderName);
    if (!sender) return;

    const senderPos = sender.getPosition();
    if (!senderPos) return;

    const entry: ChatEntry = {
      sender: senderName,
      message,
      timestamp: Date.now(),
      isProximity: true,
    };

    const receivedBy: string[] = [];

    for (const [name, agent] of this.agents) {
      if (name === senderName) continue;

      const agentPos = agent.getPosition();
      if (!agentPos) continue;

      const distance = senderPos.distanceTo(agentPos);
      if (distance <= this.hearingRadius) {
        agent.deliverChat(entry);
        receivedBy.push(name);
      }
    }

    this.chatLog.push({ ...entry, receivedBy, position: senderPos.clone() });

    // Track cultural meme spread
    if (this.worldState) {
      const lowerMsg = message.toLowerCase();
      for (const keyword of TRACKED_MEMES) {
        if (lowerMsg.includes(keyword)) {
          this.worldState.trackMeme(keyword, senderName);
        }
      }
    }

    this.logger.debug(
      `${senderName} said "${message.substring(0, 50)}" — heard by ${receivedBy.length} agents`
    );
  }

  whisper(senderName: string, targetName: string, message: string): void {
    const target = this.agents.get(targetName);
    if (!target) {
      this.logger.warn(`Whisper target not found: ${targetName}`);
      return;
    }

    const entry: ChatEntry = {
      sender: senderName,
      message,
      timestamp: Date.now(),
      isProximity: false,
    };

    target.deliverChat(entry);

    const sender = this.agents.get(senderName);
    const senderPos = sender?.getPosition() ?? null;
    this.chatLog.push({ ...entry, receivedBy: [targetName], position: senderPos });
  }

  getChatLog(): Readonly<ChatLogEntry[]> {
    return this.chatLog;
  }

  getRecentChat(limit: number = 50): ChatLogEntry[] {
    return this.chatLog.slice(-limit);
  }

  getAgentCount(): number {
    return this.agents.size;
  }

  getAgentNames(): string[] {
    return Array.from(this.agents.keys());
  }

  setHearingRadius(radius: number): void {
    this.hearingRadius = radius;
    this.logger.info(`Hearing radius updated to ${radius} blocks`);
  }

  clearLog(): void {
    this.chatLog = [];
  }
}
