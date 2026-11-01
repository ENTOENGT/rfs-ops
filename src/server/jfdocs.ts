/**
 * Job File documents (migration 016): one store per Job File, versions, approve / reject, issue and expiry dates,
 * and "not needed for this file" waivers for required documents. Files sit in the same private storage as PODs,
 * uploaded straight from the browser with a one-time signed link, opened through a permission-checked 2-minute link.
 * Nothing is deleted silently: removal is a soft delete written to the Job File history.
 */
import { randomUUID } from 'crypto';
import { Actor } from './auth';
import { ApiError, bad, forbidden, notFound, one, q, tx } from './db';
import { fileStore } from './storage';
import { sign, unsign, MAX_BYTES } from './documents';
import { canEdit, event, getJobFile, loadFile } from './jobfiles';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};
/** Document types besides the required ones that people often attach. */
export const EXTRA_DOC_TYPES: [string, string][] = [['insurance', 'Insurance certificate'], ['permit', 'Permit / licence'], ['photo', 'Cargo photo'],
  ['correspondence', 'Customer / agent correspondence'], ['other', 'Other']];
const approver = (a: Actor) => a.isSuperAdmin || a.has('documents.approve');
const day = (v: unknown, label: string) => {
  if (v === undefined || v === null || v === '') return null;
  if (!DATE.test(String(v))) throw bad(`${label} is not a valid date`);
  return String(v);
};
async function typeName(docType: string) {
  const r = await one('select name from doc_requirements where doc_type = $1 limit 1', [docType]);
  return r?.name ?? EXTRA_DOC_TYPES.find(([c]) => c === docType)?.[1] ?? docType;
}

export async function requestJfUpload(actor: Actor, fileId: string, b: any) {
  const f = await loadFile(actor, fileId);
  if (!canEdit(actor, f) && !approver(actor)) throw forbidden('You cannot add documents to this Job File');
  if (f.status === 'cancelled') throw new ApiError(409, 'JOB_FILE_CANCELLED', 'This Job File is cancelled');
  const mime = String(b.mime_type ?? '').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!FILE_TYPES[mime]) throw bad('Upload a PDF, JPG, PNG, Excel or Word file');
  const size = Number(b.size);
  if (!Number.isFinite(size) || size <= 0) throw bad('The file is empty');
  if (size > MAX_BYTES) throw bad('Files can be up to 10 MB');
  const docType = String(b.doc_type ?? '');
  if (!/^[a-z_]{2,40}$/.test(docType)) throw bad('Choose the document type');
  if (b.replaces_id && !(isUuid(b.replaces_id) && await one('select 1 from jf_documents where id = $1 and job_file_id = $2 and replaced_at is null and deleted_at is null', [b.replaces_id, fileId])))
    throw bad('The document to replace was not found (maybe it was already replaced)');
  const name = String(b.file_name ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 150) || `document.${FILE_TYPES[mime]}`;
  const store = fileStore();
  const key = `jobfiles/${fileId}/${randomUUID()}.${FILE_TYPES[mime]}`;
  const upload = await store.createUpload(key, mime);
  const ticket = sign({ jf: fileId, key, name, mime, uid: actor.id, doc_type: docType, replaces_id: b.replaces_id || null,
    issue_date: day(b.issue_date, 'Issue date'), expiry_date: day(b.expiry_date, 'Expiry date'),
    description: String(b.description ?? '').trim().slice(0, 300) || null, exp: Date.now() + 3600_000 });
  return { upload, ticket };
}

