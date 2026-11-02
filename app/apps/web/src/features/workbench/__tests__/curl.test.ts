import { describe, expect, it } from 'vitest'

import { AUTH_INHERIT, AUTH_NONE } from '../auth-config'
import { parseCurlCommand, serializeCurl, type CurlExportInput } from '../curl'
import type { BodyDraftView } from '../body-envelope'

// —— 序列化：草稿 → bash cURL ——

function makeInput(overrides?: Partial<CurlExportInput>): CurlExportInput {
  return {
    method: 'GET',
    url: 'http://x.test/api',
    headers: [],
    body: { kind: 'none', text: '', rows: [], fromEnvelope: true } as BodyDraftView,
    requestAuth: AUTH_INHERIT,
    workspaceAuth: null,
    ...overrides,
  }
}

function textBody(kind: 'json' | 'xml' | 'text', text: string): BodyDraftView {
  return { kind, text, rows: [], fromEnvelope: true }
}

describe('cURL 序列化：基本形态', () => {
  it('GET 无头无体＝单行命令（method 恒显式）', () => {
    expect(serializeCurl(makeInput())).toBe(`curl -X GET 'http://x.test/api'`)
  })

  it('多参数＝续行形态（每行 \\ 收尾、次行起两空格缩进）', () => {
    const command = serializeCurl(
      makeInput({
        method: 'POST',
        headers: [{ name: 'X-Trace', value: '1' }],
        body: textBody('json', '{"a":1}'),
      }),
    )
    expect(command).toBe(
      [
        `curl -X POST 'http://x.test/api' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -H 'X-Trace: 1' \\`,
        `  --data-raw '{"a":1}'`,
      ].join('\n'),
    )
  })

  it('xml / text 无显式头时按引擎默认补 Content-Type', () => {
    expect(serializeCurl(makeInput({ body: textBody('xml', '<root/>') }))).toContain(
      `-H 'Content-Type: application/xml'`,
    )
    expect(serializeCurl(makeInput({ body: textBody('text', 'hi') }))).toContain(
      `-H 'Content-Type: text/plain'`,
    )
  })

  it('显式 Content-Type 头优先：不补默认（text 草稿带用户头）', () => {
    const command = serializeCurl(
      makeInput({
        headers: [{ name: 'content-type', value: 'text/csv' }],
        body: textBody('text', 'a,b'),
      }),
    )
    expect(command).toContain(`-H 'content-type: text/csv'`)
    expect(command).not.toContain('text/plain')
  })

  it('文本系空体＝无 body 参数（与发送侧「空体为 None」同口径）', () => {
    const command = serializeCurl(makeInput({ body: textBody('json', '') }))
    expect(command).toBe(`curl -X GET 'http://x.test/api'`)
  })

  it('空 name 头行不编入（引擎侧同一过滤）', () => {
    const command = serializeCurl(
      makeInput({
        headers: [
          { name: '', value: 'skip' },
          { name: 'Keep', value: '1' },
        ],
      }),
    )
    expect(command).toContain(`-H 'Keep: 1'`)
    expect(command).not.toContain('skip')
  })
})

