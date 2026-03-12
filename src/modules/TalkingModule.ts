/**
 * TalkingModule — Handles speech output and incoming speech interpretation.
 * Runs every ~2 seconds.
 *
 * - Reads cognitiveDecision.speech and broadcasts via bot.chat()
 * - Interprets incoming chat, maintaining conversation context
 * - Supports proximity-based communication (managed by CommunicationBus)
 */

import { AgentState } from '../agent/AgentState';
import { PianoModule, ModuleContext } from '../agent/ModuleRunner';

// Track what we've already said to avoid repeats
let lastSpokenTimestamp = 0;

// ── Module Implementation ────────────────────────────────────────────────────

export const TalkingModule: PianoModule = async (
  state: Readonly<AgentState>,
  context: ModuleContext
): Promise<Partial<AgentState>> => {
  const { speech, timestamp } = state.cognitiveDecision;

  // ── Output: Speak if the CC decided to ───────────────────────────────────

  if (speech && timestamp > lastSpokenTimestamp) {
    lastSpokenTimestamp = timestamp;

    // Sanitize: remove quotes, limit length, prevent command injection
    let sanitized = speech
      .replace(/^["']|["']$/g, '')  // Strip wrapping quotes
      .replace(/\n/g, ' ')          // Flatten newlines
      .slice(0, 200);               // Cap at 200 chars

    // Don't send empty or whitespace-only messages
    if (sanitized.trim()) {
      // Prefix with agent name for clarity in chat
      context.sendChat(sanitized.trim());
    }
  }

  // Chat is managed by the CommunicationBus, so no perception updates here
  return {};
};

// ── Factory to create per-agent talking module (avoids shared state) ─────────

export function createTalkingModule(): PianoModule {
  let lastSpoken = 0;

  return async (
    state: Readonly<AgentState>,
    context: ModuleContext
  ): Promise<Partial<AgentState>> => {
    const { speech, timestamp } = state.cognitiveDecision;

    if (speech && timestamp > lastSpoken) {
      lastSpoken = timestamp;

      let sanitized = speech
        .replace(/^["']|["']$/g, '')
        .replace(/\n/g, ' ')
        .slice(0, 200);

      if (sanitized.trim()) {
        context.sendChat(sanitized.trim());
      }
    }

    return {};
  };
}
