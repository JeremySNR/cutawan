/**
 * A strict little XML parser for tests: enough of XML 1.0 to check that the
 * NLE exports are well formed (balanced tags, quoted attributes, known
 * entities, one root) and to walk them. Throws on anything malformed.
 */
export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|\w+);|&/gi, (_match, name: string | undefined) => {
    if (!name) throw new Error('Bare & in XML text')
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)))
    if (!(name in ENTITIES)) throw new Error(`Unknown entity &${name};`)
    return ENTITIES[name]
  })
}

export function parseXml(source: string): { doctype: string | null; root: XmlElement } {
  let i = 0
  let doctype: string | null = null
  const skipSpace = (): void => {
    while (i < source.length && /\s/.test(source[i])) i++
  }
  skipSpace()
  if (source.startsWith('<?xml', i)) {
    const end = source.indexOf('?>', i)
    if (end < 0) throw new Error('Unterminated XML declaration')
    i = end + 2
  }
  skipSpace()
  if (source.startsWith('<!DOCTYPE', i)) {
    const end = source.indexOf('>', i)
    doctype = source.slice(i + 9, end).trim()
    i = end + 1
  }
  skipSpace()

  const parseElement = (): XmlElement => {
    if (source[i] !== '<') throw new Error(`Expected < at ${i}`)
    i++
    const nameMatch = /^[A-Za-z_][\w.-]*/.exec(source.slice(i))
    if (!nameMatch) throw new Error(`Bad tag name at ${i}`)
    const name = nameMatch[0]
    i += name.length
    const attrs: Record<string, string> = {}
    for (;;) {
      skipSpace()
      if (source.startsWith('/>', i)) {
        i += 2
        return { name, attrs, children: [], text: '' }
      }
      if (source[i] === '>') {
        i++
        break
      }
      const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*"([^"<]*)"/.exec(source.slice(i))
      if (!attr) throw new Error(`Bad attribute in <${name}> at ${i}`)
      if (attr[1] in attrs) throw new Error(`Duplicate attribute ${attr[1]} in <${name}>`)
      attrs[attr[1]] = decode(attr[2])
      i += attr[0].length
    }
    const children: XmlElement[] = []
    let text = ''
    for (;;) {
      if (i >= source.length) throw new Error(`Unclosed <${name}>`)
      if (source.startsWith('</', i)) {
        const end = source.indexOf('>', i)
        const closing = source.slice(i + 2, end).trim()
        if (closing !== name) throw new Error(`Mismatched </${closing}> for <${name}>`)
        i = end + 1
        return { name, attrs, children, text: decode(text).trim() }
      }
      if (source[i] === '<') children.push(parseElement())
      else {
        const next = source.indexOf('<', i)
        text += source.slice(i, next < 0 ? source.length : next)
        i = next < 0 ? source.length : next
      }
    }
  }

  const root = parseElement()
  skipSpace()
  if (i !== source.length) throw new Error('Content after the root element')
  return { doctype, root }
}

/** Every descendant element with this name, in document order. */
export function findAll(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = []
  for (const child of el.children) {
    if (child.name === name) out.push(child)
    out.push(...findAll(child, name))
  }
  return out
}

/** The first direct child with this name; throws when there is none. */
export function child(el: XmlElement, name: string): XmlElement {
  const found = el.children.find((c) => c.name === name)
  if (!found) throw new Error(`<${el.name}> has no <${name}>`)
  return found
}

export const childText = (el: XmlElement, name: string): string => child(el, name).text
