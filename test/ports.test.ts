import { describe, expect, test } from "bun:test";
import { PORT_MAX, PORT_MIN } from "../src/core/protocol.ts";
import { RANDOM_EXCLUDED_PORTS, shuffledPorts } from "../src/server/ports.ts";

describe("random port pool hygiene", () => {
  test("random candidates never include the deployment's production port 13689", () => {
    for (let i = 0; i < 200; i += 1) {
      const ports = shuffledPorts();
      expect(ports).not.toContain(13689);
      expect(ports.length).toBe(PORT_MAX - PORT_MIN + 1 - RANDOM_EXCLUDED_PORTS.size);
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(PORT_MIN);
        expect(port).toBeLessThanOrEqual(PORT_MAX);
      }
    }
  });

  test("explicit ranges still cover the rest of 13680-13699", () => {
    const ports = new Set(shuffledPorts());
    for (let p = PORT_MIN; p <= PORT_MAX; p += 1) {
      if (p === 13689) continue;
      expect(ports.has(p)).toBe(true);
    }
  });
});
