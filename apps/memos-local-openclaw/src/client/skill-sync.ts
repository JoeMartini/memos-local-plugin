import * as fs from "fs";
import * as path from "path";
import type { SqliteStore } from "../storage/sqlite";
import type { SkillGenerateOutput } from "../types";
import type { SkillBundle } from "../sharing/types";

export function buildSkillBundleForHub(store: SqliteStore, skillId: string): SkillBundle {
  const skill = store.getSkill(skillId);
  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  const latestVersion = store.getLatestSkillVersion(skillId);
  const skillMd = readSkillMarkdown(skill.dirPath, latestVersion?.content ?? "");

  return {
    metadata: {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      qualityScore: skill.qualityScore,
    },
    bundle: {
      skill_md: skillMd,
      scripts: readCompanionFiles(path.join(skill.dirPath, "scripts")),
      references: readCompanionFiles(path.join(skill.dirPath, "references")),
      evals: readEvals(path.join(skill.dirPath, "evals", "evals.json")),
    } satisfies SkillGenerateOutput,
  };
}

function readSkillMarkdown(dirPath: string, fallback: string): string {
  const skillMdPath = path.join(dirPath, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    return fs.readFileSync(skillMdPath, "utf8");
  }
  return fallback;
}

function readCompanionFiles(dirPath: string): Array<{ filename: string; content: string }> {
  if (!fs.existsSync(dirPath)) return [];

  const out: Array<{ filename: string; content: string }> = [];
  walkFiles(dirPath, dirPath, out);
  return out.sort((left, right) => left.filename.localeCompare(right.filename));
}

function walkFiles(rootDir: string, currentDir: string, out: Array<{ filename: string; content: string }>): void {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(rootDir, fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({
      filename: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
      content: fs.readFileSync(fullPath, "utf8"),
    });
  }
}

function readEvals(evalsPath: string): Array<{ id: number; prompt: string; expectations: string[] }> {
  if (!fs.existsSync(evalsPath)) return [];
  const raw = JSON.parse(fs.readFileSync(evalsPath, "utf8")) as { evals?: Array<{ id: number; prompt: string; expectations: string[] }> };
  return Array.isArray(raw.evals) ? raw.evals : [];
}
