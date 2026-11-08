import { parseMarkdown, type Inline } from '@shared/markdown'
import { cn } from '@/lib/utils'

// Briefs and worker reports are agent-written: every part is rendered as text, never as HTML.
function InlineText({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'code' ? (
          <code key={index} className="rounded bg-muted px-1 py-px font-mono text-[12px]">
            {part.text}
          </code>
        ) : part.kind === 'strong' ? (
          <strong key={index} className="font-semibold">
            {part.text}
          </strong>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  )
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source)
  return (
    <div className={cn('space-y-2.5 text-[13px] leading-relaxed [overflow-wrap:anywhere]', className)}>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <h4 key={index} className={cn('font-semibold text-foreground', block.level <= 2 ? 'pt-2 text-sm' : 'pt-1 text-[13px]')}>
              <InlineText parts={block.inline} />
            </h4>
          )
        }
        if (block.kind === 'paragraph') {
          return (
            <p key={index}>
              <InlineText parts={block.inline} />
            </p>
          )
        }
        if (block.kind === 'quote') {
          return (
            <blockquote key={index} className="border-l-2 pl-3 text-muted-foreground">
              <InlineText parts={block.inline} />
            </blockquote>
          )
        }
        if (block.kind === 'code') {
          return (
            <pre key={index} className="overflow-auto rounded-md border bg-card p-3 font-mono text-[12px]">
              <code>{block.text}</code>
            </pre>
          )
        }
        if (block.kind === 'rule') return <hr key={index} className="border-border" />
        const List = block.ordered ? 'ol' : 'ul'
        return (
          <List key={index} className={cn('space-y-1 pl-5', block.ordered ? 'list-decimal' : 'list-disc')}>
            {block.items.map((item, itemIndex) =>
              item.checked === null ? (
                <li key={itemIndex}>
                  <InlineText parts={item.inline} />
                </li>
              ) : (
                <li key={itemIndex} className="-ml-5 flex list-none items-baseline gap-2">
                  <span
                    className={cn('relative top-0.5 size-3 shrink-0 rounded-[3px] border', item.checked ? 'border-status-done bg-status-done' : 'border-muted-foreground')}
                    aria-label={item.checked ? 'done' : 'not done'}
                  />
                  <span>
                    <InlineText parts={item.inline} />
                  </span>
                </li>
              )
            )}
          </List>
        )
      })}
    </div>
  )
}
