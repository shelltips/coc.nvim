import { Location, Range, TextDocument } from 'vscode-languageserver-protocol'
import { parse, ParseError } from 'jsonc-parser'
import { IConfigurationModel, ErrorItem } from '../types'
import { emptyObject, objectLiteral } from '../util/is'
import { equals } from '../util/object'
import fs from 'fs'
import Uri from 'vscode-uri'
import path from 'path'
const logger = require('../util/logger')('configuration-util')
declare var __webpack_require__: any
const isWebpack = typeof __webpack_require__ === "function"
const pluginRoot = isWebpack ? path.dirname(__dirname) : path.resolve(__dirname, '../..')

export type ShowError = (errors: ErrorItem[]) => void

export function parseContentFromFile(filepath: string | null, onError?: ShowError): IConfigurationModel {
  if (!filepath || !fs.existsSync(filepath)) return { contents: {} }
  let content: string
  let uri = Uri.file(filepath).toString()
  try {
    content = fs.readFileSync(filepath, 'utf8')
  } catch (_e) {
    content = ''
  }
  let [errors, contents] = parseConfiguration(content)
  if (errors && errors.length) {
    onError(convertErrors(uri, content, errors))
  }
  return { contents }
}

export function parseConfiguration(content: string): [ParseError[], any] {
  if (content.length == 0) return [[], {}]
  let errors: ParseError[] = []
  let data = parse(content, errors, { allowTrailingComma: true })
  function addProperty(current: object, key: string, remains: string[], value: any): void {
    if (remains.length == 0) {
      current[key] = convert(value)
    } else {
      if (!current[key]) current[key] = {}
      let o = current[key]
      let first = remains.shift()
      addProperty(o, first, remains, value)
    }
  }

  function convert(obj: any, split = false): any {
    if (!objectLiteral(obj)) return obj
    if (emptyObject(obj)) return {}
    let dest = {}
    for (let key of Object.keys(obj)) {
      if (split && key.indexOf('.') !== -1) {
        let parts = key.split('.')
        let first = parts.shift()
        addProperty(dest, first, parts, obj[key])
      } else {
        dest[key] = convert(obj[key])
      }
    }
    return dest
  }
  return [errors, convert(data, true)]
}

export function convertErrors(uri: string, content: string, errors: ParseError[]): ErrorItem[] {
  let items: ErrorItem[] = []
  let document = TextDocument.create(uri, 'json', 0, content)
  for (let err of errors) {
    let msg = 'parse error'
    switch (err.error) {
      case 2:
        msg = 'invalid number'
        break
      case 8:
        msg = 'close brace expected'
        break
      case 5:
        msg = 'colon expeted'
        break
      case 6:
        msg = 'comma expected'
        break
      case 9:
        msg = 'end of file expected'
        break
      case 16:
        msg = 'invaliad character'
        break
      case 10:
        msg = 'invalid commment token'
        break
      case 15:
        msg = 'invalid escape character'
        break
      case 1:
        msg = 'invalid symbol'
        break
      case 14:
        msg = 'invalid unicode'
        break
      case 3:
        msg = 'property name expected'
        break
      case 13:
        msg = 'unexpected end of number'
        break
      case 12:
        msg = 'unexpected end of string'
        break
      case 11:
        msg = 'unexpected end of comment'
        break
      case 4:
        msg = 'value expected'
        break
      default:
        msg = 'Unknwn error'
        break
    }
    let range: Range = {
      start: document.positionAt(err.offset),
      end: document.positionAt(err.offset + err.length),
    }
    let loc = Location.create(uri, range)
    items.push({ location: loc, message: msg })
  }
  return items
}

export function addToValueTree(
  settingsTreeRoot: any,
  key: string,
  value: any,
  conflictReporter: (message: string) => void
): void {
  const segments = key.split('.')
  const last = segments.pop()

  let curr = settingsTreeRoot
  for (let i = 0; i < segments.length; i++) {
    let s = segments[i]
    let obj = curr[s]
    switch (typeof obj) {
      case 'undefined': {
        obj = curr[s] = {}
        break
      }
      case 'object':
        break
      default:
        conflictReporter(
          `Ignoring ${key} as ${segments
            .slice(0, i + 1)
            .join('.')} is ${JSON.stringify(obj)}`
        )
        return
    }
    curr = obj
  }

  if (typeof curr === 'object') {
    curr[last] = value // workaround https://github.com/Microsoft/vscode/issues/13606
  } else {
    conflictReporter(
      `Ignoring ${key} as ${segments.join('.')} is ${JSON.stringify(curr)}`
    )
  }
}

export function removeFromValueTree(valueTree: any, key: string): void {
  const segments = key.split('.')
  doRemoveFromValueTree(valueTree, segments)
}

function doRemoveFromValueTree(valueTree: any, segments: string[]): void {
  const first = segments.shift()
  if (segments.length === 0) {
    // Reached last segment
    delete valueTree[first]
    return
  }

  if (Object.keys(valueTree).indexOf(first) !== -1) {
    const value = valueTree[first]
    if (typeof value === 'object' && !Array.isArray(value)) {
      doRemoveFromValueTree(value, segments)
      if (Object.keys(value).length === 0) {
        delete valueTree[first]
      }
    }
  }
}

export function getConfigurationValue<T>(
  config: any,
  settingPath: string,
  defaultValue?: T
): T {
  function accessSetting(config: any, path: string[]): any {
    let current = config
    for (let i = 0; i < path.length; i++) { // tslint:disable-line
      if (typeof current !== 'object' || current === null) {
        return undefined
      }
      current = current[path[i]]
    }
    return current as T
  }

  const path = settingPath.split('.')
  const result = accessSetting(config, path)

  return typeof result === 'undefined' ? defaultValue : result
}

export function loadDefaultConfigurations(): IConfigurationModel {
  let file = path.join(pluginRoot, 'data/schema.json')
  if (!fs.existsSync(file)) {
    console.error('schema.json not found, reinstall coc.nvim to fix this!') // tslint:disable-line
    return { contents: {} }
  }
  let content = fs.readFileSync(file, 'utf8')
  let { properties } = JSON.parse(content)
  let config = {}
  Object.keys(properties).forEach(key => {
    let value = properties[key].default
    if (value !== undefined) {
      addToValueTree(config, key, value, message => {
        console.error(message) // tslint:disable-line
      })
    }
  })
  return { contents: config }
}

export function getKeys(obj: { [key: string]: any }, curr?: string): string[] {
  let keys: string[] = []
  for (let key of Object.keys(obj)) {
    let val = obj[key]
    let newKey = curr ? `${curr}.${key}` : key
    keys.push(newKey)
    if (objectLiteral(val)) {
      keys.push(...getKeys(val, newKey))
    }
  }
  return keys
}

export function getChangedKeys(from: { [key: string]: any }, to: { [key: string]: any }): string[] {
  let keys: string[] = []
  let fromKeys = getKeys(from)
  let toKeys = getKeys(to)
  const added = toKeys.filter(key => fromKeys.indexOf(key) === -1)
  const removed = fromKeys.filter(key => toKeys.indexOf(key) === -1)
  keys.push(...added)
  keys.push(...removed)
  for (const key of fromKeys) {
    if (toKeys.indexOf(key) == -1) continue
    const value1 = getConfigurationValue<any>(from, key)
    const value2 = getConfigurationValue<any>(to, key)
    if (!equals(value1, value2)) {
      keys.push(key)
    }
  }
  return keys
}
