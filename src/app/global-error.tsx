'use client';
import './globals.css';
import { CrashScreen } from '@/components/CrashScreen';
// 27 Nov: the last safety net (a crash in the menu or the layout itself)
export default function GlobalError(p: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en" data-theme="light"><body><CrashScreen {...p} /></body></html>;
}
