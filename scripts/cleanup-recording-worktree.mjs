#!/usr/bin/env node

// 收尾录制 worktree：把 docs/recordings/ 等产物拷回主工作树，移除 symlink，
// 然后 git worktree remove 让仓库回到干净状态。配合 prepare-recording-worktree.mjs 使用。

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

const METADATA_FILE = ".repo-demo-recorder-worktree.json"

// 默认要拷回主工作树的相对路径：录屏产物、生成的 runner 脚本、guide。
// 如果用户在 scaffold 时改了 --out，那 cleanup 也要相应加 --copy。
const DEFAULT_COPY_PATHS = ["docs/recordings", "scripts/recordings"]

const DEFAULTS = {
  worktree: null,
  noCopyDefaults: false,
  copyMode: "merge",
  keep: false
}

function printHelpAndExit() {
  console.log(`Usage: node scripts/cleanup-recording-worktree.mjs --worktree <path> [options]

收尾录制 worktree：把产物拷回主工作树、解除软链、git worktree remove。

Options:
  --worktree <path>        必填，prepare-recording-worktree.mjs 创建的 worktree 路径
  --copy <relPath>         追加要从 worktree 拷回主工作树的相对路径，可多次
  --no-copy-defaults       不拷贝默认路径（docs/recordings/、scripts/recordings/）
  --copy-mode <mode>       merge | overwrite | backup（默认 merge：保留主工作树已有文件）
  --keep                   不执行 git worktree remove，只搬产物 + 清软链（调试用）
  -h, --help               显示帮助

注意：worktree remove 默认走 --force（拷完产物后 worktree 必然 dirty）。
若想保留 worktree 状态调试，加 --keep。
`)
  process.exit(0)
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) printHelpAndExit()
  const args = { ...DEFAULTS, extraCopies: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === "--no-copy-defaults") {
      args.noCopyDefaults = true
      continue
    }
    if (token === "--keep") {
      args.keep = true
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
    if (key === "copy") {
      args.extraCopies.push(value)
    } else if (key === "worktree") {
      args.worktree = value
    } else if (key === "copy-mode") {
      args.copyMode = value
    } else {
      throw new Error(`不支持的参数：${token}`)
    }
    i += 1
  }
  if (!args.worktree) throw new Error("--worktree 是必需的")
  const allowedModes = new Set(["merge", "overwrite", "backup"])
  if (!allowedModes.has(args.copyMode)) {
    throw new Error(`--copy-mode 必须是 ${Array.from(allowedModes).join(" / ")}`)
  }
  return args
}

