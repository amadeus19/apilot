import * as React from 'react'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from '@workspace/ui/components'

import { useI18n, type DictKey } from '@/i18n'
import { useTabsStore } from '@/stores/tabs.store'

import { parseCurlCommand, type CurlImportError } from './curl'
import { useDraftStore } from './draft.store'

/**
 * 从 cURL 导入对话框（接口编辑器 ⋯菜单入口）：粘贴 curl 命令 → 解析 →
 * 回填新草稿 Tab。解析器收窄常见形态，未识别形态显式拒绝（错误位＋原因
 * 行内呈现）；导入不动任何用户数据——草稿是内存态，落库只经草稿 Tab 的
 * 「另存为新接口」转正动作。
 */

/** 拒绝原因 → 字典键（纯原因文案；词位前缀单独拼接） */
const ERROR_REASON_KEYS: Record<CurlImportError['reason'], DictKey> = {
  'not-curl': 'editor.curlErrorNotCurl',
  'unterminated-quote': 'editor.curlErrorUnterminatedQuote',
  'bad-syntax': 'editor.curlErrorBadSyntax',
  'missing-url': 'editor.curlErrorMissingUrl',
  'multiple-url': 'editor.curlErrorMultipleUrl',
  'invalid-url': 'editor.curlErrorInvalidUrl',
  'unsupported-flag': 'editor.curlErrorUnsupportedFlag',
  'missing-value': 'editor.curlErrorMissingValue',
  'bad-method': 'editor.curlErrorBadMethod',
  'bad-header': 'editor.curlErrorBadHeader',
  'file-source': 'editor.curlErrorFileSource',
  'bad-form': 'editor.curlErrorBadForm',
  'bad-urlencoded': 'editor.curlErrorBadUrlencoded',
  'mixed-body': 'editor.curlErrorMixedBody',
}

export function CurlImportDialog({
  open,
  baseUrl,
  onClose,
}: {
  open: boolean
  /** 当前工作空间 BaseUrl（URL 拆分：命中拆相对模板，未命中存完整 URL） */
  baseUrl: string | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState<CurlImportError | null>(null)

  // 开合间重置表单（渲染期调整模式：open 变化即重置，条件随标记收敛；
  // 粘贴面与错误面不跨次残留）
  const [openMark, setOpenMark] = React.useState(open)
  if (openMark !== open) {
    setOpenMark(open)
    setText('')
    setError(null)
  }

  const submit = () => {
    const result = parseCurlCommand(text, baseUrl)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const draftId = useTabsStore.getState().openDraft(result.title)
    useDraftStore.getState().seedDraft(draftId, result.draft)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="curl-import-dialog">
        <DialogHeader>
          <DialogTitle>{t('editor.curlImportTitle')}</DialogTitle>
          <DialogDescription>{t('editor.curlImportDescription')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          className="grid gap-3"
        >
          <Textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              // 编辑即清错误：拒绝原因对应上一版文本，改后不再成立
              setError(null)
            }}
            placeholder={t('editor.curlImportPlaceholder')}
            spellCheck={false}
            // 基类随内容长高（field-sizing: content），封顶后转内部滚动：
            // 长 curl 粘贴不撑高对话框
            className="max-h-48 min-h-32 resize-none overflow-y-auto font-mono text-xs"
            data-testid="curl-import-input"
            aria-label={t('editor.curlImportTitle')}
          />
          {error && (
            <p className="text-micro text-destructive" data-testid="curl-import-error">
              {error.position >= 2 && `${t('editor.curlErrorAt', { position: error.position })}：`}
              {t(ERROR_REASON_KEYS[error.reason])}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('editor.curlImportCancel')}
            </Button>
            <Button type="submit" disabled={text.trim() === ''} data-testid="curl-import-submit">
              {t('editor.curlImportSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
