// How long a request stays open when the caller does not say.
const DEFAULT_TTL_SECONDS = 86400;

const input = $input.first().json;
// Over the webhook the request is the body; from a sub-workflow call it is the item.
const request = input.webhookUrl && input.body ? input.body : input;
const title = String(request.title ?? '').trim();
if (!title) throw new Error('An approval request needs a title');
const approvers = (Array.isArray(request.approvers) ? request.approvers : [request.approvers ?? 'approver']).map((name) => String(name).trim()).filter(Boolean);
if (approvers.length === 0) throw new Error('An approval request needs at least one approver');
const ttl = Number(request.ttl_seconds ?? DEFAULT_TTL_SECONDS);
if (!(ttl > 0)) throw new Error('ttl_seconds must be a positive number');

const shared = { title, details: String(request.details ?? ''), payload: JSON.stringify(request.payload ?? {}), ttl };
// One item for the request id and one per approver: the next node gives each a random token.
return [{ json: { slot: 'request', ...shared } }, ...approvers.map((name) => ({ json: { slot: 'approver', name } }))];
