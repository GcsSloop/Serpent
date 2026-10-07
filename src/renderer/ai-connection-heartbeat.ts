/**
 * AI connection heartbeat (Serpent-rsbt).
 *
 * Reuses the existing `testAiConnection` / probe path on a ~60s cadence and
 * keeps one global connection state for the config title indicator and the
 * asset context-menu disconnect glyph.
 */

export const AI_CONNECTION_HEARTBEAT_MS = 60_000;

export type AiHeartbeatConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/** Whether the context-menu AI analyze affordance should show link-off. */
export function aiAnalyzeShowsDisconnectGlyph(
  hasKey: boolean,
  connectionState: AiHeartbeatConnectionState,
): boolean {
  if (!hasKey) return true;
  return (
    connectionState === "disconnected" ||
    connectionState === "error" ||
    connectionState === "idle"
  );
}

/** A transient heartbeat failure must not block an explicit analysis attempt. */
export function aiAnalyzeConnectionReady(
  hasKey: boolean,
  connectionState: AiHeartbeatConnectionState,
): boolean {
  void connectionState; // Retain the public signature; status is informational.
  return hasKey;
}

/**
 * Heartbeat should run whenever a stored key exists. Dialog draft edits do not
 * stop the stored-config probe; manual dialog tests still write the same state.
 */
export function shouldRunAiConnectionHeartbeat(hasKey: boolean): boolean {
  return hasKey;
}

/** One state owner: manual tests supersede heartbeats; stale replies are ignored. */
export class AiConnectionProbeGate {
  private generation = 0;
  private pending = false;

  begin(background = false): number | undefined {
    if (background && this.pending) return undefined;
    this.pending = true;
    return ++this.generation;
  }

  isCurrent(ticket: number): boolean { return ticket === this.generation; }

  finish(ticket: number): void {
    if (this.isCurrent(ticket)) this.pending = false;
  }

  invalidate(): void {
    this.generation += 1;
    this.pending = false;
  }
}
