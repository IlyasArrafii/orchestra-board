// A small Markdown subset for briefs and worker reports: headings, paragraphs, lists, task boxes,
// quotes, rules, fenced code, `code` and **bold**. Pure, so it is tested in Node; the editor renders the
// blocks as React elements (text only), because reports are agent-written and never trusted as HTML.

export type Inline = { kind: 'text' | 'code' | 'strong'; text: string }
export type ListItem = { inline: Inline[]; checked: boolean | null }
export type Block =
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; inline: Inline[] }
  | { kind: 'rule' }

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) })
    out.push(match[1] !== undefined ? { kind: 'code', text: match[1] } : { kind: 'strong', text: match[2] })
    last = match.index + match[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      flush()
      const code: string[] = []
      for (index += 1; index < lines.length && !lines[index].trim().startsWith('```'); index += 1) code.push(lines[index])
      blocks.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    if (!trimmed) {
      flush()
      continue
    }
    if (trimmed.startsWith('<!--')) {
      flush()
      while (index < lines.length && !lines[index].includes('-->')) index += 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, inline: parseInline(heading[2]) })
      continue
    }
    if (/^(\*\*\*|---|___)\s*$/.test(trimmed)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }
    if (trimmed.startsWith('>')) {
      flush()
      blocks.push({ kind: 'quote', inline: parseInline(trimmed.replace(/^>\s?/, '')) })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      flush()
      const ordered = item[2] !== undefined
      const items: ListItem[] = []
      for (; index < lines.length; index += 1) {
        const current = LIST_ITEM.exec(lines[index])
        if (current && (current[2] !== undefined) === ordered) {
          const box = /^\[([ xX])\]\s+(.*)$/.exec(current[3])
          items.push(box ? { inline: parseInline(box[2]), checked: box[1] !== ' ' } : { inline: parseInline(current[3]), checked: null })
        } else if (lines[index].trim() && /^\s{2,}\S/.test(lines[index]) && items.length) {
          // A wrapped continuation line belongs to the item above.
          items[items.length - 1].inline.push({ kind: 'text', text: ` ${lines[index].trim()}` })
        } else {
          index -= 1
          break
        }
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    paragraph.push(trimmed)
  }
  flush()
  return blocks
}
