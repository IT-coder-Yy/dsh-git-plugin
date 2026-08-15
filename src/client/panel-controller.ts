export type Dispose = () => void

export interface PanelSnapshot {
  detailsReady: boolean
  activeSessionId: string | null
  open: boolean
  error: string
}

export interface PanelController {
  attachDetails(): Dispose
  open(sessionId: unknown): boolean
  close(sessionId?: unknown): boolean
  toggle(sessionId: unknown): boolean
  isOpen(sessionId: unknown): boolean
  subscribe(listener: (state: PanelSnapshot) => void): Dispose
  snapshot(): PanelSnapshot
}

interface SlotsLike {
  register(definition: Record<string, unknown>, renderer: (props: Record<string, unknown>) => unknown): unknown
}

interface LayoutLike {
  openDetails(): void
  closeDetails(): void
}

export interface PanelControllerOptions {
  slots?: SlotsLike | null
  layout?: LayoutLike | null
  renderPanel: (props: { sessionId: string; close: Dispose }) => unknown
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function markWorkbenchOpen(open: boolean): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  if (open) document.documentElement.setAttribute('data-easygit-workbench-open', '')
  else document.documentElement.removeAttribute('data-easygit-workbench-open')
}

/**
 * Mount the workbench only while it is open. Harness's built-in DetailsPanel
 * uses priority 0, so the workbench temporarily overrides it at -10 and
 * immediately releases the registration when closed.
 */
export function createPanelController(options: PanelControllerOptions): PanelController {
  const slots = options.slots
  const layout = options.layout
  const renderPanel = options.renderPanel
  const listeners = new Set<(state: PanelSnapshot) => void>()
  let detailsReady = false
  let activeSessionId: string | null = null
  let disposePanel: Dispose | null = null
  let error = ''

  const snapshot = (): PanelSnapshot => ({
    detailsReady,
    activeSessionId,
    open: activeSessionId !== null && disposePanel !== null,
    error,
  })
  const notify = (): void => {
    const state = snapshot()
    for (const listener of listeners) listener(state)
  }
  const close = (sessionId?: unknown): boolean => {
    if (sessionId !== undefined && sessionId !== null && activeSessionId !== String(sessionId)) return false
    const dispose = disposePanel
    const wasOpen = activeSessionId !== null || typeof dispose === 'function'
    activeSessionId = null
    disposePanel = null
    markWorkbenchOpen(false)
    if (typeof dispose === 'function') {
      try { dispose() } catch (caught) { error = errorText(caught) }
    }
    if (wasOpen && layout && typeof layout.closeDetails === 'function') {
      try { layout.closeDetails() } catch (caught) { error = errorText(caught) }
    }
    notify()
    return wasOpen
  }
  const open = (sessionId: unknown): boolean => {
    const targetSessionId = String(sessionId || '')
    if (!targetSessionId) {
      error = '当前会话不可用，无法打开 Git 工作台'
      notify()
      return false
    }
    if (!detailsReady || !slots || typeof slots.register !== 'function') {
      error = '当前 Harness 尚未提供右侧详情栏，无法打开 Git 工作台'
      notify()
      return false
    }
    if (!layout || typeof layout.openDetails !== 'function' || typeof layout.closeDetails !== 'function') {
      error = '当前 Harness 不支持详情栏开关，无法打开 Git 工作台'
      notify()
      return false
    }
    if (activeSessionId === targetSessionId && typeof disposePanel === 'function') {
      try {
        layout.openDetails()
        error = ''
      } catch (caught) {
        error = errorText(caught)
      }
      notify()
      return error === ''
    }

    if (activeSessionId !== null || typeof disposePanel === 'function') close()
    let dispose: unknown = null
    try {
      layout.openDetails()
      dispose = slots.register(
        { name: 'details', priority: -10 },
        (props) => {
          const currentSessionId = String(props.sessionId || '')
          if (currentSessionId !== targetSessionId || activeSessionId !== targetSessionId) return null
          return renderPanel({ sessionId: currentSessionId, close: () => close(currentSessionId) })
        },
      )
      if (typeof dispose !== 'function') throw new Error('details 插槽未返回可释放的注册句柄')
      activeSessionId = targetSessionId
      disposePanel = dispose as Dispose
      markWorkbenchOpen(true)
      error = ''
      notify()
      return true
    } catch (caught) {
      if (typeof dispose === 'function') {
        try { dispose() } catch (disposeError) { /* Preserve the original error. */ }
      }
      activeSessionId = null
      disposePanel = null
      markWorkbenchOpen(false)
      try { layout.closeDetails() } catch (closeError) { /* Preserve the original error. */ }
      error = errorText(caught)
      notify()
      return false
    }
  }

  return {
    attachDetails() {
      detailsReady = true
      error = ''
      notify()
      return () => {
        detailsReady = false
        close()
      }
    },
    open,
    close,
    toggle(sessionId: unknown) {
      return activeSessionId === String(sessionId || '') ? close(sessionId) : open(sessionId)
    },
    isOpen(sessionId: unknown) {
      return activeSessionId === String(sessionId || '') && typeof disposePanel === 'function'
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot,
  }
}
