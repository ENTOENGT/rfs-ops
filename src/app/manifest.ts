import type { MetadataRoute } from 'next';
// Lets drivers and messengers "Add to Home Screen", and office staff install RFS CRM on Windows / Mac (Chrome, Edge): it then opens in its own window.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RFS CRM — Reliance Freight',
    short_name: 'RFS CRM',
    description: 'Reliance Freight Systems — enquiries, quotations, bookings and shipments',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',   // phones; desktop windows ignore it
    background_color: '#1f2226',
    theme_color: '#1f2226',
    icons: [
      { src: '/app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/app-icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
