import * as fs from "fs";
import * as path from "path";
import type { SqliteStore } from "../storage/sqlite";
import type { RecallEngine } from "../recall/engine";
import type { Embedder } from "../embedding";
import type { Task, Skill, Chunk, PluginContext } from "../types";
import { DEFAULTS } from "../types";
import { SkillEvaluator } from "./evaluator";
import { SkillGenerator } from "./generator";
import { SkillUpgrader } from "./upgrader";
import { SkillInstaller } from "./installer";

export class SkillEvolver {
  private evaluator: SkillEvaluator;
  private generator: SkillGenerator;
  private upgrader: SkillUpgrader;
  private installer: SkillInstaller;
  private processing = false;

  constructor(
    private store: SqliteStore,
    private engine: RecallEngine,
    private ctx: PluginContext,
    embedder?: Embedder,
  ) {
    this.evaluator = new SkillEvaluator(ctx);
    this.generator = new SkillGenerator(store, engine, ctx, embedder);
    this.upgrader = new SkillUpgrader(store, ctx);
    this.installer = new SkillInstaller(store, ctx);
  }

  async onTaskCompleted(task: Task): Promise<void> {
    const enabled = this.ctx.config.skillEvolution?.enabled ?? DEFAULTS.skillEvolutionEnabled;
    const autoEval = this.ctx.config.skillEvolution?.autoEvaluate ?? DEFAULTS.skillAutoEvaluate;
    if (!enabled || !autoEval) return;

    if (this.processing) {
      this.ctx.log.debug("SkillEvolver: already processing, skipping");
      return;
    }
    this.processing = true;
    try {
      await this.process(task);
    } catch (err) {
      this.ctx.log.error(`SkillEvolver error: ${err}`);
    } finally {
      this.processing = false;
    }
  }

  private async process(task: Task): Promise<void> {
    const chunks = this.store.getChunksByTask(task.id);

    const { pass, skipReason } = this.evaluator.passesRuleFilter(chunks, task);
    if (!pass) {
      this.ctx.log.debug(`SkillEvolver: task ${task.id} skipped by rule filter: ${skipReason} (chunks=${chunks.length})`);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "skipped", skillReason: skipReason });
      return;
    }

    const relatedSkill = await this.findRelatedSkill(task);

    if (relatedSkill) {
      await this.handleExistingSkill(task, chunks, relatedSkill);
    } else {
      await this.handleNewSkill(task, chunks);
    }
  }

  private async findRelatedSkill(task: Task): Promise<Skill | null> {
    try {
      const result = await this.engine.search({
        query: task.summary.slice(0, 500),
        maxResults: 10,
        minScore: 0.5,
      });

      for (const hit of result.hits) {
        if (hit.skillId) {
          const skill = this.store.getSkill(hit.skillId);
          if (skill && (skill.status === "active" || skill.status === "draft")) {
            this.ctx.log.debug(`SkillEvolver: found related skill "${skill.name}" via memory search`);
            return skill;
          }
        }
      }
    } catch (err) {
      this.ctx.log.warn(`SkillEvolver: memory search for related skill failed: ${err}`);
    }
    return null;
  }

  private async handleExistingSkill(task: Task, chunks: Chunk[], skill: Skill): Promise<void> {
    const skillContent = this.readSkillContent(skill);
    if (!skillContent) {
      this.ctx.log.warn(`SkillEvolver: cannot read skill "${skill.name}" content, treating as new`);
      await this.handleNewSkill(task, chunks);
      return;
    }

    const minConfidence = this.ctx.config.skillEvolution?.minConfidence ?? DEFAULTS.skillMinConfidence;
    const evalResult = await this.evaluator.evaluateUpgrade(task, skill, skillContent);

    if (evalResult.shouldUpgrade && evalResult.confidence >= minConfidence) {
      this.ctx.log.info(`SkillEvolver: upgrading skill "${skill.name}" — ${evalResult.reason}`);
      const { upgraded } = await this.upgrader.upgrade(task, skill, evalResult);

      this.markChunksWithSkill(chunks, skill.id);

      if (upgraded) {
        this.store.linkTaskSkill(task.id, skill.id, "evolved_from", skill.version + 1);
        this.installer.syncIfInstalled(skill.name);
      } else {
        this.store.linkTaskSkill(task.id, skill.id, "applied_to", skill.version);
      }
    } else if (evalResult.confidence < 0.3) {
      // Low confidence means the matched skill is likely unrelated — try creating a new one
      this.ctx.log.info(
        `SkillEvolver: skill "${skill.name}" has low relevance (confidence=${evalResult.confidence}), ` +
        `falling back to new skill evaluation for task "${task.title}"`,
      );
      await this.handleNewSkill(task, chunks);
    } else {
      this.ctx.log.debug(`SkillEvolver: skill "${skill.name}" not worth upgrading (confidence=${evalResult.confidence})`);
      this.markChunksWithSkill(chunks, skill.id);
      this.store.linkTaskSkill(task.id, skill.id, "applied_to", skill.version);
    }
  }

  private async handleNewSkill(task: Task, chunks: Chunk[]): Promise<void> {
    const minConfidence = this.ctx.config.skillEvolution?.minConfidence ?? DEFAULTS.skillMinConfidence;
    const evalResult = await this.evaluator.evaluateCreate(task);

    if (evalResult.shouldGenerate && evalResult.confidence >= minConfidence) {
      this.ctx.log.info(`SkillEvolver: generating new skill "${evalResult.suggestedName}" — ${evalResult.reason}`);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "generating", skillReason: evalResult.reason });

      const skill = await this.generator.generate(task, chunks, evalResult);
      this.markChunksWithSkill(chunks, skill.id);
      this.store.linkTaskSkill(task.id, skill.id, "generated_from", 1);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "generated", skillReason: evalResult.reason });

      const autoInstall = this.ctx.config.skillEvolution?.autoInstall ?? DEFAULTS.skillAutoInstall;
      if (autoInstall && skill.status === "active") {
        this.installer.install(skill.id);
      }
    } else {
      const reason = evalResult.reason || `confidence不足 (${evalResult.confidence} < ${minConfidence})`;
      this.ctx.log.debug(`SkillEvolver: task "${task.title}" not worth generating skill — ${reason}`);
      this.store.setTaskSkillMeta(task.id, { skillStatus: "not_generated", skillReason: reason });
    }
  }

  private markChunksWithSkill(chunks: Chunk[], skillId: string): void {
    for (const chunk of chunks) {
      this.store.setChunkSkillId(chunk.id, skillId);
    }
    this.ctx.log.debug(`SkillEvolver: marked ${chunks.length} chunks with skill_id=${skillId}`);
  }

  private readSkillContent(skill: Skill): string | null {
    const filePath = path.join(skill.dirPath, "SKILL.md");
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch { /* fall through */ }
    const sv = this.store.getLatestSkillVersion(skill.id);
    return sv?.content ?? null;
  }
}
