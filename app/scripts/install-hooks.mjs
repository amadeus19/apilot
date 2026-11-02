#!/usr/bin/env node
/**
 * pnpm install（prepare 生命周期）时把 git 钩子目录接管到仓库根版本化的 .githooks/。
 * 写入的是仓库本地 git config（不入库）；非 git 环境静默跳过。
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim()
  const hooksPath = resolve(root, '.githooks').replace(/\\/g, '/')
  execFileSync('git', ['config', 'core.hooksPath', hooksPath])
  console.log(`[hooks] core.hooksPath -> ${hooksPath}`)
} catch {
  console.log('[hooks] 非 git 环境，跳过钩子安装')
}
