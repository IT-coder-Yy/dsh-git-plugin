import type { AnyRecord } from './view-model'

export type Dispose = () => void

const WORKBENCH_ID = 'dsh-easygit-plugin'
const WORKBENCH_KIND = 'easygit'

/** Use the session-scoped conversation service; Connection no longer owns domain APIs. */
export async function requestAgentAnalysis(sessions: AnyRecord, sessionId: string, text: string): Promise<void> {
  const scope = sessions.scope(sessionId)
  if (!scope?.conversation) throw new Error('当前会话不可用，无法请求 Agent 分析')
  await scope.conversation.send(text)
}

/** Register a native tab without taking over the host's layout or other tabs. */
export function registerWorkbench(ctx: AnyRecord, renderPanel: (props: {
  sessionId: string
  close: Dispose
  sendPrompt(text: string): Promise<void>
}) => unknown): (sessionId: string) => void {
  const slots = ctx.get('slots')
  const tabs = ctx.get('sidebarRightTabs')
  const sidebar = ctx.get('sidebarRight')
  const sessions = ctx.get('sessions')
  ctx.effect(() => tabs.register({
    id: WORKBENCH_ID,
    kind: WORKBENCH_KIND,
    title: () => 'Git 工作台',
    guide: [{ id: WORKBENCH_KIND, order: 30, title: () => 'Git 工作台', description: () => '查看仓库、提交记录和 Git 操作建议' }],
  }), 'easygit: tab type')
  slots.inject('sidebar.right.pane.tab', () => slots.register(
    { name: 'sidebar.right.pane.tab', key: WORKBENCH_ID },
    (props: AnyRecord) => {
      const { tab } = props.useTabInfo()
      if (!tab.visible) return null
      return renderPanel({
        sessionId: props.sessionId,
        close: () => tab.actions.close(),
        sendPrompt: (text) => requestAgentAnalysis(sessions, props.sessionId, text),
      })
    },
  ))
  return (sessionId) => {
    if (!sessionId) throw new Error('当前会话不可用，无法打开 Git 工作台')
    sidebar.openTabIn(sessionId, WORKBENCH_KIND)
  }
}
