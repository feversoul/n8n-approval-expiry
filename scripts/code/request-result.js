const row = $('Save as pending').first().json;
return [{ json: {
  request_id: row.request_id,
  status: row.status,
  expires_at: new Date(row.expires_at).toISOString(),
  approvers: JSON.parse(row.approvers).map((approver) => approver.name),
} }];
