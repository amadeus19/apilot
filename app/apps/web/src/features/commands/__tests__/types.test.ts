import { describe, expect, it } from 'vitest'

import {
  PARAMETERIZED_FAMILY,
  effectiveShortcut,
  eventMatchesShortcut,
  eventToAccelerator,
  shortcutsConflict,
  type CommandDef,
} from '../types'

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

const cmd = (id: string, defaultShortcut?: string): Pick<CommandDef, 'id' | 'defaultShortcut'> => ({
  id,
  defaultShortcut,
})

/** 加速键归一化：修饰键固定序、字母大写、纯打字不入键位 */
describe('eventToAccelerator', () => {
  it('Ctrl+Shift+P 归一化为固定修饰序', () => {
    expect(eventToAccelerator(keyEvent({ ctrlKey: true, shiftKey: true, key: 'P' }))).toBe(
      'Ctrl+Shift+P',
    )
  })

  it('字母键大写化：Ctrl+t 与 Ctrl+T 同键位', () => {
    expect(eventToAccelerator(keyEvent({ ctrlKey: true, key: 't' }))).toBe('Ctrl+T')
  })

  it('无修饰键的纯字符键＝普通打字，返回 null', () => {
    expect(eventToAccelerator(keyEvent({ key: 'a' }))).toBeNull()
  })

  it('F 键与命名键无修饰键可作命令键位', () => {
    expect(eventToAccelerator(keyEvent({ key: 'F5' }))).toBe('F5')
    expect(eventToAccelerator(keyEvent({ ctrlKey: true, key: 'Enter' }))).toBe('Ctrl+Enter')
  })

  it('逗号等符号键带修饰键可绑定；空格归一化为 Space', () => {
    expect(eventToAccelerator(keyEvent({ ctrlKey: true, key: ',' }))).toBe('Ctrl+,')
    expect(eventToAccelerator(keyEvent({ ctrlKey: true, key: ' ' }))).toBe('Ctrl+Space')
  })
})

/** 生效键位：覆盖 ＞ 默认；显式清空（null）生效为无键位 */
describe('effectiveShortcut', () => {
  it('未覆盖用默认值；覆盖值优先；null 表示已清空', () => {
    expect(effectiveShortcut(cmd('a', 'Ctrl+K'), {})).toBe('Ctrl+K')
    expect(effectiveShortcut(cmd('a', 'Ctrl+K'), { a: 'Ctrl+J' })).toBe('Ctrl+J')
    expect(effectiveShortcut(cmd('a', 'Ctrl+K'), { a: null })).toBeNull()
    expect(effectiveShortcut(cmd('a'), {})).toBeNull()
  })
})

/** 事件匹配：参数化族展开、覆盖后按覆盖匹配 */
describe('eventMatchesShortcut', () => {
  const switchTabs: CommandDef = {
    id: 'tab.switchByIndex',
    labelKey: 'commandPalette.tabSwitchByIndexLabel',
    group: 'tabs',
    defaultShortcut: PARAMETERIZED_FAMILY,
    run: () => {},
  }

  it('参数化族匹配 Ctrl+1..9 并携带序号；Ctrl+0 不匹配', () => {
    expect(eventMatchesShortcut(switchTabs, {}, keyEvent({ ctrlKey: true, key: '3' }))).toEqual({
      matched: true,
      arg: 3,
    })
    expect(
      eventMatchesShortcut(switchTabs, {}, keyEvent({ ctrlKey: true, key: '0' })).matched,
    ).toBe(false)
  })

  it('参数化族被覆盖为具体键后按覆盖键匹配', () => {
    expect(
      eventMatchesShortcut(
        switchTabs,
        { 'tab.switchByIndex': 'Ctrl+5' },
        keyEvent({ ctrlKey: true, key: '5' }),
      ).matched,
    ).toBe(true)
    expect(
      eventMatchesShortcut(
        switchTabs,
        { 'tab.switchByIndex': 'Ctrl+5' },
        keyEvent({ ctrlKey: true, key: '7' }),
      ).matched,
    ).toBe(false)
  })

  it('清空后不匹配任何事件', () => {
    expect(
      eventMatchesShortcut(
        switchTabs,
        { 'tab.switchByIndex': null },
        keyEvent({ ctrlKey: true, key: '3' }),
      ).matched,
    ).toBe(false)
  })

  /** 别名键位（workflow.redo 的 Ctrl+Y 先例）：主键位之外补注册的等效键 */
  describe('别名键位', () => {
    const redo: CommandDef = {
      id: 'workflow.redo',
      labelKey: 'commandPalette.cmdRedoWorkflow',
      group: 'workbench',
      defaultShortcut: 'Ctrl+Shift+Z',
      aliasShortcuts: ['Ctrl+Y'],
      run: () => {},
    }

    it('未覆盖时默认键位与别名都匹配', () => {
      expect(
        eventMatchesShortcut(redo, {}, keyEvent({ ctrlKey: true, shiftKey: true, key: 'Z' }))
          .matched,
      ).toBe(true)
      expect(eventMatchesShortcut(redo, {}, keyEvent({ ctrlKey: true, key: 'y' })).matched).toBe(
        true,
      )
      // 无关键不误匹配
      expect(eventMatchesShortcut(redo, {}, keyEvent({ ctrlKey: true, key: 'x' })).matched).toBe(
        false,
      )
    })

    it('用户覆盖后别名一并失效（覆盖表是生效键位的完整定义）', () => {
      const overridden = { 'workflow.redo': 'Ctrl+R' } as const
      expect(
        eventMatchesShortcut(redo, overridden, keyEvent({ ctrlKey: true, key: 'y' })).matched,
      ).toBe(false)
      expect(
        eventMatchesShortcut(redo, overridden, keyEvent({ ctrlKey: true, key: 'r' })).matched,
      ).toBe(true)
    })

    it('显式清空后默认键位与别名都不再匹配', () => {
      const cleared = { 'workflow.redo': null } as const
      expect(
        eventMatchesShortcut(redo, cleared, keyEvent({ ctrlKey: true, key: 'y' })).matched,
      ).toBe(false)
      expect(
        eventMatchesShortcut(redo, cleared, keyEvent({ ctrlKey: true, shiftKey: true, key: 'Z' }))
          .matched,
      ).toBe(false)
    })
  })
})

/** 冲突判定：同键位与参数化族占用族内具体键 */
describe('shortcutsConflict', () => {
  it('相同键位冲突；null 无冲突', () => {
    expect(shortcutsConflict('Ctrl+K', 'Ctrl+K')).toBe(true)
    expect(shortcutsConflict('Ctrl+K', 'Ctrl+J')).toBe(false)
    expect(shortcutsConflict('Ctrl+K', null)).toBe(false)
  })

  it('参数化族与族内具体键冲突，与族外键不冲突', () => {
    expect(shortcutsConflict(PARAMETERIZED_FAMILY, 'Ctrl+5')).toBe(true)
    expect(shortcutsConflict('Ctrl+5', PARAMETERIZED_FAMILY)).toBe(true)
    expect(shortcutsConflict(PARAMETERIZED_FAMILY, 'Ctrl+0')).toBe(false)
    expect(shortcutsConflict(PARAMETERIZED_FAMILY, 'Ctrl+W')).toBe(false)
  })
})