describe('cURL 序列化：body 各 kind', () => {
  it('urlencoded＝-d（%20 语义编码、结构字符编码、空 name 行过滤）', () => {
    const command = serializeCurl(
      makeInput({
        method: 'POST',
        body: {
          kind: 'urlencoded',
          text: '',
          rows: [
            { name: 'q', value: 'a b&c=1' },
            { name: '中文', value: '值' },
            { name: '', value: 'skipped' },
          ],
          fromEnvelope: true,
        },
      }),
    )
    expect(command).toContain(`-d 'q=a%20b%26c%3D1&%E4%B8%AD%E6%96%87=%E5%80%BC'`)
    // 无显式头时补表单默认 Content-Type（与引擎默认头一致）
    expect(command).toContain(`-H 'Content-Type: application/x-www-form-urlencoded'`)
  })

  it('urlencoded 空行集＝空体 -d（与发送侧零字节体一致）', () => {
    const command = serializeCurl(
      makeInput({
        body: { kind: 'urlencoded', text: '', rows: [], fromEnvelope: true },
      }),
    )
    expect(command).toContain(`-d ''`)
  })

  it('form-data 文本字段＝-F name=value，file 行＝-F name=@路径（路径原样）', () => {
    const command = serializeCurl(
      makeInput({
        method: 'POST',
        body: {
          kind: 'form-data',
          text: '',
          rows: [
            { name: 'payload', value: 'hi' },
            { name: 'upload', value: '/tmp/a b.png', type: 'file' },
            { name: 'win', value: 'C:\\用户数据\\c.png', type: 'file' },
            { name: '', value: 'skip', type: 'file' },
            { name: 'off', value: '/tmp/x.png', type: 'file', enabled: false },
          ],
          fromEnvelope: true,
        },
      }),
    )
    expect(command).toContain(`-F 'payload=hi'`)
    // 路径原样编入（含空格与反斜杠），shell 引号走既有转义
    expect(command).toContain(`-F 'upload=@/tmp/a b.png'`)
    expect(command).toContain(`-F 'win=@C:\\用户数据\\c.png'`)
    // 空 name 与禁用行不参与（与引擎 multipart 映射同一过滤）
    expect(command).not.toContain('skip')
    expect(command).not.toContain('x.png')
    // 不再有命令尾注释占位行
    expect(command).not.toContain('\n#')
  })

  it('form-data 的显式 Content-Type 头跳过（编入会剥夺 -F 自管的 boundary）', () => {
    const command = serializeCurl(
      makeInput({
        headers: [{ name: 'Content-Type', value: 'multipart/form-data' }],
        body: {
          kind: 'form-data',
          text: '',
          rows: [{ name: 'a', value: '1' }],
          fromEnvelope: true,
        },
      }),
    )
    expect(command).not.toContain('multipart/form-data')
  })
})

describe('cURL 序列化：认证注入（发送侧镜像）', () => {
  it('Bearer：Authorization 头编入，{{变量}} 原样保留', () => {
    const command = serializeCurl(
      makeInput({ requestAuth: { type: 'bearer', token: '{{secret.token}}' } }),
    )
    expect(command).toContain(`-H 'Authorization: Bearer {{secret.token}}'`)
  })

  it('Basic：凭据整体 base64（UTF-8 语义，含中文）', () => {
    const command = serializeCurl(
      makeInput({ requestAuth: { type: 'basic', username: '管理员', password: 'p@ss' } }),
    )
    // btoa 不吃非 latin1，中文凭据经字节链路编码
    const expected = btoa(String.fromCharCode(...new TextEncoder().encode('管理员:p@ss')))
    expect(command).toContain(`-H 'Authorization: Basic ${expected}'`)
  })

  it('apiKey·header：同名用户头替换（认证优先）', () => {
    const command = serializeCurl(
      makeInput({
        headers: [{ name: 'X-Key', value: 'stale' }],
        requestAuth: { type: 'apiKey', position: 'header', key: 'X-Key', value: 'fresh' },
      }),
    )
    expect(command).toContain(`-H 'X-Key: fresh'`)
    expect(command).not.toContain('stale')
  })

  it('apiKey·query：URL 尾部追加（已有 query 用 & 接续、值百分号编码）', () => {
    const command = serializeCurl(
      makeInput({
        url: 'http://x.test/a?verbose=true',
        requestAuth: { type: 'apiKey', position: 'query', key: 'api_key', value: 's 1' },
      }),
    )
    expect(command).toContain(`'http://x.test/a?verbose=true&api_key=s%201'`)
  })

  it('apiKey·cookie：已有 Cookie 分号合并，无则新建', () => {
    const merged = serializeCurl(
      makeInput({
        headers: [{ name: 'Cookie', value: 'a=1' }],
        requestAuth: { type: 'apiKey', position: 'cookie', key: 'sid', value: 'v' },
      }),
    )
    expect(merged).toContain(`-H 'Cookie: a=1; sid=v'`)
    const created = serializeCurl(
      makeInput({ requestAuth: { type: 'apiKey', position: 'cookie', key: 'sid', value: 'v' } }),
    )
    expect(created).toContain(`-H 'Cookie: sid=v'`)
  })

  it('两级继承：请求级 inherit 回落工作空间级；none 阻断；请求级具名优先', () => {
    const inherited = serializeCurl(
      makeInput({
        requestAuth: AUTH_INHERIT,
        workspaceAuth: { type: 'bearer', token: 'root' },
      }),
    )
    expect(inherited).toContain(`-H 'Authorization: Bearer root'`)

    const blocked = serializeCurl(
      makeInput({
        requestAuth: AUTH_NONE,
        workspaceAuth: { type: 'bearer', token: 'root' },
      }),
    )
    expect(blocked).toBe(`curl -X GET 'http://x.test/api'`)

    const explicit = serializeCurl(
      makeInput({
        requestAuth: { type: 'bearer', token: 'req' },
        workspaceAuth: { type: 'bearer', token: 'root' },
      }),
    )
    expect(explicit).toContain(`-H 'Authorization: Bearer req'`)
  })
})

