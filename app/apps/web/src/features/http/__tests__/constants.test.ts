import { describe, expect, it } from 'vitest'

import contract from '@/test/fixtures/redact-contract.json'

import {
  defaultSaveFileName,
  isLikelyTextBytes,
  isPdfBytes,
  isSensitiveHeader,
  maskSecretValues,
  maskUrlQuery,
  previewKindFromContentType,
  SENSITIVE_HEADER_NAMES,
} from '../constants'

/**
 * 脱敏契约夹具：与 Rust `domain/redact.rs`＋`cli/api.rs` 的契约测试共享
 * 同一份 `src/test/fixtures/redact-contract.json`（Rust 侧 include_str! 引用）
 * ——任一端改名单或口径另一端立红。名单演进通道：先改夹具（双端测试同红）
 * 再双端内化；单边改任一端内化名单，该端立红（本地验证：从
 * SENSITIVE_HEADER_NAMES 临时删一项，本文件红而 Rust 侧仍绿，即暴露单边
 * 漂移；只改夹具名单，双端测试同红）。
 */

describe('脱敏契约夹具（与 Rust domain/cli 测试共享同一份表）', () => {
  it('敏感头名单与夹具一致（成员是契约，顺序不是）', () => {
    const mine = [...SENSITIVE_HEADER_NAMES].sort()
    const theirs = [...contract.sensitiveHeaderNames].sort()
    expect(mine).toEqual(theirs)
  })

  it('头名判定逐 case 与夹具一致（大小写异形命中、相似名不误伤）', () => {
    for (const { name, sensitive } of contract.headerCases) {
      expect(isSensitiveHeader(name, []), `header=${name}`).toBe(sensitive)
    }
  })

  it('URL query 掩码逐 case 与夹具一致（键匹配不区分大小写）', () => {
    for (const { url, keys, masked } of contract.queryCases) {
      expect(maskUrlQuery(url, keys), `url=${url}`).toBe(masked)
    }
  })
})

describe('Secret 变量消费值全文替换（请求镜像掩码口径，夹具双端钉住）', () => {
  it('逐 case 与夹具一致（任意位置替换 / 空值跳过 / 放行跳过）', () => {
    for (const { text, values, show, masked } of contract.secretValueCases) {
      expect(maskSecretValues(text, values, show), `text=${text}`).toBe(masked)
    }
  })
})

describe('保存响应默认文件名（URL 尾段优先，扩展名按 Content-Type 推断补齐）', () => {
  it('URL 尾段有扩展名：原样采用（query / hash 不入名）', () => {
    expect(defaultSaveFileName('https://host/api/users.json?page=1', null)).toBe('users.json')
    expect(defaultSaveFileName('https://host/a/b/report.pdf#top', 'text/html')).toBe('report.pdf')
  })

  it('URL 尾段无扩展名：按 Content-Type 补齐', () => {
    expect(defaultSaveFileName('https://host/api/users', 'application/json; charset=utf-8')).toBe(
      'users.json',
    )
    expect(defaultSaveFileName('https://host/img/avatar', 'image/jpeg')).toBe('avatar.jpg')
    expect(defaultSaveFileName('https://host/api/list', 'application/octet-stream')).toBe(
      'list.bin',
    )
    expect(defaultSaveFileName('https://host/stream', 'text/event-stream')).toBe('stream.txt')
  })

  it('URL 尾段为空（根路径 / 仅清洗残留）：Content-Type 推名，双缺回落 response', () => {
    expect(defaultSaveFileName('https://host/', 'application/xml')).toBe('response.xml')
    expect(defaultSaveFileName('https://host/*', 'application/json')).toBe('response.json')
    expect(defaultSaveFileName('', null)).toBe('response')
  })

  it('Content-Type 形态推不出扩展名：尾段原样保留、不胡补', () => {
    expect(defaultSaveFileName('https://host/api/users', 'application/x-odd+proto')).toBe('users')
    expect(defaultSaveFileName('https://host/中文名', 'application/json')).toBe('中文名.json')
  })

  it('文件系统不安全字符清洗为下划线；超长尾段截断', () => {
    expect(defaultSaveFileName('https://host/a<b>:c', null)).toBe('a_b__c')
    expect(defaultSaveFileName(`https://host/${'x'.repeat(120)}`, 'application/json')).toBe(
      `${'x'.repeat(80)}.json`,
    )
  })
})

describe('Preview 可渲染类型判定（text/* 家族进文本档）', () => {
  it('text/* 家族进 text 档；html 优先拦截', () => {
    expect(previewKindFromContentType('text/plain')).toBe('text')
    expect(previewKindFromContentType('text/plain; charset=utf-8')).toBe('text')
    expect(previewKindFromContentType('text/csv')).toBe('text')
    expect(previewKindFromContentType('text/markdown')).toBe('text')
    expect(previewKindFromContentType('text/event-stream')).toBe('text')
    expect(previewKindFromContentType('TEXT/HTML')).toBe('html')
    expect(previewKindFromContentType('text/html; charset=utf-8')).toBe('html')
  })

  it('图片 / pdf 维持既有通道；JSON 与未知类型不定档（由字节嗅探裁决）', () => {
    expect(previewKindFromContentType('image/png')).toBe('image')
    expect(previewKindFromContentType('image/svg+xml')).toBe('image')
    expect(previewKindFromContentType('application/pdf')).toBe('pdf')
    expect(previewKindFromContentType('application/json')).toBeNull()
    expect(previewKindFromContentType('application/octet-stream')).toBeNull()
    expect(previewKindFromContentType('application/x-custom')).toBeNull()
    expect(previewKindFromContentType(null)).toBeNull()
    expect(previewKindFromContentType(undefined)).toBeNull()
  })
})

