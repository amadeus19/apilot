import { Button, Input, ToggleGroup, ToggleGroupItem, toast } from '@workspace/ui/components'
import * as React from 'react'

import { useI18n } from '@/i18n'
import { reportError } from '@/services/error-center'
import { checkUpdateSource } from '@/services/ipc'
import {
  DEFAULT_CLOUD_BASE_URL,
  UPDATE_SOURCE_KINDS,
  isValidCloudSourceUrl,
  type UpdateSourceKind,
  type UpdateSourceSetting,
} from '@/lib/settings-schema'
import { useSettingsStore } from '@/stores/settings.store'
import { pickDirectory } from '@/services/log-dir'
import { SettingRow } from '@/components/common/SettingRow'

/**
 * 更新源表单：类型二选（folder / cloud）+ 随类型的配置区。
 * 「更新源」=软件版本更新渠道，与同步域「更新」无关。
 *
 * 未保存编辑态：类型切换 / 输入改本地态，保存（或选目录）时校验后整键落库。
 * 两类字段同键共存——保存 folder 只改 path、保存 cloud 只改 baseUrl /
 * mirrorPrefix，另一类配置原样保留，切回即恢复。
 *
 * 校验分工：folder 保存前过 Rust 可达性校验（本机 / UNC 目录存在性）；
 * cloud 不预检——目录可达性校验对 URL 无意义，云端不可达由「检查更新」
 * 流程按 unreachable 状态反馈。cloud 侧仅做 URL 形态闸门（空 = 默认语义
 * 放行，非空须 http(s) 绝对地址）。
 */
