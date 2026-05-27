#!/usr/bin/env node

// 在目标项目里新开一个 git worktree，作为"录制环境"，让 scaffold、runner、TTS、封面、validate
// 等步骤跑在隔离工作树里，不污染主工作树的 dirty state、不需要主工作树退出当前分支。
// 默认会把 node_modules / 非生产 .env* 软链过去，避免新 worktree 走一遍完整 install。
// cleanup 由 scripts/cleanup-recording-worktree.mjs 负责，会把产物拷回主工作树后 git worktree remove。

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const DEFAULTS = {
  root: ".",
  name: null,
  worktreeDir: null,
  base: "HEAD",
  includeUncommitted: false,
  noLinkDefaults: false,
  outputJson: null,
  force: false
}

// node_modules 必 link，避免 worktree 走完整 install；非生产 .env* 默认 link，保证 dev/test server 起得来。
// .env.production* 不默认 link 或 carry，避免 mock/staging 录制环境意外接触生产凭据；确需生产录制时显式 --link。
// dist / .next / .vite 等构建缓存不默认 link：万一与主工作树并行启动会互相覆盖。
const DEFAULT_LINKS = [
  "node_modules",
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.test.local"
]

const DEFAULT_CARRY_EXCLUDES = [
  ...DEFAULT_LINKS,
  ".env.production",
  ".env.production.local"
]

const METADATA_FILE = ".repo-demo-recorder-worktree.json"

function printHelpAndExit() {
  console.log(`Usage: node scripts/prepare-recording-worktree.mjs [options]

为目标项目创建一个隔离录制工作树。脚本会：
  1. 校验 --root 是 git 工作树
  2. 用 git worktree add --detach 在指定路径创建工作树
  3. 把 node_modules / 非生产 .env* 软链过去（可关；.env.production* 需显式 --link）
  4. 可选把当前未提交改动（staged + unstaged + untracked）带到工作树
  5. 写入元数据文件 ${METADATA_FILE}，供 cleanup-recording-worktree.mjs 读取

Options:
  --root <dir>             目标项目根目录（默认：当前目录）
  --name <name>            本次录制的标识（用来命名 worktree 目录），必须提供
  --worktree-dir <path>    显式指定 worktree 路径；不传则默认放在
                           <root>/.repo-demo-recorder/worktrees/<name>
  --base <ref>             从哪个 ref 创建 worktree，默认 HEAD（detached）
  --include-uncommitted    把 root 当前 staged+unstaged+untracked 改动也搬到 worktree
  --link <relPath>         追加要从主工作树软链到 worktree 的相对路径，可多次指定
                           若确需生产环境变量，必须显式 --link .env.production.local
  --no-link-defaults       不软链 node_modules / .env* 等默认项
  --output-json <path>     把结果元数据写到该文件（额外于 stdout 的 JSON 行）
  --force                  worktreeDir 已存在时先 git worktree remove --force 再重建
  -h, --help               显示帮助

输出（stdout 最后一行）：
  {"worktreePath":"...","mainPath":"...","linkedPaths":[...],"carriedUncommitted":bool}
`)
  process.exit(0)
}

function normalizeSafeRelativePath(value, flagName) {
  const raw = String(value || "").trim()
  if (!raw) throw new Error(`${flagName} 不能为空`)
  if (raw.includes("\0")) throw new Error(`${flagName} 不能包含 NUL 字符`)
  if (path.isAbsolute(raw)) throw new Error(`${flagName} 必须是相对路径，不能是绝对路径：${raw}`)
  const normalized = path.normalize(raw).split(path.sep).join("/")
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${flagName} 必须留在项目根目录内，不能指向项目外：${raw}`)
  }
  return normalized
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) printHelpAndExit()

  const args = { ...DEFAULTS, extraLinks: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === "--include-uncommitted") {
      args.includeUncommitted = true
      continue
    }
    if (token === "--no-link-defaults") {
      args.noLinkDefaults = true
      continue
    }
    if (token === "--force") {
      args.force = true
      continue
    }
    if (!token.startsWith("--")) {
      throw new Error(`无法识别参数：${token}`)
    }
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 ${token} 缺少取值`)
    }
    if (key === "link") {
      args.extraLinks.push(normalizeSafeRelativePath(value, "--link"))
    } else {
      const camel = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
      args[camel] = value
    }
    i += 1
  }

  if (!args.name) {
    throw new Error("--name 是必需的，用来命名 worktree 目录和 metadata")
  }
  args.name = String(args.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!args.name) {
    throw new Error("--name 必须包含至少一个字母/数字/汉字")
  }
  return args
}

