import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { en } from '../locales/en'
import { zhCN } from '../locales/zh-CN'

/**
 * 错误码机械对账：直读 Rust 侧 error.rs 的 codes 登记区，
 * 校验 zh-CN / en 两语言 errors 字典与登记区键集合完全一致。
 * 错误码一经发布不可改名——Rust 加码而字典缺键（或字典留死键）在此即刻失败，
 * 不依赖人工记忆对齐。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
// src/i18n/__tests__ → __tests__ → i18n → src → apps/web；登记区在 web/src-tauri/src/error.rs
const RUST_ERROR_RS = path.resolve(HERE, '../../../src-tauri/src/error.rs')

/** 从 error.rs 源码提取 codes 模块内全部 `pub const X: &str = "X";` */
function registeredCodes(): string[] {
  const source = readFileSync(RUST_ERROR_RS, 'utf8')
  const body = source.slice(source.indexOf('pub mod codes'))
  const codes = [...body.matchAll(/pub const ([A-Z0-9_]+): &str = "([A-Z0-9_]+)";/g)].map(
    ([, name, value]) => ({ name, value }),
  )
  expect(codes.length, 'codes 登记区应至少解析出一个错误码').toBeGreaterThan(0)
  for (const { name, value } of codes) {
    expect(value, `常量名 ${name} 与码值 ${value} 应一致（单点登记纪律）`).toBe(name)
  }
  return codes.map(({ value }) => value)
}

describe('错误码机械对账（Rust codes 登记区 ↔ i18n 字典）', () => {
  const codes = registeredCodes()

  it('登记区每个错误码在 zh-CN 字典都有 errors.* 键', () => {
    for (const code of codes) {
      expect(zhCN.errors, `zh-CN 缺少 errors.${code}`).toHaveProperty(code)
      expect(typeof zhCN.errors[code as keyof typeof zhCN.errors]).toBe('string')
    }
  })

  it('登记区每个错误码在 en 字典都有 errors.* 错误码键', () => {
    for (const code of codes) {
      expect(en.errors, `en 缺少 errors.${code}`).toHaveProperty(code)
      expect(typeof en.errors[code as keyof typeof en.errors]).toBe('string')
    }
  })

  it('字典不留死键：errors 的每个键都在登记区注册', () => {
    const registered = new Set(codes)
    for (const key of Object.keys(zhCN.errors)) {
      expect(registered.has(key), `zh-CN errors.${key} 未在 Rust 登记区注册`).toBe(true)
    }
    for (const key of Object.keys(en.errors)) {
      expect(registered.has(key), `en errors.${key} 未在 Rust 登记区注册`).toBe(true)
    }
  })
})
