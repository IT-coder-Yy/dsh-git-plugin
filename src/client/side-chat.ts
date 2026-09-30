import type { AnyRecord } from './view-model'
const React = require('react')
export const sideChatSessions = new Set<string>()

export async function openSideChat(sessionId: string): Promise<string> {
  const response = await fetch('/easygit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'side-chat', sessionId }),
  }).then(response => response.json())
  if (!response.ok) throw new Error(response.error || '无法打开 Git 助手')
  sideChatSessions.add(response.sessionId)
  return response.sessionId
}

/** Same native Conversation factory used by DSH's sidebar subagent chat. */
export function EmbeddedChat(props: AnyRecord): unknown {
  const session = props.useSession((value: AnyRecord) => value)
  const phase = session.openState === 'loading' ? 'settling' : 'active'
  return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: false }, {
    slots: { views: (view: AnyRecord) => view.renderSlot('conversation.session', { view: 'chat' }) },
  })
}

export function SideChat({ sessionId, sessions, SessionProvider, renderSlot }: AnyRecord): unknown {
  const [reference, setReference] = React.useState(null)
  const [error, setError] = React.useState('')
  const [retry, setRetry] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    let retained: AnyRecord | undefined
    setError('')
    setReference(null)
    openSideChat(sessionId).then(async id => {
      if (cancelled) return
      retained = sessions.retain(id, { source: 'easygit' })
      await retained!.ready
      if (!cancelled) setReference(retained)
    }).catch(reason => { if (!cancelled) setError(String(reason.message || reason)) })
    return () => { cancelled = true; retained?.release() }
  }, [sessionId, sessions, retry])
  React.useEffect(() => {
    if (!reference) return
    let active = true
    const timer = setInterval(() => {
      openSideChat(sessionId).then(() => { if (active) setError('') })
        .catch(reason => { if (active) setError('上下文同步失败：' + String(reason.message || reason)) })
    }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [sessionId, reference])
  return React.createElement('section', { className: 'gg-side-chat', 'aria-label': 'Git 侧边聊天' },
    React.createElement('div', { className: 'gg-chat-head' }, 'Git 助手 · 主会话上下文自动同步'),
    error ? React.createElement('div', { role: 'alert', className: 'gg-workbench-error' }, error,
      React.createElement('button', { className: 'gg-btn', onClick: () => setRetry(retry + 1) }, '重试')) : null,
    reference ? React.createElement(SessionProvider, { session: reference }, renderSlot('easygit.chat', {}))
      : !error ? React.createElement('div', { className: 'gg-idletext' }, '正在恢复 Git 助手…') : null,
  )
}
