const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
// The approvers' tokens stay in the table.
const requests = $input.all().map((item) => item.json).filter((row) => row.id !== undefined).map((row) => ({
  ...row,
  payload: parse(row.payload, {}),
  approvers: parse(row.approvers, []).map((approver) => approver.name),
  expires_at_iso: new Date(row.expires_at).toISOString(),
}));
return [{ json: { requests } }];