describe('文本嗅探（未知类型的字节层判定）', () => {
  it('空字节与纯文本：判为文本', () => {
    expect(isLikelyTextBytes(new Uint8Array(0))).toBe(true)
    expect(isLikelyTextBytes(new TextEncoder().encode('hello world'))).toBe(true)
  })

  it('UTF-8 BOM 是文本强证据（含中文正文）', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('中文正文')])
    expect(isLikelyTextBytes(bom)).toBe(true)
  })

  it('高位字节宽容：GBK / Big5 等多字节编码按文本放行', () => {
    expect(isLikelyTextBytes(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))).toBe(true)
  })

  it('常见二进制魔数前缀否决（PNG / JPEG / PDF / ZIP / GZIP）', () => {
    expect(isLikelyTextBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(false)
    expect(isLikelyTextBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false)
    expect(isLikelyTextBytes(Uint8Array.from('%PDF-1.7', (c) => c.charCodeAt(0)))).toBe(false)
    expect(isLikelyTextBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(false)
    expect(isLikelyTextBytes(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(false)
  })

  it('首块出现 NUL 即否决（UTF-16 高位零字节由此一并回落）', () => {
    expect(isLikelyTextBytes(new TextEncoder().encode('hello\x00world'))).toBe(false)
    // UTF-16LE「hi」＝68 00 69 00：NUL 密集，判二进制（编码候选表不含 utf-16）
    expect(isLikelyTextBytes(new Uint8Array([0x68, 0x00, 0x69, 0x00]))).toBe(false)
  })

  it('控制字节可疑率 5% 为界：横杠内放行、超出否决（\\t \\n \\r 不计）', () => {
    // 100 字节中 5 个 0x01＝恰好 5%，放行
    const atLimit = new Uint8Array(100)
    atLimit.set([1, 1, 1, 1, 1], 50)
    for (let i = 0; i < 100; i++) if (atLimit[i] === 0) atLimit[i] = 0x61
    expect(isLikelyTextBytes(atLimit)).toBe(true)
    // 6 个即 6%，否决
    const overLimit = new Uint8Array(100)
    overLimit.set([1, 1, 1, 1, 1, 1], 50)
    for (let i = 0; i < 100; i++) if (overLimit[i] === 0) overLimit[i] = 0x61
    expect(isLikelyTextBytes(overLimit)).toBe(false)
    // 制表 / 换行 / 回车是正常文本字节，密集也不计可疑
    const whitespacey = new Uint8Array(100)
    for (let i = 0; i < 100; i++) whitespacey[i] = i % 2 === 0 ? 0x0a : 0x09
    expect(isLikelyTextBytes(whitespacey)).toBe(true)
  })

  it('嗅探只看首块：魔数判定不因尾部二进制内容翻转（有界嗅探口径）', () => {
    // 首块纯文本 + 远端 NUL（超过 4096 首块窗口）：NUL 规则按首块判定放行
    const bytes = new Uint8Array(5000)
    for (let i = 0; i < 5000; i++) bytes[i] = 0x61
    bytes[4500] = 0x00
    expect(isLikelyTextBytes(bytes)).toBe(true)
  })
})

describe('PDF 魔数门槛（pdf 通道无沙箱对冲的准入判定）', () => {
  const encode = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

  it('标准文件头（%PDF- 开头）判为 PDF', () => {
    expect(isPdfBytes(encode('%PDF-1.7\n%%EOF-ish body'))).toBe(true)
  })

  it('头部前夹杂垃圾字节：前 1KB 内寻到 %PDF- 仍判为 PDF', () => {
    const junkPrefix = encode('leading junk bytes \n\n')
    expect(isPdfBytes(new Uint8Array([...junkPrefix, ...encode('%PDF-1.4')]))).toBe(true)
  })

  it('魔数越过 1KB 窗口不认（有界扫描）', () => {
    const bytes = new Uint8Array(1100)
    bytes.set(encode('%PDF-'), 1024)
    expect(isPdfBytes(bytes)).toBe(false)
  })

  it('非 PDF 字节（谎报 Content-Type 的 HTML / 空字节）不进 pdf 通道', () => {
    expect(isPdfBytes(encode('<!DOCTYPE html><html><body>hi</body></html>'))).toBe(false)
    expect(isPdfBytes(new Uint8Array(0))).toBe(false)
    expect(isPdfBytes(encode('%PDF'))).toBe(false)
  })
})
