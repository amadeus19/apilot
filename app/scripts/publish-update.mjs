#!/usr/bin/env node
/**
 * 发包脚本：把一次 tauri build 的签名产物发布为更新源清单（两种模式共用清单 schema）。
 *
 * 1) 本机文件夹模式（默认）：复制产物进更新源目录，file 写相对路径。
 *    布局约定：
 *      <更新源根>/manifest.json            ← 唯一入口清单
 *      <更新源根>/releases/<版本>/         ← 包文件 + .sig（append-only）
 *    用法：
 *      node scripts/publish-update.mjs <更新源根目录> [--notes "更新说明"] [--required]
 *
 * 2) GitHub Release 模式（--github，CI 发版用）：不复制文件，file 写 Release 资产
 *    文件名（消费端按 baseUrl + tag 重建寻址 URL），size/sha256 对传入文件就地
 *    计算；双架构 setup.exe 与 .sig 缺一即 fail。
 *    用法：
 *      node scripts/publish-update.mjs --github --tag <tag> --out <清单输出路径> \
 *        [--notes "更新说明"] [--required] <安装包/.sig/MSI 文件清单...>
 *    清单文件须为 tauri bundler 实际产物名：
 *      APilot_<版本>_{x64|arm64}-setup.exe（+ 同名 .sig）、APilot_<版本>_<架构>_<语言>.msi
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
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONF_PATH = join(REPO_ROOT, 'apps/web/src-tauri/tauri.conf.json')
const BUNDLE_NSIS = join(REPO_ROOT, 'apps/web/src-tauri/target/release/bundle/nsis')
const PLATFORM_KEY = 'windows-x86_64'
// GitHub Release 模式的资产 URL 前缀（发布仓库；与发版流水线所在仓库一致）。
// 默认拉取源在 Rust 侧 DEFAULT_CLOUD_BASE_URL（update_source.rs）——同一
// 仓库地址的两处事实，换仓库须两处齐改。
const GITHUB_REPO = 'amadeus19/apilot'

// bundler 产物名中的架构段 → manifest 平台键。
// tauri-bundler（v2.12.0 起）对 AArch64 实际输出 "arm64"；"aarch64" 拼写一并接受，
// 防上游命名口径调整或手工改名导致解析失败。
const ARCH_PLATFORM_KEYS = {
  x64: 'windows-x86_64',
  arm64: 'windows-aarch64',
  aarch64: 'windows-aarch64',
}

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

// —— 参数解析（标志可任意穿插，位置参数收集保序）——
const args = process.argv.slice(2)
const githubMode = args.includes('--github')

const positionals = []
let notes = ''
let required = false
let tagArg = ''
let outArg = ''
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--github':
      break
    case '--notes':
      notes = args[++i] ?? ''
      break
    case '--required':
      required = true
      break
    case '--tag':
      tagArg = args[++i]
      if (tagArg === undefined) fail('--tag 缺少参数值')
      break
    case '--out':
      outArg = args[++i]
      if (outArg === undefined) fail('--out 缺少参数值')
      break
    default:
      positionals.push(args[i])
  }
}

// —— 版本事实源（两种模式都以 tauri.conf.json 为版本/productName 基准）——
const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8'))
const version = conf.version
assertSemVer(version)

if (githubMode) {
  publishToGithubRelease()
} else {
  publishToLocalFolder()
}

/**
 * GitHub Release 模式：对传入资产就地计算 size/sha256，file 写 Release 资产绝对 URL，
 * 生成带 tag 字段的 manifest；platforms 双键 windows-x86_64 / windows-aarch64。
 */
