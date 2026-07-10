import type { PluginApi } from './types'

let _api: PluginApi | null = null

export function setApi(api: PluginApi): void {
  _api = api
}

export function getApi(): PluginApi {
  if (!_api) throw new Error('[agent-manager] Plugin API not initialized')
  return _api
}
