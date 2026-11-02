#!/usr/bin/env node
/**
 * 发包脚本：把一次 tauri build 的签名产物放进本机文件夹更新源。
 *
 * 布局约定：
 *   <更新源根>/manifest.json            ← 唯一入口清单
 *   <更新源根>/releases/<版本>/         ← 包文件 + .sig（append-only）
 *
 * 用法：
 *   node scripts/publish-update.mjs <更新源根目录> [--notes "更新说明"] [--required]
 *
 * 前置（一次性 + 每次发版）：
 *   pnpm tauri signer generate -- -w ~/.tauri/apilot.key
 *   tauri.conf.json 开 bundle.createUpdaterArtifacts: true
 *   TAURI_SIGNING_PRIVATE_KEY=... TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... pnpm tauri build
 *
 * 零第三方依赖（node:crypto / node:fs / node:path）。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONF_PATH = join(REPO_ROOT, 'apps/web/src-tauri/tauri.conf.json')
const BUNDLE_NSIS = join(REPO_ROOT, 'apps/web/src-tauri/target/release/bundle/nsis')
const PLATFORM_KEY = 'windows-x86_64'

/** 最小 SemVer 校验（清单 version 必须形如 x.y.z） */
function assertSemVer(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`版本号不是合法 SemVer：${version}`)
  }
}

function fail(message) {
  console.error(`[publish-update] 错误：${message}`)
  process.exit(1)
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

// —— 参数解析 ——
const args = process.argv.slice(2)
const targetRoot = args[0]
if (!targetRoot) {
  console.error('用法：node scripts/publish-update.mjs <更新源根目录> [--notes "更新说明"] [--required]')
  process.exit(1)
}
const notesIndex = args.indexOf('--notes')
const notes = notesIndex >= 0 ? (args[notesIndex + 1] ?? '') : ''
const required = args.includes('--required')

// —— 版本与产物定位 ——
const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8'))
const version = conf.version
assertSemVer(version)
const setupName = `${conf.productName}_${version}_x64-setup.exe`
const setupPath = join(BUNDLE_NSIS, setupName)
const sigPath = `${setupPath}.sig`

for (const file of [setupPath, sigPath]) {
  if (!existsSync(file)) {
    fail(`产物缺失：${file}\n先执行签名构建（TAURI_SIGNING_PRIVATE_KEY=... pnpm tauri build）`)
  }
}

// —— 复制产物（append-only 版本目录）——
const versionDir = join(resolve(targetRoot), 'releases', version)
mkdirSync(versionDir, { recursive: true })
copyFileSync(setupPath, join(versionDir, setupName))
copyFileSync(sigPath, join(versionDir, `${setupName}.sig`))

// —— 生成 manifest.json（字段对齐官方 latest.json + manifestVersion/required）——
const signature = readFileSync(sigPath, 'utf8').trim()
const manifest = {
  manifestVersion: 1,
  version,
  notes,
  pub_date: new Date().toISOString(),
  required,
  platforms: {
    [PLATFORM_KEY]: {
      file: `releases/${version}/${setupName}`,
      size: statSync(join(versionDir, setupName)).size,
      sha256: sha256(join(versionDir, setupName)),
      signature,
    },
  },
}

// —— 自校验（防手工失误）：file 相对路径可达、sha256 复核、签名非空 ——
const checkFile = join(resolve(targetRoot), manifest.platforms[PLATFORM_KEY].file)
if (!existsSync(checkFile)) fail(`自校验失败：清单 file 路径不存在：${checkFile}`)
if (sha256(checkFile) !== manifest.platforms[PLATFORM_KEY].sha256) fail('自校验失败：sha256 不一致')
if (signature.length === 0) fail('自校验失败：signature 为空（.sig 文件内容缺失）')

const manifestPath = join(resolve(targetRoot), 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

console.log(`[publish-update] v${version} 已发布到 ${resolve(targetRoot)}`)
console.log(`  包文件：${manifest.platforms[PLATFORM_KEY].file}`)
console.log(`  sha256：${manifest.platforms[PLATFORM_KEY].sha256}`)
console.log(`  清单：${manifestPath}`)
