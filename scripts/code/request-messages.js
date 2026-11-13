// Where approvers reach this n8n. Empty: taken from n8n itself (the same
// address its Wait node links use, so WEBHOOK_URL applies).
const PUBLIC_URL = '';

const row = $input.first().json;
const base = (PUBLIC_URL || String($execution.resumeUrl).split('/webhook-waiting/')[0]).replace(/\/+$/, '');
// One message per approver. The link goes to the Decide workflow, never to a Wait node.
return JSON.parse(row.approvers).map((approver) => ({ json: {
  event: 'approval_requested',
  request_id: row.request_id,
  to: approver.name,
  title: row.title,
  details: row.details,
  link: base + '/webhook/approval/open?id=' + row.request_id + '&t=' + approver.token,
  expires_at: new Date(row.expires_at).toISOString(),
} }));
