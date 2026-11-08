import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { App } from './app'

/** Orca puts `light` or `dark` on <html> and changes it in place with the app theme. */
function useDarkClass(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

function Root() {
  const dark = useDarkClass()
  return (
    <TooltipProvider delayDuration={300}>
      <App />
      <Toaster
        theme={dark ? 'dark' : 'light'}
        position="bottom-right"
        toastOptions={{ classNames: { toast: '!bg-popover !text-popover-foreground !border-border text-[13px]', description: '!text-muted-foreground' } }}
      />
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
