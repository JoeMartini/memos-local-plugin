import { describe, expect, it } from "vitest";
import { viewerHTML } from "../src/viewer/html";

describe("viewer UI T12", () => {
  it("contains the full v4 sharing UI entry points", () => {
    expect(viewerHTML).toContain('id="memorySearchScope"');
    expect(viewerHTML).toContain('id="taskShareActions"');
    expect(viewerHTML).toContain('id="skillSearchInput"');
    expect(viewerHTML).toContain('id="hubSkillsList"');
    expect(viewerHTML).toContain('id="settingsSharingConfig"');
    expect(viewerHTML).toContain('/api/sharing/status');
    expect(viewerHTML).toContain('renderSharingMemorySearchResults');
    expect(viewerHTML).toContain('/api/sharing/search/skills');
    expect(viewerHTML).toContain('/api/sharing/tasks/share');
    expect(viewerHTML).toContain('/api/sharing/skills/pull');
  });
});
