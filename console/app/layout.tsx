import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlatformProvider } from '@/components/platform-provider';
import { PlatformShell } from '@/components/platform-shell';
import { ControlProvider } from '@/components/control-provider';
import './globals.css';
export const metadata: Metadata = {
  title: { template: '%s · Stroq', default: 'Stroq · Security platform' },
  description:
    'Understand what your AI agents do. Investigate decisions, review exposure, and verify coverage — on your machine.',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: '#101113' };
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="preload"
          href="/fonts/Geist-latin.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <a href="#content" className="skip-link">
          Skip to content
        </a>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={250}>
            <PlatformProvider>
              <ControlProvider>
                <PlatformShell>{children}</PlatformShell>
              </ControlProvider>
            </PlatformProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
