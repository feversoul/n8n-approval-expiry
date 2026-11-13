const sweep = $('Now').first().json;
// Only rows this run expired. A row that was approved in the same instant
// can come back from the update on SQLite; its decision_id is not ours.
const expired = $input.all().map((item) => item.json)
  .filter((row) => row.id !== undefined && row.status === 'expired' && row.decision_id === sweep.sweep_id)
  .map((row) => ({ request_id: row.request_id, title: row.title, payload: row.payload, expires_at: new Date(row.expires_at).toISOString() }));
return [{ json: { expired } }];
