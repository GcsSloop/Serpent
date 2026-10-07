import { describe, expect, it } from "vitest";

import {
  AI_CONNECTION_HEARTBEAT_MS,
  AiConnectionProbeGate,
  aiAnalyzeConnectionReady,
  aiAnalyzeShowsDisconnectGlyph,
  shouldRunAiConnectionHeartbeat,
} from "../../src/renderer/ai-connection-heartbeat";

describe("ai-connection-heartbeat (Serpent-rsbt)", () => {
  it("uses a ~60s interval", () => {
    expect(AI_CONNECTION_HEARTBEAT_MS).toBe(60_000);
  });

  it("runs heartbeat only when a stored key exists", () => {
    expect(shouldRunAiConnectionHeartbeat(true)).toBe(true);
    expect(shouldRunAiConnectionHeartbeat(false)).toBe(false);
  });

  it("shows the disconnect glyph when unavailable", () => {
    expect(aiAnalyzeShowsDisconnectGlyph(false, "idle")).toBe(true);
    expect(aiAnalyzeShowsDisconnectGlyph(true, "idle")).toBe(true);
    expect(aiAnalyzeShowsDisconnectGlyph(true, "disconnected")).toBe(true);
    expect(aiAnalyzeShowsDisconnectGlyph(true, "error")).toBe(true);
    expect(aiAnalyzeShowsDisconnectGlyph(true, "connecting")).toBe(false);
    expect(aiAnalyzeShowsDisconnectGlyph(true, "connected")).toBe(false);
  });

  it("allows a configured analysis attempt during transient probe failures", () => {
    expect(aiAnalyzeConnectionReady(true, "connected")).toBe(true);
    expect(aiAnalyzeConnectionReady(true, "connecting")).toBe(true);
    expect(aiAnalyzeConnectionReady(true, "disconnected")).toBe(true);
    expect(aiAnalyzeConnectionReady(false, "connected")).toBe(false);
  });
});

it("manual probes supersede heartbeats and stale results cannot release a newer probe", () => {
  const gate = new AiConnectionProbeGate();
  const first = gate.begin(true)!;
  expect(gate.begin(true)).toBeUndefined();
  const manual = gate.begin()!;
  expect(gate.isCurrent(first)).toBe(false);
  gate.finish(first);
  expect(gate.begin(true)).toBeUndefined();
  gate.finish(manual);
  expect(gate.begin(true)).toBeTypeOf("number");
  gate.invalidate();
  expect(gate.isCurrent(manual)).toBe(false);
});
