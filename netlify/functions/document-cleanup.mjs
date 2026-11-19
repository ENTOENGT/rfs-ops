// The hourly clean-up of request documents is switched off (19 Nov 2026): the company keeps every document for good.
// No schedule is exported, so Netlify never runs this. The app's clean-up finds nothing to delete anyway
// (migration 029 removed every expiry date). Kept as a file only so an upload of changed files can replace the old one.
export default async () => new Response('Document clean-up is switched off: documents are kept for good.', { status: 200 });