function git(root, gitArgs, options = {}) {
  return spawnSync("git", ["-C", root, ...gitArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  })
}

function gitOk(root, gitArgs, options = {}) {
  const result = git(root, gitArgs, options)
  if (result.status !== 0) {
    throw new Error(
      `git ${gitArgs.join(" ")} (cwd=${root}) failed:\n${result.stderr || result.stdout}`
    )
  }
  return result.stdout.trim()
}

function isGitWorkTree(root) {
  const result = git(root, ["rev-parse", "--is-inside-work-tree"])
  return result.status === 0 && result.stdout.trim() === "true"
}

function listWorktrees(root) {
  const out = gitOk(root, ["worktree", "list", "--porcelain"])
  const entries = []
  let current = null
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current)
      current = { worktree: line.slice("worktree ".length).trim() }
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length).trim()
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim()
    } else if (line === "detached" && current) {
      current.detached = true
    }
  }
  if (current) entries.push(current)
  return entries
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

// 把 .repo-demo-recorder/ 加进 .git/info/exclude，避免主工作树 git status 里出现"untracked .repo-demo-recorder/"。
// worktree add 自身已经让 worktree 子目录被 git 视为外部 work tree 而忽略，但父目录是普通 untracked dir。
// .git/info/exclude 是 per-repo 的，不需要 commit。返回值标识本次是否真的写入，cleanup 时只会移除自己加的行。
async function addToGitExclude(mainRoot, pattern) {
  const commonDir = gitOk(mainRoot, ["rev-parse", "--git-common-dir"])
  const excludeFile = path.isAbsolute(commonDir)
    ? path.join(commonDir, "info", "exclude")
    : path.join(mainRoot, commonDir, "info", "exclude")
  await ensureDir(path.dirname(excludeFile))
  let existing = ""
  try {
    existing = await readFile(excludeFile, "utf8")
  } catch {
    existing = ""
  }
  const lines = existing.split(/\r?\n/).map((line) => line.trim())
  if (lines.includes(pattern)) {
    return { excludeFile, added: false }
  }
  const newContent = `${existing.replace(/\s*$/, "")}\n${pattern}\n`
  await writeFile(excludeFile, newContent)
  return { excludeFile, added: true }
}

async function symlinkSafe(target, linkPath) {
  // node 在 win 上要求 type=junction；这里假设 unix-like。
  await symlink(target, linkPath, "dir")
}

async function linkDefaults(mainRoot, worktreePath, extras, useDefaults) {
  const linked = []
  const candidates = useDefaults ? [...DEFAULT_LINKS, ...extras] : [...extras]
  const seen = new Set()
  for (const rel of candidates) {
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    const src = path.join(mainRoot, rel)
    const dst = path.join(worktreePath, rel)
    if (!existsSync(src)) continue
    // worktree add 应该不会在 worktree 里出现这些文件（它们是 ignored），但保险起见再判一次
    if (existsSync(dst)) {
      console.warn(
        `[prepare-worktree] worktree 已存在 ${rel}，跳过软链。若是构建缓存，手动确认是否需要清理。`
      )
      continue
    }
    await ensureDir(path.dirname(dst))
    try {
      await symlinkSafe(src, dst)
      linked.push(rel)
    } catch (error) {
      console.warn(`[prepare-worktree] 软链 ${rel} 失败：${error.message}`)
    }
  }
  return linked
}

