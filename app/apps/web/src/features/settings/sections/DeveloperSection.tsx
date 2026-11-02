import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
  ToggleGroup,
  ToggleGroupItem,
  toast,
} from '@workspace/ui/components'
import * as React from 'react'

import { useQueryClient } from '@tanstack/react-query'
import { appLogDir } from '@tauri-apps/api/path'

import { useI18n } from '@/i18n'
import { useIpcMutation, useIpcQuery } from '@/services/ipc-query'
import { localizeIpcError, reportError } from '@/services/error-center'
import {
  checkUpdateSource,
  getCliStatus,
  getDiagnostics,
  registerCliPath,
  unregisterCliPath,
} from '@/services/ipc'
import { openLogDirectory, pickDirectory } from '@/services/log-dir'
import {
  LOG_LEVELS,
  UPDATE_SOURCE_TYPES,
  type LogLevel,
  type UpdateSourceSetting,
} from '@/lib/settings-schema'
import { useSettingsStore } from '@/stores/settings.store'
import { useTabsStore } from '@/stores/tabs.store'
import { useCommandsStore } from '@/features/commands/commands.store'
import { SettingRow, SettingRows } from '@/components/common/SettingRow'
import { CliStatusBlock } from './CliStatusBlock'

/**
 * 开发者组：devMode 开关**常驻**（关掉后仍能再打开），
 * 组内其余条目按 devMode **条件渲染**（关闭即不渲染而非 disabled，
 * 减少视觉噪音；搜索过滤同语义见 SettingsDialog）。devMode 开关（F12 唯一
 * 闸门在 Rust 侧——set_setting 写库成功后由 devtools 服务热更 WebView2
 * AreDevToolsEnabled）＋ logLevel 分段（≤4 档，Rust 热更新链路）
 * ＋ 复制诊断信息（get_diagnostics → 剪贴板）＋ 打开日志目录。
 */
