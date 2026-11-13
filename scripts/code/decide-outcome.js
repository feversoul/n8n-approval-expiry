const row = $input.first().json;
const click = $('Check the link').first().json;
// Won only if the row carries the id of this click. Do not go by "a row came
// back": on SQLite and MySQL the update also returns rows it did not change.
const won = row.decision_id === click.decision_id && row.status === click.decision;
const base = { won, request_id: row.request_id, title: row.title, payload: row.payload, status: row.status, by: click.by, at: click.decided_at };
if (won) {
  const text = row.status === 'approved' ? 'Approved. Your decision was recorded at ' + when(row.decided_at) + '.' : 'Rejected. Your decision was recorded at ' + when(row.decided_at) + '. Nothing will be done.';
  return [{ json: { ...base, code: 200, event: row.status, detail: 'decided by this click', html: page(row.status === 'approved' ? 'Approved' : 'Rejected', '<p>' + esc(text) + '</p>') } }];
}
const answer = closed(row, click.now);
return [{ json: { ...base, code: answer.code, event: answer.event, detail: 'tried to ' + (click.decision === 'approved' ? 'approve' : 'reject') + '; ' + answer.text,
  html: page(answer.heading, '<p>' + esc(answer.text) + '</p>') } }];
