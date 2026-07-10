import { parse as jsoncParse, modify as jsoncModify, applyEdits as jsoncApplyEdits, type ModificationOptions } from 'jsonc-parser'
import type { ProviderConfig, ModelConfig } from '../types'

const fmt: ModificationOptions = { formattingOptions: { tabSize: 2, insertSpaces: true } }

export function parseProviders(text: string): ProviderConfig[] {
  const root = jsoncParse(text)
  if (!root?.provider) return []
  return Object.entries(root.provider).map(([id, p]: [string, any]) => ({
    id,
    name: p?.name ?? id,
    baseURL: p?.options?.baseURL ?? '',
    apiKey: p?.options?.apiKey ?? '',
    models: p?.models
      ? Object.entries(p.models).map(([mid, m]: [string, any]) => ({
          id: mid,
          name: m?.name ?? mid,
          contextLimit: m?.limit?.context ?? 0,
          outputLimit: m?.limit?.output ?? 0
        }))
      : []
  }))
}

export function addProvider(text: string, provider: ProviderConfig): string {
  const path = ['provider', provider.id]
  const value = {
    npm: '@ai-sdk/openai-compatible',
    name: provider.name,
    options: { baseURL: provider.baseURL, apiKey: provider.apiKey },
    models: {}
  }
  const edits = jsoncModify(text, path, value, fmt)
  return jsoncApplyEdits(text, edits)
}

export function updateProvider(text: string, provider: ProviderConfig): string {
  let result = text
  const basePath = ['provider', provider.id]
  const edits = jsoncModify(result, [...basePath, 'name'], provider.name, fmt)
  result = jsoncApplyEdits(result, edits)
  const edits2 = jsoncModify(result, [...basePath, 'options', 'baseURL'], provider.baseURL, fmt)
  result = jsoncApplyEdits(result, edits2)
  const edits3 = jsoncModify(result, [...basePath, 'options', 'apiKey'], provider.apiKey, fmt)
  result = jsoncApplyEdits(result, edits3)
  return result
}

export function deleteProvider(text: string, providerId: string): string {
  const edits = jsoncModify(text, ['provider', providerId], undefined, fmt)
  return jsoncApplyEdits(text, edits)
}

export function setModels(text: string, providerId: string, models: ModelConfig[]): string {
  const modelsObj: Record<string, any> = {}
  for (const m of models) {
    modelsObj[m.id] = {
      name: m.name,
      limit: { context: m.contextLimit, output: m.outputLimit }
    }
  }
  const edits = jsoncModify(text, ['provider', providerId, 'models'], modelsObj, fmt)
  return jsoncApplyEdits(text, edits)
}
