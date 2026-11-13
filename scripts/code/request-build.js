const items = $input.all().map((item) => item.json);
const head = items.find((item) => item.slot === 'request');
const approvers = items.filter((item) => item.slot === 'approver').map((item) => ({ name: item.name, token: item.token }));
const now = Date.now();
return [{ json: {
  request_id: head.token.slice(0, 24),
  title: head.title,
  details: head.details,
  payload: head.payload,
  status: 'pending',
  approvers: JSON.stringify(approvers),
  created_at: new Date(now).toISOString(),
  // A number, so the decision and the sweep can compare it in the table filter.
  expires_at: now + Math.round(head.ttl * 1000),
} }];
