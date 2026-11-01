import { requireActor } from '@/server/auth';
import * as wh from '@/server/warehouse';
import { bad } from '@/server/db';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
// GET ?view=config | skus | ledger | stock (default). POST { action: warehouse | locations | sku | move | adjust }
export const GET = route(async (req) => {
  const a = await requireActor(req);
  const p = params(req);
  if (p.view === 'config') return wh.warehouseConfig(a);
  if (p.view === 'skus') return wh.listSkus(a, p);
  if (p.view === 'ledger') return wh.stockLedger(a, p);
  return wh.stockList(a, p);
});
const ACTIONS: Record<string, (a: any, b: any) => Promise<unknown>> = {
  warehouse: wh.saveWarehouse, locations: wh.saveLocations, sku: wh.saveSku, move: wh.moveStock, adjust: wh.adjustStock,
};
export const POST = route(async (req) => {
  const a = await requireActor(req);
  const b = await body(req);
  const fn = ACTIONS[String(b.action ?? '')];
  if (!fn) throw bad('Unknown action');
  return fn(a, b);
});