describe('cURL 序列化：shell 引号', () => {
  it("值内单引号以 '\\'' 转义（命令整体仍可执行）", () => {
    const command = serializeCurl(makeInput({ headers: [{ name: 'X-Msg', value: "it's" }] }))
    expect(command).toContain(`-H 'X-Msg: it'\\''s'`)
  })

  it('多行 body 原样保留（单引号内字面换行合法）', () => {
    const command = serializeCurl(makeInput({ body: textBody('json', '{\n  "a": 1\n}') }))
    expect(command).toContain(`--data-raw '{\n  "a": 1\n}'`)
  })
})

// —— 解析：cURL 命令 → 草稿 ——

describe('cURL 解析：词法（单/双引号与续行）', () => {
  it('续行 \\ 拼接、单引号字面、双引号内 \\" 与 \\\\ 转义', () => {
    const source = [
      `curl 'http://x.test/a?q=1' \\`,
      `  -H 'X-Note: it'\\''s' \\`,
      `  -H "X-Dup: \\"quoted\\"" \\`,
      `  -H "X-Path: C:\\\\tmp"`,
    ].join('\n')
    const result = parseCurlCommand(source, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.headersJson).toBe(
      JSON.stringify([
        { name: 'X-Note', value: "it's" },
        { name: 'X-Dup', value: '"quoted"' },
        { name: 'X-Path', value: 'C:\\tmp' },
      ]),
    )
  })

  it('未闭合引号拒绝（词位 0＝整体形态）', () => {
    const result = parseCurlCommand(`curl 'http://x.test`, null)
    expect(result).toEqual({ ok: false, error: { position: 0, reason: 'unterminated-quote' } })
  })

  it('尾部孤立反斜杠拒绝', () => {
    const result = parseCurlCommand('curl http://x.test/a \\', null)
    expect(result).toEqual({ ok: false, error: { position: 0, reason: 'bad-syntax' } })
  })
})

