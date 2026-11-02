import { Handle, Position } from '@xyflow/react'
import { PlusIcon } from 'lucide-react'

import { useI18n } from '@/i18n'

/** 占位节点的连线锚点：与节点卡片 Handle 同口径（占位节点不可交互，
 * 去掉悬停点亮；节点卡片未导出该常量，按同款类名收敛） */
const TEMP_HANDLE_CLASS = '!size-2 !border-2 !border-card !bg-node-line-strong'

/**
 * 连线临时体的占位节点：与真实节点卡同壳（w-64 圆角卡＋标题条，转正后
 * 卡片轮廓零跳变），标题条呈现中性「新节点」态；左右各一只同款锚点供临
 * 时边两端锚定。不读任何节点数据——nodeTypes 按类型键分发到这里，节点
 * 卡片组件不经手临时体。独立成文件以维持 Fast Refresh 组件文件纯净。
 */
export function TempPlaceholderNode() {
  const { t } = useI18n()
  return (
    <div
      className="w-64 rounded-lg border border-node-line bg-card shadow-node"
      data-testid="workflow-temp-node"
    >
      <div className="flex h-8 items-center gap-1.5 rounded-lg border-b border-node-line/70 px-2 text-foreground/60 select-none">
        <PlusIcon aria-hidden className="size-3.5" />
        <span className="text-xs">{t('workflows.tempNodeLabel')}</span>
      </div>
      <Handle type="target" position={Position.Left} className={TEMP_HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} className={TEMP_HANDLE_CLASS} />
    </div>
  )
}
