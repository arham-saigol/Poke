import fs from "node:fs";
import path from "node:path";
import { audit, ensureDir, getPokePaths, safeResolve } from "@poke/storage";
import type { SkillMetadata } from "@poke/shared";

export function seedBundledSkills(paths = getPokePaths()): void {
  ensureDir(paths.enabledSkills);
  ensureSkill(path.join(paths.enabledSkills, "skill-creator"), skillCreatorContent());
  ensureSkill(path.join(paths.enabledSkills, "poke"), pokeSkillContent());
}

export function listSkills(paths = getPokePaths()): SkillMetadata[] {
  seedBundledSkills(paths);
  return [
    ...readSkillDir(paths.enabledSkills, true),
    ...readSkillDir(paths.disabledSkills, false)
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name: string, paths = getPokePaths()): { metadata: SkillMetadata; content: string } {
  const match = listSkills(paths).find((skill) => skill.name === name);
  if (!match) throw new Error(`Skill not found: ${name}`);
  return { metadata: match, content: fs.readFileSync(path.join(match.path, "SKILL.md"), "utf8") };
}

export function setSkillEnabled(name: string, enabled: boolean, paths = getPokePaths()): SkillMetadata {
  seedBundledSkills(paths);
  const sourceRoot = enabled ? paths.disabledSkills : paths.enabledSkills;
  const targetRoot = enabled ? paths.enabledSkills : paths.disabledSkills;
  const source = safeResolve(sourceRoot, name);
  const target = safeResolve(targetRoot, name);
  if (!fs.existsSync(source)) throw new Error(`Skill not found in ${enabled ? "disabled" : "enabled"} folder: ${name}`);
  ensureDir(targetRoot);
  fs.renameSync(source, target);
  audit(enabled ? "skill.enable" : "skill.disable", name);
  return parseSkill(target, enabled);
}

export function deleteSkill(name: string, paths = getPokePaths()): void {
  for (const root of [paths.enabledSkills, paths.disabledSkills]) {
    const candidate = safeResolve(root, name);
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
      audit("skill.delete", name);
      return;
    }
  }
}

function ensureSkill(dir: string, content: string): void {
  ensureDir(dir);
  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    fs.writeFileSync(skillFile, content, "utf8");
  }
}

function readSkillDir(root: string, enabled: boolean): SkillMetadata[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => parseSkill(path.join(root, entry.name), enabled));
}

function parseSkill(dir: string, enabled: boolean): SkillMetadata {
  const raw = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  const { frontmatter } = parseFrontmatter(raw);
  return {
    name: frontmatter.name ?? path.basename(dir),
    description: frontmatter.description ?? "No description provided.",
    source: "user",
    enabled,
    path: dir
  };
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of raw.slice(4, end).trim().split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    frontmatter[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  return { frontmatter, body: raw.slice(end + 4).trim() };
}

function skillCreatorContent(): string {
  return `---
name: skill-creator
description: Create or improve Poke skills using the SKILL.md format.
---

# Skill Creator

Use this skill when the user asks Poke to create, modify, package, or review an agent skill.

Create skills under \`~/.poke/skills/enabled/<skill-name>/SKILL.md\` unless the user asks for a disabled draft, in which case use \`~/.poke/skills/disabled/<skill-name>/SKILL.md\`.

A Poke skill must include YAML frontmatter with:

\`\`\`yaml
name: short-skill-name
description: Clear trigger description for when Poke should load the skill.
\`\`\`

Keep skills focused. Include scripts or reference files only when they materially improve repeatability. Do not include eval instructions that require infrastructure Poke does not have.
`;
}

function pokeSkillContent(): string {
  return `---
name: poke
description: Manage Poke itself: automations, skills, updates, memory cleanup, connectors, and workspace conventions.
---

# Poke Operations

Use this skill when the user asks Poke to manage Poke's own configuration or runtime.

## Automations

Automations live at \`~/.poke/automations.json\`. Validate the JSON against the automation schema before saving. Use recurring cron schedules for repeated work and ISO datetime \`at\` schedules for one-time work.

## Skills

Enabled skills live under \`~/.poke/skills/enabled\`. Disabled skills live under \`~/.poke/skills/disabled\`. To install a skill, inspect its \`SKILL.md\`, verify the name and description, then copy it into the enabled folder. Keep discovery concise: search known skill registries, inspect before install, and avoid installing broad or duplicative skills.

## Updates

Use \`poke update\` for self-updates. It creates a backup, pulls code, installs dependencies, migrates local state, and restarts the daemon.

## Memory Cleanup

Use \`poke memory cleanup\` to run the cleanup pipeline. Review generated reports before making manual follow-up edits.

## Workspace

User-visible work products should be placed in \`~/.poke/workspace\` unless a task specifically requires another location.
`;
}
