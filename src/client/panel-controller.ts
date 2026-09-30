import type { AnyRecord } from './view-model'
import { EmbeddedChat, SideChat } from './side-chat'
const React = require('react')

export type Dispose = () => void

const WORKBENCH_ID = 'dsh-easygit-plugin'
const WORKBENCH_KIND = 'easygit'

/** Register a native tab without taking over the host's layout or other tabs. */
export function registerWorkbench(ctx: AnyRecord, renderPanel: (props: {
  sessionId: string
  close: Dispose
  renderChat(expanded: boolean): unknown
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
    { name: 'sidebar.right.pane.tab', key: WORKBENCH_ID, children: { 'easygit.chat': { kind: 'single', scope: 'session' } } },
    (props: AnyRecord) => {
      const { tab } = props.useTabInfo()
      if (!tab.visible) return null
      return renderPanel({
        sessionId: props.sessionId,
        close: () => tab.actions.close(),
        renderChat: (expanded) => React.createElement(SideChat, {
          collapsed: !expanded,
          key: props.sessionId, sessionId: props.sessionId, sessions,
          SessionProvider: props.SessionProvider, renderSlot: props.renderSlot,
        }),
      })
    },
  ))
  slots.inject('easygit.chat', () => slots.register({ name: 'easygit.chat' }, EmbeddedChat))
  return (sessionId) => {
    if (!sessionId) throw new Error('当前会话不可用，无法打开 Git 工作台')
    sidebar.openTabIn(sessionId, WORKBENCH_KIND)
  }
}
