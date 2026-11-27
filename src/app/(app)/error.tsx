'use client';
import { CrashScreen } from '@/components/CrashScreen';
// 27 Nov: a crash on one page keeps the menu and shows a clear message instead of "Application error"
export default function PageError(p: { error: Error & { digest?: string }; reset: () => void }) { return <CrashScreen {...p} />; }