async function carryUncommitted(mainRoot, worktreePath, skipRelPaths = []) {
  // 思路：HEAD..工作树 的 diff（staged + unstaged）用 patch 还原；untracked 文件直接 cp。
  const stagedAndUnstaged = git(mainRoot, ["diff", "HEAD", "--binary", "--no-color"])
  if (stagedAndUnstaged.status !== 0) {
    throw new Error(
      `git diff HEAD 失败（用于 --include-uncommitted）：${stagedAndUnstaged.stderr || stagedAndUnstaged.stdout}`
    )
  }
  const patch = stagedAndUnstaged.stdout
  let appliedPatch = false
  if (patch && patch.trim().length > 0) {
    const tempDir = await mkdtemp(path.join(tmpdir(), "repo-demo-recorder-patch-"))
    const patchPath = path.join(tempDir, "uncommitted.patch")
    try {
      await writeFile(patchPath, patch)
      const apply = git(worktreePath, ["apply", "--whitespace=nowarn", patchPath])
      if (apply.status !== 0) {
        throw new Error(
          `把未提交改动 apply 到 worktree 失败：${apply.stderr || apply.stdout}\n` +
            `主工作树可能含 worktree 缺少的二进制/重命名/冲突情况，建议手动 commit 一笔临时改动再开 worktree。`
        )
      }
      appliedPatch = true
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  // untracked（包含未 git add 的新文件）；不带 --directory 避免 hash 整个 node_modules。
  const untracked = git(mainRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
  if (untracked.status !== 0) {
    throw new Error(
      `git ls-files --others 失败：${untracked.stderr || untracked.stdout}`
    )
  }
  // worktree 本身可能也在 ls-files 输出里（路径在主工作树内），过滤掉避免 cp 递归自身。
  const worktreeRelFromMain = path.relative(mainRoot, worktreePath)
  const worktreeRelPosix = worktreeRelFromMain.split(path.sep).join("/")
  const isInsideWorktree = (rel) => {
    if (!worktreeRelPosix || worktreeRelPosix.startsWith("..")) return false
    const r = rel.split(path.sep).join("/")
    return r === worktreeRelPosix || r.startsWith(`${worktreeRelPosix}/`)
  }
  // 默认 link 路径（node_modules / .env*）应该靠 symlink 共享，不要 cp 整份过去。
  // 真实项目通常已 gitignore 这些，但 smoke / 新仓库可能没有；这里多一层 robust 保护。
  const skipSet = new Set(skipRelPaths)
  const skipPrefixes = skipRelPaths.map((p) => `${p.replace(/\/+$/, "")}/`)
  const isSkipped = (rel) => {
    const r = rel.split(path.sep).join("/")
    if (skipSet.has(r)) return true
    return skipPrefixes.some((prefix) => r.startsWith(prefix))
  }
  const untrackedList = untracked.stdout
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((rel) => !isInsideWorktree(rel) && !isSkipped(rel))
  let copiedUntracked = 0
  for (const rel of untrackedList) {
    const src = path.join(mainRoot, rel)
    const dst = path.join(worktreePath, rel)
    if (!existsSync(src)) continue
    await ensureDir(path.dirname(dst))
    await cp(src, dst, { recursive: true })
    copiedUntracked += 1
  }
  return { appliedPatch, copiedUntracked }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(args.root)
  if (!existsSync(root)) throw new Error(`--root 不存在：${root}`)
  if (!isGitWorkTree(root)) {
    throw new Error(
      `--root 不是 git 工作树：${root}\n` +
        `不在 git 仓库中无法用 git worktree 隔离。请直接在原目录运行 scaffold-repo-demo.mjs，` +
        `或先 git init 再重试。`
    )
  }

  const mainPath = gitOk(root, ["rev-parse", "--show-toplevel"])

  const defaultWorktreeDir = path.join(
    mainPath,
    ".repo-demo-recorder",
    "worktrees",
    args.name
  )
  const worktreePath = path.resolve(args.worktreeDir || defaultWorktreeDir)

  // 主工作树内的子路径作为 worktree 是允许的，但禁止指向 main 本身或其子路径中已被跟踪的目录。
  if (worktreePath === mainPath) {
    throw new Error(`worktree 路径不能等于主工作树：${worktreePath}`)
  }
  if (existsSync(worktreePath)) {
    const existing = listWorktrees(mainPath).find((entry) => entry.worktree === worktreePath)
    if (existing && !args.force) {
      throw new Error(
        `worktree 已存在：${worktreePath}\n` +
          `加 --force 会先 git worktree remove --force 再重建，否则可直接 cd 进去复用。`
      )
    }
    if (existing && args.force) {
      const removed = git(mainPath, ["worktree", "remove", "--force", worktreePath])
      if (removed.status !== 0) {
        throw new Error(`git worktree remove --force 失败：${removed.stderr || removed.stdout}`)
      }
    } else if (!existing) {
      // 路径存在但不是 worktree —— 不动用户的数据。
      throw new Error(
        `路径已存在且不是 git worktree：${worktreePath}\n` +
          `请换一个 --worktree-dir 或手动确认后删除。`
      )
    }
  }

  await ensureDir(path.dirname(worktreePath))

  // 必须在 git worktree add 之前完成 exclude 注册：否则 carry 时 ls-files 会把新建的 worktree
  // 子目录当成 untracked 输出，cp 会递归自我拷贝（曾在 smoke 中触发 EINVAL）。
  let gitExcludeRecord = { excludeFile: null, added: false }
  const usingDefaultPath = !args.worktreeDir
  if (usingDefaultPath) {
    try {
      gitExcludeRecord = await addToGitExclude(mainPath, "/.repo-demo-recorder/")
    } catch (error) {
      console.warn(
        `[prepare-worktree] 自动写 .git/info/exclude 失败：${error.message}。` +
          `不影响录制，但主工作树 git status 里会出现 .repo-demo-recorder/。`
      )
    }
  }

  const addResult = git(mainPath, ["worktree", "add", "--detach", worktreePath, args.base])
  if (addResult.status !== 0) {
    throw new Error(
      `git worktree add 失败：${addResult.stderr || addResult.stdout}\n` +
        `常见原因：base ref 不存在、磁盘空间不足、worktree 已存在但 git 不知道。`
    )
  }

  // 主工作树 dirty 状态提示
  const status = gitOk(mainPath, ["status", "--porcelain"])
  const hasUncommitted = status.length > 0
  let carriedUncommitted = false
  // carry 时跳过默认 link 路径，让它们走 symlink，而不是 cp 整个 node_modules 过去。
  const skipForCarry = [...DEFAULT_CARRY_EXCLUDES, ...args.extraLinks]
  if (hasUncommitted) {
    if (args.includeUncommitted) {
      const carried = await carryUncommitted(mainPath, worktreePath, skipForCarry)
      carriedUncommitted = carried.appliedPatch || carried.copiedUntracked > 0
      console.log(
        `[prepare-worktree] 已把未提交改动搬到 worktree（patch=${carried.appliedPatch}, untracked=${carried.copiedUntracked}）`
      )
    } else {
      console.warn(
        `[prepare-worktree] 主工作树有未提交改动（${status.split(/\r?\n/).length} 项），` +
          `worktree 是基于 ${args.base} 创建的，不包含这些改动。\n` +
          `如需 carry 改动，重跑时加 --include-uncommitted；如需录制的就是这些改动，` +
          `建议先 git commit 一笔临时提交再开 worktree。`
      )
    }
  }

  const linkedPaths = await linkDefaults(
    mainPath,
    worktreePath,
    args.extraLinks,
    !args.noLinkDefaults
  )

  const metadata = {
    schema: "repo-demo-recorder/worktree.v1",
    name: args.name,
    createdAt: new Date().toISOString(),
    worktreePath,
    mainPath,
    base: args.base,
    linkedPaths,
    carriedUncommitted,
    defaultParentCleanup: usingDefaultPath
      ? path.join(mainPath, ".repo-demo-recorder", "worktrees")
      : null,
    gitExclude: gitExcludeRecord.added
      ? { file: gitExcludeRecord.excludeFile, pattern: "/.repo-demo-recorder/" }
      : null
  }
  await writeFile(
    path.join(worktreePath, METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`
  )

  if (args.outputJson) {
    await ensureDir(path.dirname(path.resolve(args.outputJson)))
    await writeFile(path.resolve(args.outputJson), `${JSON.stringify(metadata, null, 2)}\n`)
  }

  console.log(`已创建录制 worktree：${worktreePath}`)
  if (linkedPaths.length > 0) {
    console.log(`已软链：${linkedPaths.join(", ")}`)
  }
  console.log(
    `下一步：cd ${worktreePath} && node <skill>/scripts/scaffold-repo-demo.mjs --root . --name <flow> ...`
  )
  // stdout 最后一行的 JSON 让自动化脚本能直接解析
  console.log(JSON.stringify(metadata))
}

try {
  await main()
} catch (error) {
  console.error(`[prepare-worktree] ${error.message}`)
  process.exit(1)
}
