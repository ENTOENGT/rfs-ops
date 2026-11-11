/**
 * Cargo lines on an enquiry (migration 023): each line is a number of packages of one type and one size.
 * Totals (packages, weight, CBM, chargeable weight) are worked out here, the same way on the screen and on the server.
 */
export const PACKAGE_TYPES = ['Cartons', 'Pallets', 'Crates', 'Wooden boxes', 'Drums', 'Bags', 'Bales', 'Rolls', 'Bundles', 'Pieces', 'Loose', 'Other'];
export const DIM_UNITS: [string, string, number][] = [['cm', 'cm', 0.01], ['in', 'inch', 0.0254], ['m', 'm', 1]];
/** Air: 1 CBM = 167 kg (the usual 6000 divisor). Road: 1 CBM = 333 kg. Courier: 1 CBM = 200 kg (5000 divisor). */
export const VOLUMETRIC_KG_PER_CBM: Record<string, number> = { air: 167, road: 333, courier: 200 };   // courier: the 5000 divisor
/** Full-container enquiries are priced per container and "Others" may not be cargo at all, so their dimensions are optional. */
export const dimsRequired = (mode: string | null | undefined) => !!mode && !['sea_fcl', 'other'].includes(mode);

export type CargoLine = { package_type: string; package_other?: string | null; pieces: number | string; length: number | string; width: number | string;
  height: number | string; dim_unit: string; weight_kg: number | string };

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** CBM of one line: pieces × L × W × H, converted to metres. */
export function lineCbm(l: Partial<CargoLine>) {
  const f = DIM_UNITS.find((u) => u[0] === l.dim_unit)?.[2] ?? 0.01;
  return round(n(l.pieces) * n(l.length) * f * n(l.width) * f * n(l.height) * f, 3);
}

/** Totals for the whole shipment. `chargeable_kg` for air and road; `wm` (weight or measure, in revenue tons) for sea LCL. */
export function cargoTotals(lines: Partial<CargoLine>[], mode?: string | null) {
  const packages = lines.reduce((s, l) => s + n(l.pieces), 0);
  const weight = round(lines.reduce((s, l) => s + n(l.weight_kg), 0), 2);
  const cbm = round(lines.reduce((s, l) => s + lineCbm(l), 0), 3);
  const per = VOLUMETRIC_KG_PER_CBM[mode ?? ''];
  const types = [...new Set(lines.map((l) => (l.package_type === 'Other' ? l.package_other || 'Other' : l.package_type) ?? '').filter(Boolean))];
  return {
    packages, weight, cbm,
    package_type: types.length === 1 ? types[0] : types.length > 1 ? 'Mixed' : null,
    volumetric_kg: per ? round(cbm * per, 2) : null,
    chargeable_kg: per ? round(Math.max(weight, cbm * per), 2) : null,
    wm: mode === 'sea_lcl' ? round(Math.max(cbm, weight / 1000), 3) : null,
  };
}

/** What is wrong with one line, or null. */
export function lineProblem(l: Partial<CargoLine>): string | null {
  if (!PACKAGE_TYPES.includes(String(l.package_type ?? ''))) return 'Choose the package type';
  if (l.package_type === 'Other' && !String(l.package_other ?? '').trim()) return 'Type the package type';
  if (!Number.isInteger(Number(l.pieces)) || Number(l.pieces) < 1) return 'Number of packages must be a whole number of 1 or more';
  for (const k of ['length', 'width', 'height'] as const) if (!(Number(l[k]) > 0)) return 'Length, width and height must be more than 0';
  if (!DIM_UNITS.some((u) => u[0] === l.dim_unit)) return 'Choose cm, inch or m';
  if (!(Number(l.weight_kg) > 0)) return 'Weight must be more than 0';
  return null;
}

export const blankLine = (copy?: Partial<CargoLine>): CargoLine => ({ package_type: copy?.package_type ?? 'Cartons', package_other: copy?.package_other ?? '', pieces: '', length: '', width: '', height: '', dim_unit: copy?.dim_unit ?? 'cm', weight_kg: '' });
/** Lines with nothing typed in are dropped before saving (so an untouched blank line is not an error). */
export const typedLines = (lines: Partial<CargoLine>[] | undefined) =>
  (lines ?? []).filter((l) => ['pieces', 'length', 'width', 'height', 'weight_kg'].some((k) => String((l as any)[k] ?? '').trim() !== ''));
