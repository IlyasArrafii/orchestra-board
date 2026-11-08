import { assert, test } from 'orca/testing'
import { parseInline, parseMarkdown } from './markdown'

test('inline code and bold', () => {
  assert.deepEqual(parseInline('run `bun test` **now** please'), [
    { kind: 'text', text: 'run ' },
    { kind: 'code', text: 'bun test' },
    { kind: 'text', text: ' ' },
    { kind: 'strong', text: 'now' },
    { kind: 'text', text: ' please' }
  ])
})

test('a task brief: headings, comments, lists, task boxes and code', () => {
  const blocks = parseMarkdown(
    [
      '# Task: Login',
      '',
      '<!-- fill every section -->',
      '## Goal',
      'One sentence',
      'that wraps.',
      '',
      '- **Change:** `apps/api`',
      '- [ ] criterion one',
      '- [x] criterion two',
      '  continues here',
      '',
      '1. first',
      '2. second',
      '',
      '```sh',
      'bun run check',
      '```',
      '***'
    ].join('\n')
  )
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'heading', 'paragraph', 'list', 'list', 'code', 'rule'])
  const bullets = blocks[3]
  assert.ok(bullets.kind === 'list' && !bullets.ordered)
  if (bullets.kind === 'list') {
    assert.deepEqual(bullets.items.map((entry) => entry.checked), [null, false, true])
    assert.equal(bullets.items[2].inline.map((part) => part.text).join(''), 'criterion two continues here')
  }
  const paragraph = blocks[2]
  if (paragraph.kind === 'paragraph') assert.equal(paragraph.inline[0].text, 'One sentence that wraps.')
  const code = blocks[5]
  if (code.kind === 'code') assert.equal(code.text, 'bun run check')
})
