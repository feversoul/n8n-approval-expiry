// --- shared by every node that answers an approver ---
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (value) => new Date(typeof value === 'number' ? value : String(value)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const page = (heading, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
  + '<title>' + esc(heading) + '</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#161616}'
  + 'main{max-width:520px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #ddd;border-radius:8px}'
  + 'h1{font-size:22px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:#666;font-size:14px}'
  + 'button{font:inherit;padding:10px 18px;margin-right:8px;border-radius:6px;border:1px solid #161616;background:#161616;color:#fff;cursor:pointer}'
  + 'button.no{background:#fff;color:#161616}</style></head><body><main><h1>' + esc(heading) + '</h1>' + body + '</main></body></html>';
// What a click on a request that is no longer open gets told.
function closed(row, now) {
  if (row.status === 'approved' || row.status === 'rejected') {
    return { code: 409, event: 'repeat_click', heading: 'Already ' + row.status,
      text: 'This request was already ' + row.status + ' by ' + row.decided_by + ' at ' + when(row.decided_at) + '. Your click changed nothing.' };
  }
  // "expired" in the table, or still "pending" there but past its deadline
  // (the sweep has not run yet). Both get the same answer.
  return { code: 410, event: 'late_click', heading: 'This request expired',
    text: 'This request expired at ' + when(row.expires_at) + '. Nothing was done. Your click was recorded. If it is still needed, ask for a new request.' };
}
const isOpen = (row, now) => row.status === 'pending' && now < Number(row.expires_at);
// The approver behind a link: the request id plus that person's own token.
const approverOf = (row, token) => row.id === undefined ? undefined : parse(row.approvers, []).find((approver) => approver.token && approver.token === token);
