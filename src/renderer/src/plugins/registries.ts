import { reactive, markRaw, type Component } from 'vue'

export interface TabTypeRegistration {
  type: string
  component: Component | null
  icon?: string
  defaultTitle?: string | (() => string)
  showInToolbar?: boolean
}

export interface RightPanelRegistration {
  id: string
  label: string | (() => string)
  icon: string
  component: Component
}

const _tabTypes = reactive(new Map<string, TabTypeRegistration>())
const _rightPanels = reactive(new Map<string, RightPanelRegistration>())

export function registerTabType(reg: TabTypeRegistration): void {
  _tabTypes.set(reg.type, { ...reg, component: reg.component ? markRaw(reg.component) : null })
}

export function unregisterTabType(type: string): void {
  _tabTypes.delete(type)
}

export function getTabType(type: string): TabTypeRegistration | undefined {
  return _tabTypes.get(type)
}

export function getAllTabTypes(): TabTypeRegistration[] {
  return Array.from(_tabTypes.values())
}

export function resolveTabTitle(type: string): string {
  const reg = _tabTypes.get(type)
  if (!reg?.defaultTitle) return 'Tab'
  return typeof reg.defaultTitle === 'function' ? reg.defaultTitle() : reg.defaultTitle
}

export function resolveTabIcon(type: string): string {
  return _tabTypes.get(type)?.icon ?? ''
}

export function registerRightPanel(reg: RightPanelRegistration): void {
  _rightPanels.set(reg.id, { ...reg, component: markRaw(reg.component) })
}

export function unregisterRightPanel(id: string): void {
  _rightPanels.delete(id)
}

export function getRightPanel(id: string): RightPanelRegistration | undefined {
  return _rightPanels.get(id)
}

export function getAllRightPanels(): RightPanelRegistration[] {
  return Array.from(_rightPanels.values())
}
