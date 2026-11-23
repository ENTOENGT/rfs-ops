import './globals.css';
import type { Metadata, Viewport } from 'next';
export const metadata: Metadata = {
  title: 'RFS CRM — Reliance Freight Systems',
  description: 'RFS CRM — freight forwarding and 3PL operations',
  appleWebApp: { capable: true, title: 'RFS CRM', statusBarStyle: 'black-translucent' },
};
export const viewport: Viewport = { themeColor: '#1f2226', width: 'device-width', initialScale: 1 };
export default function Root({ children }: { children: React.ReactNode }) {
  // the light / dark choice is put on before the page shows (no flash); light unless the person chose dark
  return <html lang="en" data-theme="light" suppressHydrationWarning><head>
    <script dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('rfs.theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}" }} />
  </head><body>{children}</body></html>;
}
