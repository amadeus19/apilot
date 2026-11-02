import * as React from 'react'

/**
 * 编辑器校验态接缝：失效引用节点集（解析派生态——不落库，随校验结果
 * 派生）经 Context 下发，节点卡片警示、节点内重接引导、错误定位共用
 * 单一来源（问题清单经底部控制台 props 链呈现）。
 */

/** 失效引用节点 id 集（requestInvalidRef 的定位面；空集＝无失效） */
export const InvalidRefContext = React.createContext<ReadonlySet<string>>(new Set())
