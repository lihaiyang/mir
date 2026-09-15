import * as monaco from 'monaco-editor'

// Reference-counted access to Monaco text models keyed by file path.
//
// Monaco keeps every `createModel()` result alive until `dispose()` is called
// explicitly — it does NOT evict models on its own. Previously FileTab
// deliberately never disposed its models ("Monaco manages model cache
// internally" — it doesn't), so every distinct file ever opened kept its full
// text model, undo stack and language-service state alive for the whole app
// session.
//
// Both FileTab and EditorTab acquire through this module. When the last viewer
// of a file releases it, the model is disposed. Split panes viewing the same
// file keep refcount > 0 and share one model, as before.

const refCounts = new Map<string, number>()
// Only models created by this module are disposed by it. A model that exists
// at the same URI but was created elsewhere (e.g. adopted) is never disposed
// here — same guarantee the old code gave for adopted models.
const createdHere = new Set<string>()

export function acquireModel(
  path: string,
  content: string,
  language: string
): monaco.editor.ITextModel {
  const uri = monaco.Uri.file(path)
  const key = uri.toString()
  let model = monaco.editor.getModel(uri)
  if (!model) {
    model = monaco.editor.createModel(content, language, uri)
    createdHere.add(key)
  }
  refCounts.set(key, (refCounts.get(key) ?? 0) + 1)
  return model
}

export function releaseModel(path: string): void {
  const uri = monaco.Uri.file(path)
  const key = uri.toString()
  const n = refCounts.get(key)
  if (!n) return
  if (n > 1) {
    refCounts.set(key, n - 1)
    return
  }
  refCounts.delete(key)
  if (!createdHere.has(key)) return
  const model = monaco.editor.getModel(uri)
  // Never dispose a model still attached to a live editor (Monaco throws).
  // Callers dispose/detach their editor first, so this is a safety net.
  if (model && !model.isAttachedToEditor()) {
    try {
      model.dispose()
    } catch { /* already disposed */ }
    createdHere.delete(key)
  }
}
