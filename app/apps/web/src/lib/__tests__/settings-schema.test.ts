import { describe, expect, it } from 'vitest'

import { parseSettings, resolveLocale, resolveTheme, SETTINGS_DEFAULTS } from '../settings-schema'

describe('parseSettings（Zod 校验）', () => {
  it('合法载荷逐键解析', () => {
    const parsed = parseSettings({
      theme: { preference: 'dark', accent: 'teal' },
      locale: { preference: 'en' },
      devMode: { enabled: true },
      logLevel: { level: 'debug' },
      logDir: { path: 'D:\\Logs' },
      updateSource: { type: 'network', path: '\\\\server\\share' },
      autoCheckUpdates: { enabled: false },
    })
    expect(parsed.theme).toEqual({ preference: 'dark', accent: 'teal' })
    expect(parsed.locale).toEqual({ preference: 'en' })
    expect(parsed.devMode).toEqual({ enabled: true })
    expect(parsed.logLevel).toEqual({ level: 'debug' })
    expect(parsed.logDir).toEqual({ path: 'D:\\Logs' })
    expect(parsed.updateSource).toEqual({ type: 'network', path: '\\\\server\\share' })
    expect(parsed.autoCheckUpdates).toEqual({ enabled: false })
    expect(parsed.invalidKeys).toEqual([])
  })

  it('缺失键回退默认（新库首启动形态）', () => {
    const parsed = parseSettings({})
    expect(parsed.theme).toEqual(SETTINGS_DEFAULTS.theme)
    expect(parsed.locale).toEqual(SETTINGS_DEFAULTS.locale)
    expect(parsed.invalidKeys).toEqual([])
  })

  it('单键脏不放大为整体回退：theme 损坏仅 theme 回退并登记', () => {
    const parsed = parseSettings({
      theme: { preference: 'berzerk' },
      locale: { preference: 'en' },
    })
    expect(parsed.theme).toEqual(SETTINGS_DEFAULTS.theme)
    expect(parsed.locale).toEqual({ preference: 'en' })
    expect(parsed.invalidKeys).toEqual(['theme'])
  })

  it('非对象载荷（null / 越界类型）安全回退', () => {
    expect(parseSettings(null)).toEqual({ ...SETTINGS_DEFAULTS, invalidKeys: [] })
    const parsed = parseSettings({ theme: 42, devMode: 'yes' })
    expect(parsed.invalidKeys).toEqual(['theme', 'devMode'])
    expect(parsed.devMode).toEqual(SETTINGS_DEFAULTS.devMode)
  })

  it('logDir：path 可空（null = 默认目录），非字符串 path 回退默认并登记', () => {
    expect(parseSettings({ logDir: { path: null } }).logDir).toEqual({ path: null })
    expect(parseSettings({}).logDir).toEqual(SETTINGS_DEFAULTS.logDir)
    const broken = parseSettings({ logDir: { path: 42 } })
    expect(broken.logDir).toEqual(SETTINGS_DEFAULTS.logDir)
    expect(broken.invalidKeys).toEqual(['logDir'])
  })

  it('updateSource：三类型枚举校验，云类型 path 可空；非法类型回退并登记', () => {
    expect(parseSettings({ updateSource: { type: 'cloud', path: null } }).updateSource).toEqual({
      type: 'cloud',
      path: null,
    })
    expect(
      parseSettings({ updateSource: { type: 'local', path: 'D:\\updates' } }).updateSource,
    ).toEqual({
      type: 'local',
      path: 'D:\\updates',
    })
    const broken = parseSettings({ updateSource: { type: 'ftp' } })
    expect(broken.updateSource).toEqual(SETTINGS_DEFAULTS.updateSource)
    expect(broken.invalidKeys).toEqual(['updateSource'])
  })

  it('autoCheckUpdates：布尔开关校验，缺失 = 默认开启，非法回退并登记', () => {
    expect(parseSettings({ autoCheckUpdates: { enabled: false } }).autoCheckUpdates).toEqual({
      enabled: false,
    })
    expect(parseSettings({}).autoCheckUpdates).toEqual(SETTINGS_DEFAULTS.autoCheckUpdates)
    const broken = parseSettings({ autoCheckUpdates: { enabled: 'yes' } })
    expect(broken.autoCheckUpdates).toEqual(SETTINGS_DEFAULTS.autoCheckUpdates)
    expect(broken.invalidKeys).toEqual(['autoCheckUpdates'])
  })

  it('http：缺失键回退默认（不限制 / 跟随 / 校验 / 无代理）', () => {
    expect(parseSettings({}).http).toEqual(SETTINGS_DEFAULTS.http)
    expect(parseSettings({}).http).toEqual({
      timeoutSeconds: null,
      redirect: true,
      tlsVerify: true,
      proxy: { mode: 'none', url: null },
    })
  })

  it('http：部分字段缺失与默认合并（null 超时 / 档位 / 自定义代理齐备解析）', () => {
    expect(parseSettings({ http: { timeoutSeconds: null } }).http).toEqual(SETTINGS_DEFAULTS.http)
    expect(parseSettings({ http: { timeoutSeconds: 30 } }).http).toEqual({
      ...SETTINGS_DEFAULTS.http,
      timeoutSeconds: 30,
    })
    expect(
      parseSettings({
        http: {
          timeoutSeconds: 10,
          redirect: false,
          tlsVerify: false,
          proxy: { mode: 'custom', url: 'socks5://127.0.0.1:1080' },
        },
      }).http,
    ).toEqual({
      timeoutSeconds: 10,
      redirect: false,
      tlsVerify: false,
      proxy: { mode: 'custom', url: 'socks5://127.0.0.1:1080' },
    })
  })

  it('http：非法值回退默认并登记（负数超时 / 非法枚举 / custom 缺 url）', () => {
    const negative = parseSettings({ http: { timeoutSeconds: -5 } })
    expect(negative.http).toEqual(SETTINGS_DEFAULTS.http)
    expect(negative.invalidKeys).toEqual(['http'])

    const badMode = parseSettings({ http: { proxy: { mode: 'system', url: null } } })
    expect(badMode.invalidKeys).toEqual(['http'])

    // custom 缺 url 与 Rust 写前校验同口径：整体判脏回退默认
    const incomplete = parseSettings({ http: { proxy: { mode: 'custom' } } })
    expect(incomplete.http).toEqual(SETTINGS_DEFAULTS.http)
    expect(incomplete.invalidKeys).toEqual(['http'])
  })

  it('workflowPins：workspaceId → workflowId 映射回灌，缺失 = 默认空映射', () => {
    expect(parseSettings({ workflowPins: { ws1: 'wf1', ws2: 'wf2' } }).workflowPins).toEqual({
      ws1: 'wf1',
      ws2: 'wf2',
    })
    expect(parseSettings({}).workflowPins).toEqual(SETTINGS_DEFAULTS.workflowPins)
  })

  it('workflowPins：非法值（非映射 / 空串键值）整体判脏回退默认并登记', () => {
    const brokenValue = parseSettings({ workflowPins: { ws1: '' } })
    expect(brokenValue.workflowPins).toEqual(SETTINGS_DEFAULTS.workflowPins)
    expect(brokenValue.invalidKeys).toEqual(['workflowPins'])

    const brokenKey = parseSettings({ workflowPins: { '': 'wf1' } })
    expect(brokenKey.workflowPins).toEqual(SETTINGS_DEFAULTS.workflowPins)
    expect(brokenKey.invalidKeys).toEqual(['workflowPins'])

    const notObject = parseSettings({ workflowPins: 42 })
    expect(notObject.workflowPins).toEqual(SETTINGS_DEFAULTS.workflowPins)
    expect(notObject.invalidKeys).toEqual(['workflowPins'])
  })
})

describe('resolveLocale（解析链）', () => {
  it('preference ≠ system 直用', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN')
  })

  it('system 态按 os locale 前缀归档', () => {
    expect(resolveLocale('system', 'zh-Hans-CN')).toBe('zh-CN')
    expect(resolveLocale('system', 'en-US')).toBe('en')
    expect(resolveLocale('system', 'en')).toBe('en')
  })

  it('system 态其他 / null 一律回退 zh-CN', () => {
    expect(resolveLocale('system', 'fr-FR')).toBe('zh-CN')
    expect(resolveLocale('system', null)).toBe('zh-CN')
    expect(resolveLocale('system', undefined)).toBe('zh-CN')
  })
})

describe('resolveTheme（三态真值协议）', () => {
  it('显式两态直用', () => {
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('dark', null)).toBe('dark')
  })

  it('system 态真值只来自 Tauri；缺失回退 light（禁 prefers-color-scheme）', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark')
    expect(resolveTheme('system', null)).toBe('light')
  })
})
