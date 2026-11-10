#!/usr/bin/env node
/**
 * 校验 i18n 文案，拦住只在运行时才炸的问题。
 *
 * vue-i18n 的消息是运行时编译的：字符串里裸写的 `@` 会被当成「链接消息」
 * （linked message）语法，编译时直接抛 `SyntaxError: Invalid linked format`。
 * 这个异常发生在模板渲染期间，结果是整个分区白屏、导航还在 —— 极难排查。
 * 所以任何字面量 `@`（比如 `@match`、邮件地址）都必须写成 `{'@'}`。
 *
 * 顺带检查各语言文件的 key 是否齐全，缺 key 时用户会看到 t() 的原始 key。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

const DIR = join(import.meta.dirname, '..', 'src/renderer/src/i18n/locales')
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()

const problems = []

function walk(node, prefix, locale, out) {
  if (typeof node === 'string') {
    out.set(prefix, node)
    // 去掉合法的字面量转义 {'...'}，剩下的 @ 都是语法地雷
    const stripped = node.replace(/\{'(?:[^']|'')*'\}/g, '')
    const bad = stripped.indexOf('@')
    if (bad !== -1) {
      problems.push(
        `${locale}: "${prefix}" 含未转义的 @（应写成 {'@'}）：...${node.slice(Math.max(0, bad - 20), bad + 20)}...`
      )
    }
    return
  }
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k, locale, out)
  }
}

const maps = new Map()
for (const file of files) {
  const locale = basename(file, '.json')
  const out = new Map()
  let data
  try {
    data = JSON.parse(readFileSync(join(DIR, file), 'utf8'))
  } catch (err) {
    problems.push(`${locale}: JSON 解析失败 — ${err.message}`)
    continue
  }
  walk(data, '', locale, out)
  maps.set(locale, out)
}

// key 齐平检查（以中文为基准）
const base = maps.get('zh-CN')
if (base) {
  for (const [locale, out] of maps) {
    if (locale === 'zh-CN') continue
    for (const key of base.keys()) if (!out.has(key)) problems.push(`${locale}: 缺少 key "${key}"`)
    for (const key of out.keys()) if (!base.has(key)) problems.push(`${locale}: 多出 key "${key}"（zh-CN 没有）`)
  }
}

if (problems.length > 0) {
  console.error('i18n 校验失败：')
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(1)
}

const total = [...(maps.get('zh-CN')?.keys() ?? [])].length
console.log(`i18n 校验通过：${maps.size} 个语言文件，${total} 个 key，@ 转义与 key 齐平均正常`)
