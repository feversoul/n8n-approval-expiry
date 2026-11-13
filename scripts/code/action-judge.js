// What the answer of the guarded action means. Adapt it to your action.
const answer = $input.first().json;
const outcome = $('Outcome').first().json;
const ok = answer.statusCode >= 200 && answer.statusCode < 300;
const saw = answer.statusCode === undefined ? 'no answer: ' + String(answer.error?.message ?? answer.error ?? 'connection lost').slice(0, 160) : String(answer.statusCode);
return [{ json: {
  request_id: outcome.request_id,
  title: outcome.title,
  action_status: ok ? 'done' : 'failed',
  action_result: saw,
  at: new Date().toISOString(),
  event: ok ? 'action_done' : 'action_failed',
  by: outcome.by,
  detail: saw,
} }];
