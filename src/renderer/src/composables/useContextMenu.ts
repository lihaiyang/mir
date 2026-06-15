import { reactive } from 'vue'

export interface MenuItemDef {
  label?: string
  action?: () => void | Promise<void>
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

const menu = reactive({
  visible: false,
  x: 0,
  y: 0,
  items: [] as MenuItemDef[]
})

function show(e: MouseEvent, items: MenuItemDef[]) {
  e.preventDefault()
  e.stopPropagation()
  menu.visible = true
  menu.items = items
  // keep menu inside viewport
  const vw = window.innerWidth
  const vh = window.innerHeight
  const estimatedW = 200
  const estimatedH = items.length * 32
  menu.x = Math.min(e.clientX, vw - estimatedW)
  menu.y = Math.min(e.clientY, vh - estimatedH)
}

function close() {
  menu.visible = false
}

async function execute(item: MenuItemDef) {
  close()
  if (item.action) await item.action()
}

export function useContextMenu() {
  return { menu, show, close, execute }
}
