import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SkillInfo {
  name: string
  description: string
  scope: 'global' | 'project'
  path: string // the skill's own directory
  fileCount: number
}

// SKILL.md's YAML frontmatter is untrusted content (someone's repo, not
// ours) — this only ever reads `name`/`description` as plain strings, never
// evaluates anything in the file.
function parseSkillFrontmatter(skillMdPath: string): { name?: string; description?: string } {
  try {
    const raw = readFileSync(skillMdPath, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
    if (!match) return {}
    const frontmatter: Record<string, string> = {}
    for (const line of match[1].split('\n')) {
      const field = /^(\w[\w-]*):\s*(.*)$/.exec(line)
      if (field) frontmatter[field[1]] = field[2].trim()
    }
    return { name: frontmatter.name, description: frontmatter.description }
  } catch {
    return {}
  }
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length
  } catch {
    return 0
  }
}

function listSkillsIn(dir: string, scope: SkillInfo['scope']): SkillInfo[] {
  if (!existsSync(dir)) return []
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: SkillInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = join(dir, entry.name)
    const skillMd = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMd)) continue
    const frontmatter = parseSkillFrontmatter(skillMd)
    skills.push({
      name: frontmatter.name ?? entry.name,
      description: frontmatter.description ?? '',
      scope,
      path: skillDir,
      fileCount: countFiles(skillDir)
    })
  }
  return skills
}

// Plan 2.2 Skills tab — "~/.claude/skills/, <project>/.claude/skills/ and
// plugin skill directories". Plugin skill directories have no documented,
// stable location (CLAUDE.md: session discovery reads undocumented
// internals), so this degrades to the two documented ones rather than
// guessing a path — same "degrade rather than break the list" principle
// CLAUDE.md asks for in claude.ts's session parsing.
export function listSkills(repoPath: string | null): SkillInfo[] {
  const global = listSkillsIn(join(homedir(), '.claude', 'skills'), 'global')
  const project = repoPath ? listSkillsIn(join(repoPath, '.claude', 'skills'), 'project') : []
  return [...global, ...project]
}

export interface CreateSkillResult {
  ok: boolean
  error?: string
  path?: string
}

// Section 2.6, "New skill" — scaffolds <scope>/.claude/skills/<name>/SKILL.md
// with valid frontmatter. `name` is untrusted (typed by the user) and never
// interpolated into a path beyond a single sanitized path segment — no
// slashes, no "..", nothing that could climb out of the skills directory,
// same spirit as files.ts's resolveProjectPath refusing anything outside a
// registered root.
export function createSkill(
  scope: 'global' | 'project',
  repoPath: string | null,
  name: string,
  description: string,
  body?: string
): CreateSkillResult {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return { ok: false, error: 'name must contain at least one letter or number' }

  const skillsDir =
    scope === 'global'
      ? join(homedir(), '.claude', 'skills')
      : repoPath && join(repoPath, '.claude', 'skills')
  if (!skillsDir) return { ok: false, error: 'no project selected for a project-scoped skill' }

  const skillDir = join(skillsDir, slug)
  if (existsSync(skillDir))
    return { ok: false, error: `a skill named "${slug}" already exists in this scope` }

  const frontmatterDescription = (
    description || 'TODO: describe when this skill should be used.'
  ).replace(/\n/g, ' ')
  const skillMd = [
    '---',
    `name: ${slug}`,
    `description: ${frontmatterDescription}`,
    '---',
    '',
    body?.trim() || `# ${name.trim()}\n\nTODO: write this skill.`,
    ''
  ].join('\n')

  try {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf8')
    return { ok: true, path: skillDir }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