function publishToGithubRelease() {
  if (!/^v\d+\.\d+\.\d+$/.test(tagArg)) {
    fail(`--tag 须形如 vX.Y.Z，收到：${tagArg || '(缺省)'}`)
  }
  if (!outArg) fail('GitHub Release 模式必须提供 --out <manifest 输出路径>')
  if (positionals.length === 0) {
    fail('GitHub Release 模式必须提供建包文件清单（NSIS setup.exe 与同名 .sig，可选 MSI）')
  }
  if (tagArg !== `v${version}`) {
    fail(`--tag 与 tauri.conf.json 版本不一致：${tagArg} ↔ v${version}`)
  }

  const prefix = `${conf.productName}_${version}_`
  const setups = new Map() // 平台键 → setup.exe 绝对路径
  const signatures = new Map() // 平台键 → .sig 绝对路径
  const msiNames = [] // MSI 仅作 Release 资产（手动下载通道），不进 manifest

  for (const file of positionals) {
    if (!existsSync(file)) fail(`产物缺失：${file}`)
    const base = basename(file)
    if (!base.startsWith(prefix)) {
      fail(`资产文件名与 ${prefix}<架构>… 模板不符：${base}`)
    }
    const rest = base.slice(prefix.length)
    // NSIS 签名：<架构>-setup.exe.sig
    let m = /^(x64|arm64|aarch64)-setup\.exe\.sig$/.exec(rest)
    if (m) {
      signatures.set(ARCH_PLATFORM_KEYS[m[1]], resolve(file))
      continue
    }
    // NSIS 更新包：<架构>-setup.exe
    m = /^(x64|arm64|aarch64)-setup\.exe$/.exec(rest)
    if (m) {
      setups.set(ARCH_PLATFORM_KEYS[m[1]], resolve(file))
      continue
    }
    // MSI：仅校验命名后跳过（<架构>_<语言>.msi）
    m = /^(x64|arm64|aarch64)_[A-Za-z-]+\.msi$/.exec(rest)
    if (m) {
      msiNames.push(base)
      continue
    }
    fail(
      `无法识别的资产文件名：${base}（期望 ${prefix}{x64|arm64}-setup.exe[.sig] 或 ${prefix}<架构>_<语言>.msi）`,
    )
  }

  // 双架构核心资产（更新通道）缺一即 fail
  for (const key of ['windows-x86_64', 'windows-aarch64']) {
    if (!setups.has(key)) fail(`缺少 ${key} 的 NSIS 更新包（${prefix}{x64|arm64}-setup.exe）`)
    if (!signatures.has(key)) fail(`缺少 ${key} 的 NSIS 签名（${prefix}{x64|arm64}-setup.exe.sig）`)
  }

  const manifest = {
    manifestVersion: 1,
    version,
    tag: tagArg,
    notes,
    pub_date: new Date().toISOString(),
    required,
    platforms: {},
  }
  for (const [key, setupPath] of setups) {
    manifest.platforms[key] = {
      // file 写资产文件名（非完整 URL）：消费端按 baseUrl + tag + file 重建
      // 寻址 URL（镜像前缀才能生效）；file 写完整 URL 会被再拼一层寻址
      // 前缀成畸形 URL，下载落 404
      file: basename(setupPath),
      size: statSync(setupPath).size,
      sha256: sha256(setupPath),
      signature: readFileSync(signatures.get(key), 'utf8').trim(),
    }
  }

  // —— 自校验（防手工失误）：file 与资产名一致、size 一致、sha256 复核、签名非空 ——
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    const setupPath = setups.get(key)
    if (entry.file !== basename(setupPath)) {
      fail(`自校验失败：${key} 的 file 应为资产文件名，实际：${entry.file}`)
    }
    if (statSync(setupPath).size !== entry.size) fail(`自校验失败：${key} 的 size 与实际文件不一致`)
    if (sha256(setupPath) !== entry.sha256) fail(`自校验失败：${key} 的 sha256 不一致`)
    if (entry.signature.length === 0)
      fail(`自校验失败：${key} 的 signature 为空（.sig 文件内容缺失）`)
  }

  const manifestPath = resolve(outArg)
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  console.log(`[publish-update] v${version}（${tagArg}）GitHub Release 清单已生成`)
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    console.log(`  ${key}：${entry.file}`)
    console.log(`    size：${entry.size}  sha256：${entry.sha256}`)
  }
  if (msiNames.length > 0) {
    console.log(`  MSI 资产（仅手动下载，不进清单）：${msiNames.join('、')}`)
  }
  console.log(`  清单：${manifestPath}`)
}

/**
 * 本机文件夹模式：复制产物进更新源版本目录（append-only），file 写相对路径。
 */
function publishToLocalFolder() {
  const targetRoot = positionals[0]
  if (!targetRoot) {
    console.error(
      '用法：node scripts/publish-update.mjs <更新源根目录> [--notes "更新说明"] [--required]',
    )
    console.error(
      '      node scripts/publish-update.mjs --github --tag <tag> --out <清单路径> <文件清单...>',
    )
    process.exit(1)
  }

  const setupName = `${conf.productName}_${version}_x64-setup.exe`
  const setupPath = join(BUNDLE_NSIS, setupName)
  const sigPath = `${setupPath}.sig`

  for (const file of [setupPath, sigPath]) {
    if (!existsSync(file)) {
      fail(
        `产物缺失：${file}\n先执行签名构建（TAURI_SIGNING_PRIVATE_KEY=... pnpm tauri build）`,
      )
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
  if (sha256(checkFile) !== manifest.platforms[PLATFORM_KEY].sha256)
    fail('自校验失败：sha256 不一致')
  if (signature.length === 0) fail('自校验失败：signature 为空（.sig 文件内容缺失）')

  const manifestPath = join(resolve(targetRoot), 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  console.log(`[publish-update] v${version} 已发布到 ${resolve(targetRoot)}`)
  console.log(`  包文件：${manifest.platforms[PLATFORM_KEY].file}`)
  console.log(`  sha256：${manifest.platforms[PLATFORM_KEY].sha256}`)
  console.log(`  清单：${manifestPath}`)
}
