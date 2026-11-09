import { describe, expect, test } from "bun:test";
import { blockUnprotectedPreviewHost } from "./preview-guard";

const allowed = "g1-autonomy-20261109-opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev";

describe("G1 preview host protection", () => {
  test("permits the owner-authenticated stable alias", () => {
    expect(blockUnprotectedPreviewHost(allowed, allowed)).toBe(false);
  });
  test("fails closed when Preview configuration is missing", () => {
    expect(blockUnprotectedPreviewHost(allowed)).toBe(true);
  });
  test("blocks unique deployment URLs bypassing the stable Access alias", () => {
    expect(blockUnprotectedPreviewHost("0123456789abcdef-opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev", allowed)).toBe(true);
  });
  test("blocks other Preview branch aliases", () => {
    expect(blockUnprotectedPreviewHost("other-opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev", allowed)).toBe(true);
  });
  test("does not change the production hostname", () => {
    expect(blockUnprotectedPreviewHost("opencode-harness-example.cdf-cloud-mvp-20261019.workers.dev")).toBe(false);
  });
});
