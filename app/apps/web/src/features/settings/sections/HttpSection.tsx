import * as React from 'react'

import {
  Input,
  RadioGroup,
  RadioGroupItem,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
} from '@workspace/ui/components'

import { useI18n, type DictKey } from '@/i18n'
import { HTTP_PROXY_MODES, HTTP_TIMEOUT_STEPS, type HttpProxyMode } from '@/lib/settings-schema'
import { useSettingsStore } from '@/stores/settings.store'
import { SettingRow, SettingRows } from '@/components/common/SettingRow'

/**
 * HTTP 组：全局 HTTP 行为四行（超时 / 跟随重定向 / 校验 TLS 证书 / 代理）。
 * 作用域＝机器与网络语境（settings 单键 `http`，不随工作空间切换）；整键写穿
 * （Rust 写前校验＋EffectHost 重建 Client，在途请求不受影响）。
 *
 * 超时＝四档分段控件（不限制 / 10 / 30 / 60 秒，沿设置面板「分段 ≤4 档」约定）；
 * 代理＝单选两态＋选「自定义」动态出现地址行（沿「自定义地址行动态出现」约定）：
 * 地址在 blur / Enter 落定后才整键写（custom 缺 url 会被 Rust 写前校验拒绝，
 * 中间输入态不发起写）。
 */

/** 分段控件值域：null（不限制）映射 'none'，档位映射数字串 */
const TIMEOUT_NONE = 'none'

/** 代理两态的标签键（单选项文案经字典注入） */
const PROXY_LABEL_KEYS: Record<HttpProxyMode, DictKey> = {
  none: 'settings.httpProxyNone',
  custom: 'settings.httpProxyCustom',
}

export function HttpSection() {
  const { t } = useI18n()
  const http = useSettingsStore((s) => s.http)
  const setHttp = useSettingsStore((s) => s.setHttp)

  // 代理模式经本地编辑态承接：选「自定义」先出地址行，地址落定才写整键；
  // 库内已有地址时选回「自定义」直接复写（恢复既有配置）
  const [proxyMode, setProxyMode] = React.useState<HttpProxyMode>(http.proxy.mode)
  const [proxyUrl, setProxyUrl] = React.useState(http.proxy.url ?? '')

  const timeoutValue = http.timeoutSeconds === null ? TIMEOUT_NONE : String(http.timeoutSeconds)

  /** 地址落定（blur / Enter 共用）：非空即整键写；空则回落已生效值（无则清空待输入） */
  const commitProxyUrl = () => {
    const trimmed = proxyUrl.trim()
    if (trimmed !== '') {
      setHttp({ proxy: { mode: 'custom', url: trimmed } })
    } else {
      setProxyUrl(http.proxy.mode === 'custom' ? (http.proxy.url ?? '') : '')
    }
  }

  /** 切到「自定义」时若已有可用地址则立即复写，否则等地址输入落定 */
  const handleProxyModeChange = (mode: HttpProxyMode) => {
    setProxyMode(mode)
    if (mode === 'none') {
      setHttp({ proxy: { mode: 'none', url: null } })
      return
    }
    if (proxyUrl.trim() !== '') setHttp({ proxy: { mode: 'custom', url: proxyUrl.trim() } })
  }

  return (
    <section aria-label={t('settings.navHttp')} className="p-6">
      <h2 className="text-sm font-medium">{t('settings.navHttp')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.navHttpDesc')}</p>

      <div className="mt-5">
        <SettingRows>
          <SettingRow
            label={t('settings.httpTimeoutLabel')}
            description={t('settings.httpTimeoutDesc')}
            control={
              // Base UI ToggleGroup 为数组值语义：单值分段以单元素数组承载；
              // 再次点击当前项回传空数组——保持原档位不变
              <ToggleGroup
                variant="outline"
                value={[timeoutValue]}
                onValueChange={(values) => {
                  const latest = values[0]
                  if (latest === TIMEOUT_NONE) {
                    setHttp({ timeoutSeconds: null })
                    return
                  }
                  const step = Number(latest)
                  if ((HTTP_TIMEOUT_STEPS as readonly number[]).includes(step)) {
                    setHttp({ timeoutSeconds: step })
                  }
                }}
                aria-label={t('settings.httpTimeoutLabel')}
              >
                <ToggleGroupItem value={TIMEOUT_NONE} className="px-3 text-xs">
                  {t('settings.httpTimeoutUnlimited')}
                </ToggleGroupItem>
                {HTTP_TIMEOUT_STEPS.map((seconds) => (
                  <ToggleGroupItem key={seconds} value={String(seconds)} className="px-3 text-xs">
                    {t('settings.httpTimeoutOption', { seconds })}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            }
          />

          <SettingRow
            label={t('settings.httpRedirectLabel')}
            description={t('settings.httpRedirectDesc')}
            htmlFor="settings-http-redirect"
            control={
              <Switch
                id="settings-http-redirect"
                checked={http.redirect}
                onCheckedChange={(redirect) => setHttp({ redirect })}
              />
            }
          />

          <SettingRow
            label={t('settings.httpTlsLabel')}
            description={t('settings.httpTlsDesc')}
            htmlFor="settings-http-tls"
            control={
              <Switch
                id="settings-http-tls"
                checked={http.tlsVerify}
                onCheckedChange={(tlsVerify) => setHttp({ tlsVerify })}
              />
            }
          />

          <SettingRow
            label={t('settings.httpProxyLabel')}
            description={t('settings.httpProxyDesc')}
            control={
              <RadioGroup
                aria-label={t('settings.httpProxyLabel')}
                value={proxyMode}
                onValueChange={(value) => {
                  const mode = HTTP_PROXY_MODES.find((candidate) => candidate === value)
                  if (mode) handleProxyModeChange(mode)
                }}
                className="flex w-auto flex-row items-center gap-4"
              >
                {HTTP_PROXY_MODES.map((mode) => (
                  <span key={mode} className="flex items-center gap-1.5">
                    <RadioGroupItem value={mode} id={`settings-http-proxy-${mode}`} />
                    <label
                      htmlFor={`settings-http-proxy-${mode}`}
                      className="cursor-pointer text-sm leading-5"
                    >
                      {t(PROXY_LABEL_KEYS[mode])}
                    </label>
                  </span>
                ))}
              </RadioGroup>
            }
          />

          {/* 自定义地址行：选「自定义」动态出现（scheme 自动判别 http / https / socks5） */}
          {proxyMode === 'custom' && (
            <div className="flex items-center justify-between gap-6 px-4 py-3.5">
              <label
                htmlFor="settings-http-proxy-url"
                className="shrink-0 text-sm leading-5 font-medium"
              >
                {t('settings.httpProxyUrlLabel')}
              </label>
              <div className="min-w-0 flex-1">
                <Input
                  id="settings-http-proxy-url"
                  value={proxyUrl}
                  onChange={(event) => setProxyUrl(event.target.value)}
                  onBlur={commitProxyUrl}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitProxyUrl()
                    }
                  }}
                  placeholder={t('settings.httpProxyUrlPlaceholder')}
                  spellCheck={false}
                  className="h-8 font-mono text-xs"
                />
              </div>
            </div>
          )}
        </SettingRows>
      </div>
    </section>
  )
}
