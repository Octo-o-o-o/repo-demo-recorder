#!/usr/bin/env node

import { cp, mkdir, rm, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), "..")

function defaultDest(target) {
  const home = os.homedir()
  if (target === "claude") {
    return path.join(home, ".claude", "skills", "repo-demo-recorder")
  }
  // codex（默认）
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, "skills", "repo-demo-recorder")
    : path.join(home, ".codex", "skills", "repo-demo-recorder")
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/install-skill.mjs [options]

Options:
  --dest <dir>     Install destination (overrides --target)
  --target <name>  codex (default) | claude — pick a known skill home
                   codex:   $CODEX_HOME/skills/repo-demo-recorder or ~/.codex/skills/repo-demo-recorder
                   claude:  ~/.claude/skills/repo-demo-recorder (Claude Code user-level skill)
  --force          Overwrite existing destination
  --dry-run        Print files that would be copied
`)
    process.exit(0)
  }
  const args = {
    target: "codex",
    dest: null,
    force: false,
    dryRun: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--force") {
      args.force = true
      continue
    }
    if (token === "--dry-run") {
      args.dryRun = true
      continue
    }
    if (!token.startsWith("--")) throw new Error(`Unknown argument: ${token}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`)
    if (token === "--dest") args.dest = value
    else if (token === "--target") {
      if (!["codex", "claude"].includes(value)) {
        throw new Error(`--target must be one of: codex, claude (received: ${value})`)
      }
      args.target = value
    } else throw new Error(`Unknown argument: ${token}`)
    index += 1
  }

  if (!args.dest) {
    args.dest = defaultDest(args.target)
  }
  return args
}

async function copyRuntimeFile(sourceRelativePath, destRoot, dryRun) {
  const sourcePath = path.join(repoRoot, sourceRelativePath)
  const destPath = path.join(destRoot, sourceRelativePath)
  if (!existsSync(sourcePath)) return
  if (dryRun) {
    console.log(`[dry-run] copy ${sourceRelativePath}`)
    return
  }
  await mkdir(path.dirname(destPath), { recursive: true })
  const sourceStat = await stat(sourcePath)
  await cp(sourcePath, destPath, { recursive: sourceStat.isDirectory() })
}

const args = parseArgs(process.argv.slice(2))
const destRoot = path.resolve(args.dest)

if (existsSync(destRoot)) {
  if (!args.force) {
    throw new Error(`Destination already exists. Re-run with --force to overwrite: ${destRoot}`)
  }
  if (!args.dryRun) await rm(destRoot, { recursive: true, force: true })
}

if (!args.dryRun) await mkdir(destRoot, { recursive: true })

// 复制 skill 运行时需要的全部资源。
// - SKILL.md / references / scripts：skill 的核心
// - agents/openai.yaml：Codex 的可选 manifest（Claude Code 会忽略，无副作用）
// - scripts/templates：scaffold-repo-demo.mjs 运行时会读取这里的 playwright runner template
for (const item of ["SKILL.md", "agents", "references", "scripts"]) {
  await copyRuntimeFile(item, destRoot, args.dryRun)
}

if (args.dryRun) {
  console.log(`[dry-run] Would install repo-demo-recorder skill to ${destRoot}`)
} else {
  console.log(`Installed repo-demo-recorder skill to ${destRoot}`)
}
