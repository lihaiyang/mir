import type { ProviderConfig, ModelConfig } from '../types'

export function parseProviders(modelsText: string, settingsText?: string): ProviderConfig[] {
  const root = JSON.parse(modelsText)
  if (!root?.providers) return []
  const settings = settingsText ? JSON.parse(settingsText) : {}
  return Object.entries(root.providers).map(([id, p]: [string, any]) => ({
    id,
    name: id,
    baseURL: p?.baseUrl ?? '',
    apiKey: p?.apiKey ?? '',
    models: Array.isArray(p?.models)
      ? p.models.map((m: any) => ({
          id: m.id ?? '',
          name: m.name ?? m.id ?? '',
          contextLimit: m.contextWindow ?? 0,
          outputLimit: 0
        }))
      : []
  }))
}

export function addProvider(modelsText: string, provider: ProviderConfig): string {
  const root = JSON.parse(modelsText)
  if (!root.providers) root.providers = {}
  root.providers[provider.id] = {
    baseUrl: provider.baseURL,
    api: 'openai-completions',
    apiKey: provider.apiKey,
    models: provider.models.map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextLimit
    }))
  }
  return JSON.stringify(root, null, 2)
}

export function updateProvider(modelsText: string, provider: ProviderConfig): string {
  const root = JSON.parse(modelsText)
  if (!root.providers?.[provider.id]) return modelsText
  root.providers[provider.id].baseUrl = provider.baseURL
  root.providers[provider.id].apiKey = provider.apiKey
  return JSON.stringify(root, null, 2)
}

export function deleteProvider(modelsText: string, providerId: string): string {
  const root = JSON.parse(modelsText)
  delete root.providers?.[providerId]
  return JSON.stringify(root, null, 2)
}

export function setModels(modelsText: string, providerId: string, models: ModelConfig[]): string {
  const root = JSON.parse(modelsText)
  if (!root.providers?.[providerId]) return modelsText
  root.providers[providerId].models = models.map(m => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextLimit
  }))
  return JSON.stringify(root, null, 2)
}
