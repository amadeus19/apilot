#!/usr/bin/env node
/**
 * 标签触发的本地发版：校验（标签 ↔ 双版本源 ↔ 干净工作区）→ 签名构建 → 发布到本机更新源。
 *
 * 由 .githooks/reference-transaction 在创建 refs/tags/v* 标签时自动调用；
 * 钩子失败后也可手动重跑：
 *   node app/scripts/release-on-tag.mjs v0.1.6
 *
 * 环境变量：
 *   TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD —— 签名密钥（见 scripts/publish-update.mjs 前置说明）
 *   APILOT_UPDATE_SOURCE_ROOT 或 git config apilot.updateSourceRoot —— 更新源根目录
 *   RELEASE_DRY_RUN=1 —— 只打印计划不构建（联调用；签名密钥/更新源缺失降级为状态展示）
 *   RELEASE_ALLOW_DIRTY=1 —— 联调时跳过干净工作区硬校验
 * 零第三方依赖。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONF_PATH = join(WORKSPACE_ROOT, 'apps/web/src-tauri/tauri.conf.json')
const CARGO_PATH = join(WORKSPACE_ROOT, 'apps/web/src-tauri/Cargo.toml')
// 基点＝apps/web（tauri CLI 在 web 包内执行，相对路径从该目录解析）
const OVERRIDE_CONFIG = '../../scripts/updater-build-override.json'

const fail = (message) => {
  console.error(`[release] 错误：${message}`)
  process.exit(1)
}

/** 捕获输出的 git 子调用（工作目录＝工作区根） */
const git = (...args) => spawnSync('git', args, { cwd: WORKSPACE_ROOT, encoding: 'utf8' })

const dryRun = process.env.RELEASE_DRY_RUN === '1'
const tag = process.argv[2]
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) fail(`标签须形如 vX.Y.Z，收到：${tag ?? '(空)'}`)
const version = tag.slice(1)

// —— 版本一致性：标签 ↔ tauri.conf.json ↔ Cargo.toml（双源手工同步在这里被拦下）——
const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8'))
if (conf.version !== version) fail(`版本不一致：标签 ${tag} ↔ tauri.conf.json ${conf.version}`)
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(CARGO_PATH, 'utf8'))?.[1]
if (cargoVersion !== version) fail(`版本不一致：标签 ${tag} ↔ Cargo.toml ${cargoVersion}`)

// —— 干净工作区：标签指向 HEAD，未提交改动会混入安装包 ——
if (process.env.RELEASE_ALLOW_DIRTY !== '1') {
  const dirty = git('status', '--porcelain').stdout.trim()
  if (dirty) fail(`工作区不干净（未提交改动会混入安装包，先提交或贮藏）：\n${dirty}`)
}

// —— 环境前置：签名密钥 + 更新源根目录（dry run 降级为状态展示）——
const hasKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY)
const sourceRoot =
  process.env.APILOT_UPDATE_SOURCE_ROOT?.trim() ||
  git('config', '--get', 'apilot.updateSourceRoot').stdout.trim()
if (!dryRun) {
  if (!hasKey)
    fail('缺少 TAURI_SIGNING_PRIVATE_KEY（minisign 私钥环境变量）')
  if (!sourceRoot)
    fail('未配置更新源根目录：git config apilot.updateSourceRoot <路径> 或导出 APILOT_UPDATE_SOURCE_ROOT')
}

// —— 标签附注作为更新说明（轻量标签为空则回退默认文案）——
const notes = git('tag', '-l', '--format=%(contents)', tag).stdout.trim() || `${tag} 版本更新`

if (dryRun) {
  console.log(`[release] DRY RUN ${tag}：`)
  console.log(`  版本一致：tauri.conf.json = Cargo.toml = ${version} ✓`)
  console.log(`  签名密钥：${hasKey ? '已设置' : '未设置（实发会被拦截）'}`)
  console.log(`  更新源根目录：${sourceRoot || '未配置（实发会被拦截）'}`)
  console.log(`  工作目录：${WORKSPACE_ROOT}`)
  console.log(`  计划 → pnpm tauri build --config ${OVERRIDE_CONFIG}`)
  console.log(`  计划 → node scripts/publish-update.mjs "${sourceRoot || '(未配置)'}" --notes "…"`)
  process.exit(0)
}

if (!existsSync(join(WORKSPACE_ROOT, 'scripts', 'updater-build-override.json')))
  fail(`缺少覆盖配置：app/scripts/updater-build-override.json`)

const run = (command, args) => {
  console.log(`\n[release] $ ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
    shell: true, // Windows 下 pnpm 是 .cmd，须经 shell 解析
  })
  if (result.status !== 0)
    fail(`命令失败（退出码 ${result.status}），发版中止：${command} ${args.join(' ')}`)
}

run('pnpm', ['tauri', 'build', '--config', OVERRIDE_CONFIG])
run('node', ['scripts/publish-update.mjs', sourceRoot, '--notes', notes])

console.log(`\n[release] ${tag} 已发布到更新源：${sourceRoot}`)