export function DeveloperSection() {
  const { t } = useI18n()
  // 工作台诊断计数（会话态）：Tab 数随开关 Tab 即时增减、命令注册数随
  // feature 挂载/卸载增减（注册表不随挂载循环增长——资源四问可观察面）
  const openTabCount = useTabsStore((s) => s.tabs.length)
  const commandCount = useCommandsStore((s) => s.commands.length)
  const devMode = useSettingsStore((s) => s.devMode.enabled)
  const setDevMode = useSettingsStore((s) => s.setDevMode)
  const logLevel = useSettingsStore((s) => s.logLevel.level)
  const setLogLevel = useSettingsStore((s) => s.setLogLevel)
  const logDir = useSettingsStore((s) => s.logDir)
  const setLogDir = useSettingsStore((s) => s.setLogDir)

  // 默认目录真值在 Tauri 侧（app_log_dir）：静态信息 Query 一次取值共享，
  // 自定义态直接显示 logDir.path，不经此值
  const defaultLogDirQuery = useIpcQuery({
    queryKey: ['app_log_dir'],
    queryFn: () => appLogDir(),
    staleTime: Number.POSITIVE_INFINITY,
  })

  const effectiveLogDir = logDir.path ?? defaultLogDirQuery.data ?? null

  // 复制诊断：get_diagnostics → 剪贴板，Mutation 承载 pending 与结果分支
  // （剪贴板/IPC 失败按瞬态呈现：具体失败文案直达用户，单一呈现通道）
  const copyDiagnosticsMutation = useIpcMutation({
    mutationFn: async () => {
      const diagnostics = await getDiagnostics()
      const text = [
        `version: ${diagnostics.version}`,
        `platform: ${diagnostics.platform} (${diagnostics.arch}, ${diagnostics.family})`,
        `build: ${diagnostics.build}`,
        `tasks: active=${diagnostics.activeTasks}`,
        `tabs: open=${openTabCount}`,
        `log: level=${diagnostics.log.level}, ring=${diagnostics.log.ringCount}/${diagnostics.log.ringCapacity}`,
      ].join('\n')
      await navigator.clipboard.writeText(text)
    },
    onSuccess: () => {
      toast.success(t('settings.copyDiagnosticsDone'))
    },
    onError: () => {
      toast.error(t('settings.copyDiagnosticsFailed'))
    },
  })
  const copying = copyDiagnosticsMutation.isPending

  /** 更改目录：选完即落库 + 重启生效提示；取消静默；选择器失败走统一上报 */
  const changeLogDir = async (): Promise<void> => {
    let picked: string | null
    try {
      picked = await pickDirectory()
    } catch (error) {
      reportError(error)
      return
    }
    if (!picked) return
    setLogDir(picked)
    toast.info(t('settings.logDirRestart'))
  }

  /** 恢复默认：只清配置不搬回，旧目录文件留原地，重启后写回默认目录 */
  const resetLogDir = (): void => {
    setLogDir(null)
    toast.info(t('settings.logDirRestart'))
  }

  // —— CLI 开关（注册表真值镜像）：显示态唯一来自 get_cli_status.registered，
  // settings 不持副本。打开对话框探测一次（staleTime 0），注册 / 注销成功后
  // 失效重取；对话框关闭即查询作废（无手动刷新）。
  // 拨开＝弹窗（弹窗期间开关「开＋禁用」待定态，镜像模型下无乐观落库可回弹），
  // [注册] 成功才亮；拨关＝静默注销（可逆免确认），失败 toast、开关随重取的
  // 注册态回弹开 ——
  const queryClient = useQueryClient()
  const cliStatusQuery = useIpcQuery({
    queryKey: ['get_cli_status'],
    queryFn: getCliStatus,
    staleTime: 0,
  })
  const cliStatus = cliStatusQuery.data
  const invalidateCliStatus = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['get_cli_status'] })

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [registerError, setRegisterError] = React.useState<string | null>(null)

  const registerMutation = useIpcMutation({
    mutationFn: registerCliPath,
    // 返回 Promise 让 mutation 在重取完成前保持 pending：开关从「待定」直接
    // 落到重取后的「开」，不经过一帧旧值
    onSuccess: async () => {
      await invalidateCliStatus()
      setDialogOpen(false)
      // dev 构建（tauri dev）的 exe 在 target 目录，注册进 PATH 的是开发
      // 目录而非安装目录——用警示文案提醒正式安装后需重新注册
      toast.success(
        cliStatus?.isDevBuild
          ? t('settings.cliRegisteredDevToast')
          : t('settings.cliRegisteredToast'),
      )
    },
    onError: (error) => {
      // 失败弹窗原位停留，本地化文案透传到弹窗内（弹窗即呈现面，不再叠 toast）
      setRegisterError(localizeIpcError(error))
    },
  })

  const unregisterMutation = useIpcMutation({
    mutationFn: unregisterCliPath,
    onSuccess: () => invalidateCliStatus(),
    // 注销失败：开关拨动即确认语义下不弹窗，经统一上报 toast（单一呈现通道）
    onError: reportError,
  })

  const registering = registerMutation.isPending
  const unregistering = unregisterMutation.isPending
  // 弹窗期间待定态恒开；注销进行中乐观关（失败后 isPending 复位、注册态仍
  // 为 true 即回弹开）；其余时刻镜像注册态
  const cliChecked = dialogOpen ? true : unregistering ? false : (cliStatus?.registered ?? false)

  /** 拨开：弹窗（不写 PATH）；拨关：静默注销 */
  const handleCliToggle = (checked: boolean): void => {
    if (checked) {
      setRegisterError(null)
      setDialogOpen(true)
      return
    }
    unregisterMutation.mutate()
  }

  /** 跳过 / Esc / 遮罩 / 取消同语义：关弹窗、不写 PATH，开关回镜像态 */
  const closeDialog = (): void => {
    setDialogOpen(false)
    setRegisterError(null)
  }

  const register = (): void => {
    setRegisterError(null)
    registerMutation.mutate()
  }

  // —— 更新源：类型三选（云禁用占位）+ 路径，保存前 Rust 可达性校验 ——
  const updateSource = useSettingsStore((s) => s.updateSource)
  const setUpdateSource = useSettingsStore((s) => s.setUpdateSource)
  // 未保存编辑态：类型切换 / UNC 输入改本地态，保存（或选目录）时校验后整键落库。
  // UNC 输入框初始值仅取 network 类型的存量路径——local 与 network 的 path
  // 语义不同（本机盘符路径 ≠ UNC），跨类型预填会诱导把本机路径误存为网络源
  const [uiType, setUiType] = React.useState(updateSource.type)
  const [networkPath, setNetworkPath] = React.useState(
    updateSource.type === 'network' ? (updateSource.path ?? '') : '',
  )
  // 校验中（防重复提交）
  const [savingSource, setSavingSource] = React.useState(false)

  /** 保存（local/network）：可达性校验失败 toast 报错并阻止保存（带病保存无意义） */
  const saveUpdateSource = async (setting: UpdateSourceSetting): Promise<void> => {
    setSavingSource(true)
    try {
      await checkUpdateSource(setting.path ?? '')
    } catch (error) {
      reportError(error)
      return
    } finally {
      setSavingSource(false)
    }
    setUpdateSource(setting)
    toast.success(t('settings.updateSourceSaved'))
  }

  /** 本机文件夹：选完目录即校验 + 落库；取消静默；选择器失败走统一上报 */
  const chooseLocalSource = async (): Promise<void> => {
    let picked: string | null
    try {
      picked = await pickDirectory()
    } catch (error) {
      reportError(error)
      return
    }
    if (!picked) return
    await saveUpdateSource({ type: 'local', path: picked })
  }

  return (
    <section aria-label={t('settings.navDeveloper')} className="p-6">
      <h2 className="text-sm font-medium">{t('settings.navDeveloper')}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.navDeveloperDesc')}</p>

      <div className="mt-5">
        <SettingRows>
          <SettingRow
            label={t('settings.devModeLabel')}
            description={t('settings.devModeDesc')}
            htmlFor="settings-devmode"
            control={
              <Switch id="settings-devmode" checked={devMode} onCheckedChange={setDevMode} />
            }
          />

          {/* devMode 门控条目：关闭即不渲染，开启即时出现（store 订阅驱动） */}
          {devMode && (
            <>
              <SettingRow
                label={t('settings.workbenchDiagnostics')}
                description={t('settings.workbenchDiagnosticsDesc', {
                  tabs: openTabCount,
                  commands: commandCount,
                })}
                control={
                  <span className="font-mono text-xs text-muted-foreground">{openTabCount}</span>
                }
              />
              <SettingRow
                label={t('settings.logLevelLabel')}
                description={t('settings.logLevelDesc')}
                control={
                  // Base UI ToggleGroup 为数组值语义：单值分段以单元素数组承载；
                  // 再次点击当前项回传空数组——保持原级别不变
                  <ToggleGroup
                    variant="outline"
                    value={[logLevel]}
                    onValueChange={(values) => {
                      const latest = values[0]
                      if (
                        typeof latest === 'string' &&
                        (LOG_LEVELS as readonly string[]).includes(latest)
                      ) {
                        setLogLevel(latest as LogLevel)
                      }
                    }}
                    aria-label={t('settings.logLevelLabel')}
                  >
                    {LOG_LEVELS.map((level) => (
                      <ToggleGroupItem
                        key={level}
                        value={level}
                        className="px-3 font-mono text-xs uppercase"
                      >
                        {level}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                }
              />

              <SettingRow
                label={t('settings.copyDiagnostics')}
                description={t('settings.copyDiagnosticsDesc')}
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyDiagnosticsMutation.mutate()}
                    disabled={copying}
                  >
                    {t('settings.copyDiagnostics')}
                  </Button>
                }
              />

              <SettingRow
                label={t('settings.openLogDir')}
                description={t('settings.openLogDirDesc')}
                control={
                  <Button variant="outline" size="sm" onClick={() => void openLogDirectory()}>
                    {t('settings.openLogDir')}
                  </Button>
                }
              />

              {/* 日志目录：描述即当前生效目录（默认态经 appLogDir 解析）；
                  更改/恢复均只落库，重启生效 */}
              <SettingRow
                label={t('settings.logDirLabel')}
                description={effectiveLogDir ?? undefined}
                control={
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => void changeLogDir()}>
                      {t('settings.logDirChange')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={resetLogDir}
                      disabled={logDir.path === null}
                    >
                      {t('settings.logDirReset')}
                    </Button>
                  </div>
                }
              />

              {/* 更新源：类型三选；下方路径区随类型变化。
                  「更新源」=软件版本更新渠道，与同步域「更新」无关 */}
              <SettingRow
                label={t('settings.updateSourceLabel')}
                description={t('settings.updateSourceDesc')}
                control={
                  <ToggleGroup
                    variant="outline"
                    value={[uiType]}
                    onValueChange={(values) => {
                      const latest = values[0]
                      if (
                        typeof latest === 'string' &&
                        (UPDATE_SOURCE_TYPES as readonly string[]).includes(latest)
                      ) {
                        setUiType(latest as UpdateSourceSetting['type'])
                      }
                    }}
                    aria-label={t('settings.updateSourceLabel')}
                  >
                    {/* 云服务留坑（Out of scope）：禁用占位不可选 */}
                    <ToggleGroupItem value="cloud" disabled className="px-3 text-xs">
                      {t('settings.updateSourceCloud')}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="local" className="px-3 text-xs">
                      {t('settings.updateSourceLocal')}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="network" className="px-3 text-xs">
                      {t('settings.updateSourceNetwork')}
                    </ToggleGroupItem>
                  </ToggleGroup>
                }
              />

              {/* 路径区：与 SettingRow 同款布局（label 域承载动态内容，不用其 string API） */}
              <div className="flex items-center justify-between gap-6 px-4 py-3.5">
                {uiType === 'cloud' && (
                  <p className="min-w-0 text-xs text-muted-foreground">
                    {t('settings.updateSourceCloudPlaceholder')}
                  </p>
                )}
                {uiType === 'local' && (
                  <>
                    <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                      {updateSource.type === 'local' && updateSource.path
                        ? updateSource.path
                        : t('settings.updateSourceNone')}
                    </p>
                    <div className="shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void chooseLocalSource()}
                        disabled={savingSource}
                      >
                        {t('settings.updateSourceChoose')}
                      </Button>
                    </div>
                  </>
                )}
                {uiType === 'network' && (
                  <>
                    <div className="min-w-0 flex-1">
                      <Input
                        type="text"
                        value={networkPath}
                        onChange={(event) => setNetworkPath(event.target.value)}
                        placeholder={t('settings.updateSourcePathPlaceholder')}
                        className="h-9 font-mono text-xs"
                        aria-label={t('settings.updateSourcePathPlaceholder')}
                      />
                    </div>
                    <div className="shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={savingSource || networkPath.trim().length === 0}
                        onClick={() =>
                          void saveUpdateSource({ type: 'network', path: networkPath.trim() })
                        }
                      >
                        {t('settings.updateSourceSave')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </SettingRows>
      </div>

      {/* ——「高级」小节（A 形态小节标题）：CLI 行常驻，不受 devMode 门控；
          开关行下方恒显三行状态块（版本 / 路径 / PATH），开关关时同样显示 —— */}
      <div className="mt-6">
        <h3 className="text-sm font-medium">{t('settings.advancedTitle')}</h3>
        <div className="mt-3">
          <SettingRows>
            <SettingRow
              label={t('settings.cliLabel')}
              description={t('settings.cliDescription')}
              htmlFor="settings-cli"
              control={
                <Switch
                  id="settings-cli"
                  checked={cliChecked}
                  onCheckedChange={handleCliToggle}
                  // 探测未回来前不知真值，不接受拨动
                  disabled={dialogOpen || unregistering || cliStatus === undefined}
                />
              }
            />
            <CliStatusBlock status={cliStatus} error={cliStatusQuery.error} />
          </SettingRows>
        </div>
      </div>

      {/* 注册弹窗：Esc/遮罩＝跳过语义（开关回镜像态）；注册中不接受关闭 */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (registering) return
          if (!open) closeDialog()
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          overlayClassName="supports-backdrop-filter:backdrop-blur-md"
          data-testid="cli-register-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('settings.cliDialogTitle')}</DialogTitle>
            <DialogDescription>{t('settings.cliDialogDescription')}</DialogDescription>
          </DialogHeader>
          {registerError && (
            <p role="alert" className="text-xs text-destructive">
              {registerError}
            </p>
          )}
          <DialogFooter className="gap-2">
            {registerError ? (
              <>
                <Button variant="outline" size="sm" onClick={closeDialog}>
                  {t('settings.cliCancel')}
                </Button>
                <Button size="sm" onClick={register} disabled={registering}>
                  {t('settings.cliRetry')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={closeDialog}>
                  {t('settings.cliSkip')}
                </Button>
                <Button size="sm" onClick={register} disabled={registering}>
                  {registering ? t('settings.cliRegistering') : t('settings.cliRegister')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