export function UpdateSourceForm() {
  const { t } = useI18n()
  const updateSource = useSettingsStore((s) => s.updateSource)
  const setUpdateSource = useSettingsStore((s) => s.setUpdateSource)

  const [uiKind, setUiKind] = React.useState<UpdateSourceKind>(updateSource.kind)
  // folder 手输态：存量目录路径不预填（当前生效路径已由上方显示行承载），
  // 空态 + 示例占位引导手输本机或 UNC 路径
  const [folderPath, setFolderPath] = React.useState('')
  // cloud 输入态：存量配置回显；首次进入预填默认仓库地址（显示实际生效值）
  const [baseUrl, setBaseUrl] = React.useState(updateSource.baseUrl ?? DEFAULT_CLOUD_BASE_URL)
  const [mirrorPrefix, setMirrorPrefix] = React.useState(updateSource.mirrorPrefix)
  // 校验 / 落库中（防重复提交）
  const [saving, setSaving] = React.useState(false)

  // cloud URL 形态派生：非法时禁用保存并就地提示
  const cloudUrlValid = isValidCloudSourceUrl(baseUrl.trim())

  /**
   * 保存：folder 源先过 Rust 可达性校验（失败 toast 报错并阻止落库——
   * 带病保存无意义）；落库后本地编辑态对齐已存值，类型切换往返不漂移。
   */
  const persistUpdateSource = async (setting: UpdateSourceSetting): Promise<void> => {
    if (setting.kind === 'folder') {
      setSaving(true)
      try {
        await checkUpdateSource(setting.path ?? '')
      } catch (error) {
        reportError(error)
        return
      } finally {
        setSaving(false)
      }
    }
    setUpdateSource(setting)
    toast.success(t('settings.updateSourceSaved'))
    setUiKind(setting.kind)
    if (setting.kind === 'folder') {
      setFolderPath('')
    } else {
      setBaseUrl(setting.baseUrl ?? DEFAULT_CLOUD_BASE_URL)
      setMirrorPrefix(setting.mirrorPrefix)
    }
  }

  /** folder·选择目录：选完即校验 + 落库；取消静默；选择器失败走统一上报 */
  const chooseFolderSource = async (): Promise<void> => {
    let picked: string | null
    try {
      picked = await pickDirectory()
    } catch (error) {
      reportError(error)
      return
    }
    if (!picked) return
    await persistUpdateSource({
      kind: 'folder',
      path: picked,
      baseUrl: updateSource.baseUrl,
      mirrorPrefix: updateSource.mirrorPrefix,
    })
  }

  /** folder·手输保存：可达性校验后整键落库（与选择目录同一校验链） */
  const saveFolderPath = (): void => {
    const trimmed = folderPath.trim()
    if (trimmed === '') return
    void persistUpdateSource({
      kind: 'folder',
      path: trimmed,
      baseUrl: updateSource.baseUrl,
      mirrorPrefix: updateSource.mirrorPrefix,
    })
  }

  /** cloud·保存：仓库地址空 = 默认地址（null），镜像前缀 trim 后落库（'' = 直连） */
  const saveCloudSource = (): void => {
    const trimmedBase = baseUrl.trim()
    void persistUpdateSource({
      kind: 'cloud',
      path: updateSource.path,
      baseUrl: trimmedBase === '' ? null : trimmedBase,
      mirrorPrefix: mirrorPrefix.trim(),
    })
  }

  return (
    <>
      <SettingRow
        label={t('settings.updateSourceLabel')}
        description={t('settings.updateSourceDesc')}
        control={
          // Base UI ToggleGroup 为数组值语义：单值分段以单元素数组承载；
          // 再次点击当前项回传空数组——保持原类型不变
          <ToggleGroup
            variant="outline"
            value={[uiKind]}
            onValueChange={(values) => {
              const latest = values[0]
              if (
                typeof latest === 'string' &&
                (UPDATE_SOURCE_KINDS as readonly string[]).includes(latest)
              ) {
                setUiKind(latest as UpdateSourceKind)
              }
            }}
            aria-label={t('settings.updateSourceLabel')}
          >
            <ToggleGroupItem value="folder" className="px-3 text-xs">
              {t('settings.updateSourceFolder')}
            </ToggleGroupItem>
            <ToggleGroupItem value="cloud" className="px-3 text-xs">
              {t('settings.updateSourceCloud')}
            </ToggleGroupItem>
          </ToggleGroup>
        }
      />

      {/* folder 表单：当前生效目录显示行 + 选择目录（选完即存）；下方手输行
          覆盖 UNC 等不便经目录选择器到达的路径，保存走同一校验链 */}
      {uiKind === 'folder' && (
        <>
          <div className="flex items-center justify-between gap-6 px-4 py-3.5">
            <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {updateSource.path ? updateSource.path : t('settings.updateSourceNone')}
            </p>
            <div className="shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void chooseFolderSource()}
                disabled={saving}
              >
                {t('settings.updateSourceChoose')}
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-6 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <Input
                type="text"
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                placeholder={t('settings.updateSourcePathPlaceholder')}
                className="h-9 font-mono text-xs"
                aria-label={t('settings.updateSourcePathPlaceholder')}
              />
            </div>
            <div className="shrink-0">
              <Button
                variant="outline"
                size="sm"
                disabled={saving || folderPath.trim().length === 0}
                onClick={saveFolderPath}
              >
                {t('settings.updateSourceSave')}
              </Button>
            </div>
          </div>
        </>
      )}

      {/* cloud 表单：仓库地址（空 = 默认官方仓库）+ 镜像前缀（空 = 直连） */}
      {uiKind === 'cloud' && (
        <div className="flex items-start justify-between gap-6 px-4 py-3.5">
          <div className="min-w-0 flex-1 space-y-2.5">
            <div>
              <Input
                type="text"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={DEFAULT_CLOUD_BASE_URL}
                className="h-9 font-mono text-xs"
                aria-label={t('settings.updateSourceBaseUrl')}
              />
              <p className="mt-1 text-micro text-muted-foreground">
                {t('settings.updateSourceBaseUrlDesc')}
              </p>
            </div>
            <div>
              <Input
                type="text"
                value={mirrorPrefix}
                onChange={(event) => setMirrorPrefix(event.target.value)}
                placeholder="https://mirror.example.com/"
                className="h-9 font-mono text-xs"
                aria-label={t('settings.updateSourceMirrorPrefix')}
              />
              <p className="mt-1 text-micro text-muted-foreground">
                {t('settings.updateSourceMirrorPrefixDesc')}
              </p>
            </div>
            {!cloudUrlValid && (
              <p role="alert" className="text-micro text-destructive">
                {t('settings.updateSourceUrlInvalid')}
              </p>
            )}
          </div>
          <div className="shrink-0">
            <Button
              variant="outline"
              size="sm"
              disabled={saving || !cloudUrlValid}
              onClick={saveCloudSource}
            >
              {t('settings.updateSourceSave')}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