export async function confirmJfUpload(actor: Actor, fileId: string, b: any) {
  const t = unsign(b.ticket);
  if (t.jf !== fileId || t.uid !== actor.id) throw forbidden('This upload belongs to someone else');
  const store = fileStore();
  const info = await store.stat(t.key);
  if (!info) throw new ApiError(409, 'UPLOAD_MISSING', 'The file did not arrive. Please try again.');
  if (info.size > MAX_BYTES) { await store.remove(t.key); throw bad('Files can be up to 10 MB'); }
  const label = await typeName(t.doc_type);
  await tx(async (c) => {
    await loadFile(actor, fileId, c, true);
    if (await one('select 1 from jf_documents where storage_path = $1', [t.key], c)) throw new ApiError(409, 'DUPLICATE', 'Already saved');
    let version = 1;
    if (t.replaces_id) {
      const old = await one('select * from jf_documents where id = $1 and job_file_id = $2 and replaced_at is null and deleted_at is null for update', [t.replaces_id, fileId], c);
      if (!old) throw new ApiError(409, 'ALREADY_REPLACED', 'Someone replaced this document a moment ago. Refresh and try again.');
      version = old.version + 1;
      await c.query('update jf_documents set replaced_at = now() where id = $1', [old.id]);
    }
    await c.query(`insert into jf_documents (job_file_id, doc_type, file_name, storage_path, mime_type, size_bytes, version, replaces_id, issue_date, expiry_date, description, uploaded_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [fileId, t.doc_type, t.name, t.key, t.mime, info.size, version, t.replaces_id, t.issue_date, t.expiry_date, t.description, actor.id]);
    await event(c, actor, fileId, { kind: 'document', title: version > 1 ? `${label} replaced (version ${version})` : `${label} uploaded`, new_value: t.name });
  });
  return getJobFile(actor, fileId);
}

/** Approve / reject (with a reason), waive or un-waive a required document, or remove a document. */
export async function jfDocAction(actor: Actor, fileId: string, b: any) {
  await tx(async (c) => {
    const f = await loadFile(actor, fileId, c, true);
    const what = String(b.what ?? '');
    if (what === 'approve' || what === 'reject') {
      if (!approver(actor)) throw forbidden('Only people who approve documents can do this');
      if (!isUuid(b.document_id)) throw bad('Choose the document');
      const d = await one('select * from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null and replaced_at is null for update', [b.document_id, fileId], c);
      if (!d) throw notFound('Document');
      const note = String(b.note ?? '').trim().slice(0, 500) || null;
      if (what === 'reject' && !note) throw bad('Say what is wrong with the document');
      await c.query(`update jf_documents set status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() where id = $1`,
        [d.id, what === 'approve' ? 'approved' : 'rejected', note, actor.id]);
      await event(c, actor, fileId, { kind: 'document', title: `${await typeName(d.doc_type)} ${what === 'approve' ? 'approved' : 'rejected'}`, new_value: note ?? d.file_name });
      // the uploader hears about a rejection
      if (what === 'reject' && d.uploaded_by && d.uploaded_by !== actor.id)
        await c.query('insert into notifications (user_id, type, title, job_file_id) values ($1,$2,$3,$4)',
          [d.uploaded_by, 'jf.doc_rejected', `Document rejected on Job File ${f.job_no}`, fileId]);
    } else if (what === 'waive' || what === 'unwaive') {
      if (!approver(actor)) throw forbidden('Only people who approve documents can do this');
      const docType = String(b.doc_type ?? '');
      if (!(await one('select 1 from doc_requirements where doc_type = $1', [docType], c))) throw bad('Choose a required document');
      if (what === 'waive') {
        const reason = String(b.reason ?? '').trim().slice(0, 300);
        if (!reason) throw bad('Say why this document is not needed for this Job File');
        await c.query(`insert into jf_doc_waivers (job_file_id, doc_type, reason, waived_by) values ($1,$2,$3,$4)
          on conflict (job_file_id, doc_type) do update set reason = excluded.reason, waived_by = excluded.waived_by, waived_at = now()`, [fileId, docType, reason, actor.id]);
        await event(c, actor, fileId, { kind: 'document', title: `${await typeName(docType)} marked not needed`, new_value: reason });
      } else {
        await c.query('delete from jf_doc_waivers where job_file_id = $1 and doc_type = $2', [fileId, docType]);
        await event(c, actor, fileId, { kind: 'document', title: `${await typeName(docType)} needed again` });
      }
    } else if (what === 'remove') {
      if (!isUuid(b.document_id)) throw bad('Choose the document');
      const d = await one('select * from jf_documents where id = $1 and job_file_id = $2 and deleted_at is null for update', [b.document_id, fileId], c);
      if (!d) throw notFound('Document');
      if (d.status === 'approved' ? !approver(actor) : !(canEdit(actor, f) || approver(actor))) throw forbidden('You cannot remove this document');
      await c.query('update jf_documents set deleted_at = now(), deleted_by = $2 where id = $1', [d.id, actor.id]);
      await event(c, actor, fileId, { kind: 'document', title: `${await typeName(d.doc_type)} removed`, old_value: d.file_name });
    } else throw bad('Unknown document action');
  });
  return getJobFile(actor, fileId);
}

/** Every click is checked against the Job File's own visibility, then a 2-minute link is handed out. */
export async function jfFileUrl(actor: Actor, docId: string, inline = false) {
  if (!isUuid(docId)) throw notFound('Document');
  const d = await one('select * from jf_documents where id = $1 and deleted_at is null', [docId]);
  if (!d) throw notFound('Document');
  await loadFile(actor, d.job_file_id);
  return fileStore().downloadUrl(d.storage_path, d.file_name, inline);
}

/** Settings → required documents: list, add, switch on/off. */
export async function docRequirements(actor: Actor) {
  if (!actor.isSuperAdmin && !actor.has('settings.manage') && !actor.has('documents.approve')) throw forbidden();
  return q('select * from doc_requirements order by is_active desc, sort_order, name');
}
export async function saveDocRequirement(actor: Actor, b: any) {
  if (!actor.isSuperAdmin && !actor.has('settings.manage')) throw forbidden();
  if (b.id) {
    if (!isUuid(b.id)) throw bad('Choose the requirement');
    await q('update doc_requirements set is_active = $2 where id = $1', [b.id, b.is_active !== false]);
  } else {
    const name = String(b.name ?? '').trim();
    if (!name || name.length > 80) throw bad('Enter the document name');
    const docType = String(b.doc_type ?? '').trim() || name.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (!/^[a-z_]{2,40}$/.test(docType)) throw bad('Document key: small letters and _ only');
    const pick = (v: unknown, list: string[]) => (v && list.includes(String(v)) ? String(v) : null);
    await q(`insert into doc_requirements (doc_type, name, direction, mode_group, needs, sort_order) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [docType, name, pick(b.direction, ['import', 'export', 'cross_trade', 'domestic']), pick(b.mode_group, ['sea', 'air', 'road']),
       pick(b.needs, ['clearance', 'transport', 'warehouse']), Number(b.sort_order) || 100]);
  }
  return docRequirements(actor);
}
