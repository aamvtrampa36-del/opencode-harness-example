import { describe, expect, test } from "bun:test";
import { OpenCodeSessionSockets } from "./sockets";
import { aggregateIncident, type IncidentRecord } from "./incident-diagnostics";
import type { OpenCodeHarness } from "agents/harness/opencode";
import type { Connection } from "agents/lifecycle";

describe("G7 passive errors from real socket dispatcher", () => {
  test("records provider failure even when a model generates no text; coalesces repeated failures", async () => {
    let incidents: IncidentRecord[] = [];
    const sent: string[] = [];
    const socket = {
      tags: ["opencode-session:ses_root"],
      readyState: 1,
      send: (data: string) => { sent.push(data); }
    } as unknown as Connection;
    const harness = {
      session: () => ({
        busy: async () => false,
        setModel: async () => { throw new Error("Provider unavailable (429)"); }
      })
    } as unknown as OpenCodeHarness;
    const service = new OpenCodeSessionSockets(
      harness, () => [socket as unknown as WebSocket], async () => true,
      async () => undefined,
      async event => { incidents = aggregateIncident(incidents, event, new Date("2026-11-10T16:00:00Z")); }
    );
    const handlers = service.options().handlers;
    for (let n=0; n<3; n++) {
      await handlers.onMessage(socket, JSON.stringify({
        type: "submit", id: "req-" + n, text: "PRIVATE PROMPT CONTENT",
        model: "cloudflare"
      }));
    }
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      code: "MODEL_UNAVAILABLE", source: "agent", count: 3, status: "blocked",
      automaticRetryAllowed: false
    });
    expect(JSON.stringify(incidents)).not.toContain("PRIVATE PROMPT CONTENT");
    expect(sent.filter(text => text.includes('"type":"error"'))).toHaveLength(3);
  });
});
