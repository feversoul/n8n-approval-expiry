const row = $input.first().json;
const query = $('Open').first().json.query ?? {};
const now = Date.now();
const approver = approverOf(row, String(query.t ?? ''));
if (!approver) {
  return [{ json: { code: 404, log: false, html: page('This link is not valid', '<p>Check that you opened the whole link from the message.</p>') } }];
}
if (!isOpen(row, now)) {
  const answer = closed(row, now);
  return [{ json: { code: answer.code, log: true, html: page(answer.heading, '<p>' + esc(answer.text) + '</p>'),
    request_id: row.request_id, at: new Date(now).toISOString(), event: answer.event, by: approver.name, detail: 'opened the link; ' + answer.text } }];
}
// Still open. Opening the link decides nothing: the decision is the POST from
// one of the two buttons, so a mail scanner or link preview cannot approve.
const hidden = '<input type="hidden" name="id" value="' + esc(row.request_id) + '"><input type="hidden" name="t" value="' + esc(approver.token) + '">';
const body = '<p>' + esc(row.details) + '</p><p class="muted">Asked of ' + esc(approver.name) + '. Open until ' + when(row.expires_at) + '.</p>'
  + '<form method="post" action="decide">' + hidden
  + '<button name="decision" value="approve">Approve</button><button class="no" name="decision" value="reject">Reject</button></form>';
return [{ json: { code: 200, log: false, html: page(row.title, body) } }];