describe('cURL 解析：参数面', () => {
  it('BaseUrl 命中拆相对模板＋query 拆行（与历史恢复同口径：%XX 解、+ 字面保留）', () => {
    const result = parseCurlCommand(`curl 'http://x.test/api/users?q=a%20b&r=x+y'`, 'http://x.test')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.pathTemplate).toBe('/api/users')
    expect(result.draft.paramsJson).toBe(
      JSON.stringify([
        { name: 'q', value: 'a b' },
        { name: 'r', value: 'x+y' },
      ]),
    )
  })

  it('BaseUrl 未命中（或未配置）存完整 URL', () => {
    const result = parseCurlCommand(`curl 'https://other.test/v1/a?k=1'`, 'http://x.test')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.pathTemplate).toBe('https://other.test/v1/a')
  })

  it('-X 显式方法（小写归一为大写）；无 -X 有 -d 推 POST、无 body 默认 GET', () => {
    const withX = parseCurlCommand(`curl -X delete 'http://x.test/a'`, null)
    expect(withX.ok && withX.draft.method).toBe('DELETE')

    const withData = parseCurlCommand(`curl 'http://x.test/a' -d 'x=1'`, null)
    expect(withData.ok && withData.draft.method).toBe('POST')

    const bare = parseCurlCommand(`curl 'http://x.test/a'`, null)
    expect(bare.ok && bare.draft.method).toBe('GET')
  })

  it('-H 行回填（值可空；冒号前后空白容忍）；Authorization 原样进头行', () => {
    const result = parseCurlCommand(
      `curl 'http://x.test/a' -H 'Authorization: Bearer tk' -H 'X-Empty:'`,
      null,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.headersJson).toBe(
      JSON.stringify([
        { name: 'Authorization', value: 'Bearer tk' },
        { name: 'X-Empty', value: '' },
      ]),
    )
  })

  it('多个 -d 拼接为一段（curl 语义无分隔符）', () => {
    const result = parseCurlCommand(
      `curl 'http://x.test/a' -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1' -d '&b=2'`,
      null,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.body).toBe(
      '{"kind":"urlencoded","rows":[{"name":"a","value":"1"},{"name":"b","value":"2"}]}',
    )
  })

  it('Content-Type: application/json 的 -d 体归 json 信封（原文不改写）', () => {
    const result = parseCurlCommand(
      `curl 'http://x.test/a' -H 'Content-Type: application/json' --data-raw '{"a": 1}'`,
      null,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.body).toBe('{"kind":"json","text":"{\\"a\\": 1}"}')
  })

  it('无 Content-Type 的 -d 体按内容嗅探（合法 JSON→json、< 起头→xml、其余→text）', () => {
    const json = parseCurlCommand(`curl 'http://x.test/a' -d '{"a":1}'`, null)
    expect(json.ok && json.draft.body).toBe('{"kind":"json","text":"{\\"a\\":1}"}')

    const xml = parseCurlCommand(`curl 'http://x.test/a' -d '<root/>'`, null)
    expect(xml.ok && xml.draft.body).toBe('{"kind":"xml","text":"<root/>"}')

    const text = parseCurlCommand(`curl 'http://x.test/a' -d 'hello'`, null)
    expect(text.ok && text.draft.body).toBe('{"kind":"text","text":"hello"}')
  })

  it('urlencoded：-d 体拆行（%XX 解码）＋ --data-urlencode 行（值字面入行）', () => {
    const result = parseCurlCommand(
      `curl 'http://x.test/a' -H 'Content-Type: application/x-www-form-urlencoded' ` +
        `-d 'q=a%20b' --data-urlencode 'note=a%20b'`,
      null,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 行序：--data-urlencode 行在前（--data-urlencode 线索先归集），-d 体拆行随后
    expect(result.draft.body).toBe(
      '{"kind":"urlencoded","rows":[{"name":"note","value":"a%20b"},{"name":"q","value":"a b"}]}',
    )
  })

  it('-F 文本字段归 form-data 行', () => {
    const result = parseCurlCommand(`curl 'http://x.test/a' -F 'payload=hi' -F 'n=v'`, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.body).toBe(
      '{"kind":"form-data","rows":[{"name":"payload","value":"hi"},{"name":"n","value":"v"}]}',
    )
  })

  it('-F name=@路径 归 form-data file 行（路径入 value、type=file）；;type= 后缀容忍剥离', () => {
    const result = parseCurlCommand(
      `curl 'http://x.test/a' -F 'up=@/tmp/a.png' -F 'doc=@C:\\tmp\\note.txt;type=text/plain'`,
      null,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.body).toBe(
      '{"kind":"form-data","rows":[' +
        '{"name":"up","value":"/tmp/a.png","type":"file"},' +
        '{"name":"doc","value":"C:\\\\tmp\\\\note.txt","type":"file"}]}',
    )
  })

  it('-F 分号指令形态仅容忍 ;type=，其余拒绝（不猜测）', () => {
    const bad = parseCurlCommand(`curl 'http://x.test/a' -F 'up=@/tmp/a.png;filename=x.png'`, null)
    expect(bad).toEqual({ ok: false, error: { position: 4, reason: 'bad-form' } })
  })

  it('产出可直接 seed 的草稿形态与 Tab 标题（方法 + 模板，超限截断）', () => {
    const result = parseCurlCommand(`curl -X PUT 'http://x.test/a/b/c'`, 'http://x.test')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.bodyTruncated).toBe(false)
    expect(result.draft.sensitiveHeaderNames).toEqual([])
    expect(result.draft.sourceServiceId).toBeNull()
    expect(result.title).toBe('PUT /a/b/c')
  })

  it('可忽略开关（-k -s -L --compressed 等）不构成拒绝；组合短 flag（-sS）仍拒绝', () => {
    const result = parseCurlCommand(`curl -s -S -k -L --compressed 'http://x.test/a'`, null)
    expect(result.ok).toBe(true)
    const combined = parseCurlCommand(`curl -sS 'http://x.test/a'`, null)
    expect(combined).toEqual({ ok: false, error: { position: 2, reason: 'unsupported-flag' } })
  })
})

