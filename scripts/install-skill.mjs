#!/usr/bin/env node

import { cp, mkdir, rm, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), "..")

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: node scripts/install-skill.mjs [options]

Options:
  --dest <dir>   Install destination (default: $CODEX_HOME/skills/repo-demo-recorder or ~/.codex/skills/repo-demo-recorder)
  --force        Overwrite existing destination
  --dry-run      Print files that would be copied
`)
    process.exit(0)
  }
  const args = {
    dest: process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, "skills", "repo-demo-recorder")
      : path.join(os.homedir(), ".codex", "skills", "repo-demo-recorder"),
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
    else throw new Error(`Unknown argument: ${token}`)
    index += 1
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

for (const item of ["SKILL.md", "agents", "assets", "references", "scripts"]) {
  await copyRuntimeFile(item, destRoot, args.dryRun)
}

console.log(`Installed repo-demo-recorder skill to ${destRoot}`)
