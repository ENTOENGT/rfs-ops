/** Line icons for the navigation and header (24-unit grid, drawn with the current text colour). */
const P: Record<string, string[]> = {
  dashboard: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  briefcase: ['M3 7h18v13H3z', 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M3 13h18'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.5 5h13L22 12v7H2v-7z'],
  scale: ['M12 3v18', 'M7 21h10', 'M5 7h14', 'M5 7l-3 7a3 3 0 0 0 6 0z', 'M19 7l-3 7a3 3 0 0 0 6 0z'],
  quote: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6', 'M8 13h8', 'M8 17h5'],
  calendar: ['M3 5h18v16H3z', 'M16 3v4', 'M8 3v4', 'M3 10h18', 'm9 15 2 2 4-4'],
  mail: ['M3 5h18v14H3z', 'm3 6 9 7 9-7'],
  boxes: ['M3 9h18v12H3z', 'M7 9V5h10v4', 'M8 13v4', 'M12 13v4', 'M16 13v4'],
  anchor: ['M12 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M12 8v13', 'M5 12H3a9 9 0 0 0 18 0h-2', 'M8 11h8'],
  warehouse: ['M3 21V8l9-5 9 5v13', 'M7 21v-8h10v8', 'M7 17h10'],
  truck: ['M2 6h12v10H2z', 'M14 9h4l3 3v4h-7z', 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  folder: ['M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  chart: ['M3 3v18h18', 'M8 17v-5', 'M13 17V8', 'M18 17v-8'],
  shield: ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z', 'm9 12 2 2 4-4'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm21 21-5-5'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.9 1.9 0 0 0 3.4 0'],
  plus: ['M12 5v14', 'M5 12h14'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  chevronLeft: ['m15 18-6-6 6-6'], chevronRight: ['m9 18 6-6-6-6'], chevronDown: ['m6 9 6 6 6-6'],
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  panel: ['M3 4h18v16H3z', 'M9 4v16'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  key: ['M15 7a4 4 0 1 1-3.9 5H9v2H7v2H4v-3l6.1-6.1A4 4 0 0 1 15 7z'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  dots: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
  arrowRight: ['M5 12h14', 'm12 5 7 7-7 7'],
  filter: ['M3 5h18l-7 8v6l-4 2v-8z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  ship: ['M3 17l2 4h14l2-4', 'M5 17V9h14v8', 'M12 9V3', 'M9 5h6'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
};
export function Icon({ name, size = 18, className, title }: { name: string; size?: number; className?: string; title?: string }) {
  const d = P[name] ?? P.dots;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}{d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}