function git(root, gitArgs) {
  return spawnSync("git", ["-C", root, ...gitArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
}

function gitOk(root, gitArgs) {
  const result = git(root, gitArgs)
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} 失败：${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

async function readMetadata(worktreePath) {
  const metadataPath = path.join(worktreePath, METADATA_FILE)
  if (!existsSync(metadataPath)) {
    throw new Error(
      `worktree 内找不到 ${METADATA_FILE}：${worktreePath}\n` +
        `这看起来不是 prepare-recording-worktree.mjs 创建的 worktree。` +
        `若确认要清理，请手动跑 git worktree remove。`
    )
  }
  const text = await readFile(metadataPath, "utf8")
  const data = JSON.parse(text)
  if (data?.schema !== "repo-demo-recorder/worktree.v1") {
    throw new Error(`不识别的元数据 schema：${data?.schema}`)
  }
  return data
}

async function copyArtifacts(worktreePath, mainPath, relPaths, mode) {
  const copied = []
  const skipped = []
  for (const rel of relPaths) {
    const src = path.join(worktreePath, rel)
    const dst = path.join(mainPath, rel)
    if (!existsSync(src)) {
      skipped.push({ rel, reason: "worktree 中无该路径" })
      continue
    }
    if (existsSync(dst)) {
      if (mode === "backup") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const backup = `${dst}.backup.${stamp}`
        await cp(dst, backup, { recursive: true })
        await rm(dst, { recursive: true, force: true })
      } else if (mode === "overwrite") {
        await rm(dst, { recursive: true, force: true })
      }
      // merge 模式不动主工作树已有文件，cp 用 force=true 但 errorOnExist=false 让冲突时覆盖单文件
    }
    await mkdir(path.dirname(dst), { recursive: true })
    await cp(src, dst, { recursive: true, force: true, errorOnExist: false })
    copied.push(rel)
  }
  return { copied, skipped }
}

async function unlinkSymlinks(worktreePath, linkedPaths) {
  const removed = []
  const skipped = []
  for (const rel of linkedPaths) {
    const link = path.join(worktreePath, rel)
    if (!existsSync(link)) {
      // existsSync follows symlinks; lstat 才看 symlink 本身
      try {
        lstatSync(link)
      } catch {
        skipped.push({ rel, reason: "已不存在" })
        continue
      }
    }
    try {
      const stat = lstatSync(link)
      if (!stat.isSymbolicLink()) {
        skipped.push({ rel, reason: "不是软链（可能用户改过），跳过避免误删" })
        continue
      }
      await unlink(link)
      removed.push(rel)
    } catch (error) {
      skipped.push({ rel, reason: `删除失败：${error.message}` })
    }
  }
  return { removed, skipped }
}

async function removeGitExcludeEntry(record) {
  if (!record?.file || !record?.pattern) return false
  if (!existsSync(record.file)) return false
  const text = await readFile(record.file, "utf8")
  const lines = text.split(/\r?\n/)
  const filtered = []
  let removed = false
  for (const line of lines) {
    if (!removed && line.trim() === record.pattern.trim()) {
      removed = true
      continue
    }
    filtered.push(line)
  }
  if (!removed) return false
  // 去掉尾部多余空行
  while (filtered.length > 0 && filtered[filtered.length - 1] === "") filtered.pop()
  const next = filtered.length > 0 ? `${filtered.join("\n")}\n` : ""
  await writeFile(record.file, next)
  return true
}

async function tryRmEmptyDir(dir) {
  try {
    const entries = await readdir(dir)
    if (entries.length === 0) {
      await rmdir(dir)
      return true
    }
  } catch {
    // 目录不存在或不为空，忽略
  }
  return false
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const worktreePath = path.resolve(args.worktree)
  if (!existsSync(worktreePath)) {
    throw new Error(`worktree 路径不存在：${worktreePath}`)
  }

  const metadata = await readMetadata(worktreePath)
  const mainPath = metadata.mainPath
  if (!existsSync(mainPath)) {
    throw new Error(`元数据里的主工作树路径已不存在：${mainPath}`)
  }

  const worktreeList = gitOk(mainPath, ["worktree", "list", "--porcelain"])
  if (!worktreeList.split(/\r?\n/).some((line) => line.startsWith(`worktree ${worktreePath}`))) {
    throw new Error(
      `git worktree list 中没有 ${worktreePath}。\n` +
        `可能 worktree 已被外部命令移除，或 metadata 中的 worktreePath 与实际不一致。`
    )
  }

  const copyPaths = []
  if (!args.noCopyDefaults) copyPaths.push(...DEFAULT_COPY_PATHS)
  copyPaths.push(...args.extraCopies)
  const dedupedCopyPaths = Array.from(new Set(copyPaths.filter(Boolean)))

  const copyResult = await copyArtifacts(worktreePath, mainPath, dedupedCopyPaths, args.copyMode)
  console.log(
    `已拷回主工作树：${copyResult.copied.length > 0 ? copyResult.copied.join(", ") : "(无)"}`
  )
  for (const skip of copyResult.skipped) {
    console.warn(`[cleanup-worktree] 跳过 ${skip.rel}：${skip.reason}`)
  }

  const unlinkResult = await unlinkSymlinks(worktreePath, metadata.linkedPaths || [])
  if (unlinkResult.removed.length > 0) {
    console.log(`已解除软链：${unlinkResult.removed.join(", ")}`)
  }
  for (const skip of unlinkResult.skipped) {
    console.warn(`[cleanup-worktree] 软链 ${skip.rel} 未处理：${skip.reason}`)
  }

  if (args.keep) {
    console.log(
      `保留 worktree（--keep）：${worktreePath}\n` +
        `如要彻底清理：git -C ${mainPath} worktree remove --force ${worktreePath}`
    )
    return
  }

  // 删元数据文件，避免被 worktree remove 当成 dirty
  try {
    await rm(path.join(worktreePath, METADATA_FILE), { force: true })
  } catch {
    // ignore
  }

  // 拷贝完产物后 worktree 一定 dirty（含 untracked artifact 和 carried 改动），
  // 走 --force 让 cleanup 一直可收尾。需要保留状态时用户应加 --keep。
  const removeArgs = ["worktree", "remove", "--force", worktreePath]
  const removeResult = git(mainPath, removeArgs)
  if (removeResult.status !== 0) {
    throw new Error(
      `git worktree remove --force 失败：${removeResult.stderr || removeResult.stdout}`
    )
  }
  console.log(`已删除 worktree：${worktreePath}`)

  // 默认路径下 .repo-demo-recorder/worktrees/ 父目录为空时一并清理，让主工作树彻底干净
  if (metadata.defaultParentCleanup) {
    const removedWorktreesDir = await tryRmEmptyDir(metadata.defaultParentCleanup)
    if (removedWorktreesDir) {
      const upper = path.dirname(metadata.defaultParentCleanup)
      await tryRmEmptyDir(upper)
    }
  }

  if (metadata.gitExclude) {
    const excludeRemoved = await removeGitExcludeEntry(metadata.gitExclude)
    if (excludeRemoved) {
      console.log(`已从 ${metadata.gitExclude.file} 移除 pattern ${metadata.gitExclude.pattern}`)
    }
  }

  console.log("cleanup 完成")
}

try {
  await main()
} catch (error) {
  console.error(`[cleanup-worktree] ${error.message}`)
  process.exit(1)
}
