/**
 * AIES-010D / T2 profile-level fullscreen contract.
 *
 * These settings are Pi's documented public terminal primitives. AIES owns only
 * its isolated profile values; alternate-screen entry, resize and teardown stay
 * inside Pi.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SETTINGS = fileURLToPath(new URL("../profile/settings.json", import.meta.url));
const profile = JSON.parse(readFileSync(SETTINGS, "utf8"));

describe("fullscreen shell profile", () => {
  it("uses Pi's native fullscreen lifecycle and restores the previous screen", () => {
    assert.equal(profile.tuiMode, "fullscreen");
    assert.equal(profile.fullscreenExitOutput, "resume-hint");
    assert.equal(profile.fullscreenScrollbar, "auto");
  });

  it("keeps launch and thinking presentation quiet through public settings", () => {
    assert.equal(profile.quietStartup, true);
    assert.equal(profile.hideThinkingBlock, true);
  });
});
