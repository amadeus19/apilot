import * as React from 'react'

import { useI18n } from '@/i18n'

import { isPdfBytes, type PreviewKind, type ResponseBytes } from './constants'

/**
 * 响应 Preview 渲染：html / 图片 / PDF 三条字节通道（可渲染类型判定在
 * constants 的 previewKindFromContentType，本组件只负责把字节渲染出来）。
 * 文本预览（previewKind 'text'）不经字节通道——宿主以重解码文本直出
 * pre，故本组件的 kind 契约排除 'text'。
 *
 * 渲染通道：
 * - 图片：Blob URL ＋ <img>；
 * - html：<iframe sandbox>——sandbox 属性留空＝最严格限制（禁脚本、
 *   禁表单、禁同源访问），渲染的是纯静态标记；
 * - PDF：Blob URL ＋ 无沙箱 <iframe>。Chromium 内置 PDF 查看器需要脚本
 *   与扩展权限才能运行，沙箱化 frame 一律被拒（WebView2 呈现「此页面已
 *   被 Microsoft Edge 阻止」拦截页），故本通道不设 sandbox；对冲护栏＝
 *   非 PDF 字节（Content-Type 谎报，典型＝HTML）经 isPdfBytes 魔数门槛
 *   回落提示，不得进入无沙箱 frame 借应用源执行。
 *
 * 资源四问（Blob URL）：
 * - 谁拥有：本组件（useBlobSrc 唯一持有点）；
 * - 何时创建：字节与 MIME 就绪后的 effect 中 createObjectURL；
 * - 何时释放：effect cleanup——字节替换（新响应到达）与组件卸载时 revoke，
 *   不留悬挂句柄；
 * - 渲染失败 / 中途切换：cleanup 恒执行，句柄不因渲染失败泄漏。
 */

/**
 * Blob URL 绑定到元素 src 的唯一持有点：句柄是命令式外部资源（创建 / 回收
 * 与渲染输出解耦），以 ref 绑定——字节替换即 revoke 旧句柄换新，卸载即回收。
 */
function useBlobSrc<T extends HTMLElement>(
  bytes: ResponseBytes,
  mime: string,
): React.RefObject<T | null> {
  const ref = React.useRef<T | null>(null)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    // Blob 一次性持有：url 建在 effect 内、由 cleanup 回收，组件侧不二次拷贝字节
    const url = bytes.byteLength > 0 ? URL.createObjectURL(new Blob([bytes], { type: mime })) : null
    if (url !== null) el.setAttribute('src', url)
    else el.removeAttribute('src')
    return () => {
      if (url !== null) URL.revokeObjectURL(url)
    }
  }, [bytes, mime])
  return ref
}

function BlobPreviewFrame({
  bytes,
  mime,
  kind,
  label,
}: {
  bytes: ResponseBytes
  mime: string
  kind: 'pdf' | 'html'
  label: string
}) {
  const frameRef = useBlobSrc<HTMLIFrameElement>(bytes, mime)
  return (
    <iframe
      ref={frameRef}
      // html：sandbox 留空＝最严格限制（禁脚本、禁表单、禁同源访问），渲染纯
      // 静态标记；pdf：不设沙箱——内置 PDF 查看器需要脚本与扩展权限，沙箱化
      // frame 会被 WebView2 以拦截页替代（文件头准入见 isPdfBytes 魔数门槛）
      sandbox={kind === 'html' ? '' : undefined}
      title={label}
      className="h-full w-full border-0 bg-background"
      data-testid={`response-preview-${kind}`}
    />
  )
}

function BlobPreviewImage({
  bytes,
  mime,
  label,
}: {
  bytes: ResponseBytes
  mime: string
  label: string
}) {
  const imgRef = useBlobSrc<HTMLImageElement>(bytes, mime)
  return (
    <div className="grid h-full place-items-center overflow-auto p-3">
      <img
        ref={imgRef}
        alt={label}
        className="max-h-full max-w-full object-contain"
        data-testid="response-preview-image"
      />
    </div>
  )
}

/**
 * Preview 内容区：按判定类型选择渲染通道。宿主保证字节到手（loaded）才
 * 挂载本组件，拉取中的进度与失败信息由宿主态承载。
 */
export function ResponsePreview({
  kind,
  bytes,
  contentType,
}: {
  kind: Exclude<PreviewKind, 'text'>
  bytes: ResponseBytes
  contentType: string | null
}) {
  const { t } = useI18n()
  const label = t('response.previewFrameLabel')
  // 图片 MIME 原样透传给 Blob（浏览器按真实类型解码）；html / pdf 用固定类型
  if (kind === 'image') {
    return <BlobPreviewImage bytes={bytes} mime={contentType ?? 'image/*'} label={label} />
  }
  // pdf 通道的无沙箱对冲：魔数门槛不过（谎报 Content-Type 的非 PDF 字节）
  // 不进 frame，与未知二进制回落同一提示形态
  if (kind === 'pdf' && !isPdfBytes(bytes)) {
    return (
      <p className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
        {t('response.previewUnavailable', {
          contentType: contentType ?? t('response.contentTypeNone'),
        })}
      </p>
    )
  }
  return (
    <BlobPreviewFrame
      bytes={bytes}
      mime={kind === 'pdf' ? 'application/pdf' : 'text/html'}
      kind={kind}
      label={label}
    />
  )
}