describe('cURL 解析：拒绝面（宁缺毋滥，错误位＋原因）', () => {
  it.each([
    [`wget 'http://x.test/a'`, 1, 'not-curl'],
    [`curl`, 0, 'missing-url'],
    [`curl 'http://x.test/a' 'http://x.test/b'`, 3, 'multiple-url'],
    [`curl 'ftp://x.test/a'`, 0, 'invalid-url'],
    [`curl -o out.txt 'http://x.test/a'`, 2, 'unsupported-flag'],
    [`curl -u user:pass 'http://x.test/a'`, 2, 'unsupported-flag'],
    [`curl 'http://x.test/a' -X`, 3, 'missing-value'],
    [`curl -X TRACE 'http://x.test/a'`, 3, 'bad-method'],
    [`curl 'http://x.test/a' -H 'X-Bad'`, 4, 'bad-header'],
    [`curl 'http://x.test/a' -H 'X-Del;'`, 4, 'bad-header'],
    [`curl 'http://x.test/a' -d @file.json`, 4, 'file-source'],
    [`curl 'http://x.test/a' -F 'plain'`, 4, 'bad-form'],
    [`curl 'http://x.test/a' -F '@nofield.png'`, 4, 'bad-form'],
    [`curl 'http://x.test/a' --data-urlencode '=v'`, 4, 'bad-urlencoded'],
    [`curl 'http://x.test/a' --data-urlencode '@file'`, 4, 'file-source'],
    [`curl 'http://x.test/a' -d 'x=1' -F 'a=b'`, 0, 'mixed-body'],
  ])('%s → %s@%s', (source, position, reason) => {
    expect(parseCurlCommand(source, null)).toEqual({
      ok: false,
      error: { position, reason },
    })
  })
})

describe('cURL 序列化 ↔ 解析 round-trip', () => {
  it('序列化产物可再解析回等价草稿（method / URL / 头 / 体）', () => {
    const command = serializeCurl(
      makeInput({
        method: 'POST',
        url: 'https://x.test/v1/orders?page=2',
        headers: [{ name: 'X-Trace', value: '1' }],
        requestAuth: { type: 'bearer', token: 'tk' },
        body: {
          kind: 'urlencoded',
          text: '',
          rows: [{ name: 'a', value: 'b c' }],
          fromEnvelope: true,
        },
      }),
    )
    const result = parseCurlCommand(command, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { draft } = result
    expect(draft.method).toBe('POST')
    expect(draft.pathTemplate).toBe('https://x.test/v1/orders')
    expect(draft.paramsJson).toBe(JSON.stringify([{ name: 'page', value: '2' }]))
    expect(draft.headersJson).toBe(
      JSON.stringify([
        { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
        { name: 'X-Trace', value: '1' },
        { name: 'Authorization', value: 'Bearer tk' },
      ]),
    )
    expect(draft.body).toBe('{"kind":"urlencoded","rows":[{"name":"a","value":"b c"}]}')
  })

  it('form-data file 行 round-trip：导出的 name=@路径 可解析回 type=file 行', () => {
    const command = serializeCurl(
      makeInput({
        method: 'POST',
        body: {
          kind: 'form-data',
          text: '',
          rows: [
            { name: 'note', value: 'hi' },
            { name: 'upload', value: '/tmp/my file.png', type: 'file' },
          ],
          fromEnvelope: true,
        },
      }),
    )
    const result = parseCurlCommand(command, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.body).toBe(
      JSON.stringify({
        kind: 'form-data',
        rows: [
          { name: 'note', value: 'hi' },
          { name: 'upload', value: '/tmp/my file.png', type: 'file' },
        ],
      }),
    )
  })
})
