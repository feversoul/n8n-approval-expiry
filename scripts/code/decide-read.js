const body = $input.first().json.body ?? {};
const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
return [{ json: {
  request_id: String(body.id ?? ''),
  t: String(body.t ?? ''),
  decision: body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : '',
  // This click. The row keeps the id of the click that decided it.
  decision_id: $execution.id + '-' + hex() + hex(),
  now: Date.now(),
} }];
