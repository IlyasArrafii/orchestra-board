import { useState, type ReactNode } from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export type ComboOption = { value: string; label: string; hint?: string; icon?: ReactNode }

/**
 * A searchable picker (shadcn Combobox). With `creatable`, typing a value that is not in the list
 * offers "Create …", as in the Role field.
 */
export function Combobox({
  value,
  options,
  onChange,
  placeholder,
  searchPlaceholder = 'Type to search…',
  emptyText = 'Nothing found.',
  creatable = false,
  disabled = false,
  className
}: {
  value: string
  options: ComboOption[]
  onChange: (value: string) => void
  placeholder: string
  searchPlaceholder?: string
  emptyText?: string
  creatable?: boolean
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = options.find((option) => option.value === value)
  const typed = query.trim()
  const canCreate = creatable && typed && !options.some((option) => option.label.toLowerCase() === typed.toLowerCase())

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
    setQuery('')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} disabled={disabled} className={cn('h-9 w-full justify-between px-3 font-normal', className)}>
          <span className={cn('flex min-w-0 items-center gap-2 truncate', !selected && !value && 'text-muted-foreground')}>
            {selected?.icon}
            <span className="truncate">{selected?.label ?? (value || placeholder)}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{creatable ? 'Type a name to create it.' : emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem key={option.value} value={`${option.label} ${option.hint ?? ''}`} onSelect={() => pick(option.value)}>
                  {option.icon}
                  <span className="truncate">{option.label}</span>
                  {option.hint && <span className="ml-auto truncate text-xs text-muted-foreground">{option.hint}</span>}
                  <Check className={cn('size-4 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0', !option.hint && 'ml-auto')} />
                </CommandItem>
              ))}
              {canCreate && (
                <CommandItem value={`create ${typed}`} onSelect={() => pick(typed)}>
                  <Plus className="size-4" />
                  Create “{typed}”
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
