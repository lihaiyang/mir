import Store from 'electron-store'

// Lazy-instantiated so the userData path (set by main/index.ts for dev) is
// already correct when the Store is first created. A module-level `new Store`
// would read app.getPath('userData') at import time, before setPath runs.
let _store: Store | null = null

export function getStore(): Store {
  if (!_store) _store = new Store({ name: 'mir-state' })
  return _store
}
