const row = $input.first().json;
const click = $('Read the click').first().json;
const approver = approverOf(row, click.t);
if (!approver || !click.decision) {
  return [{ json: { valid: false, code: approver ? 400 : 404, html: page('This link is not valid', '<p>Check that you opened the whole link from the message.</p>') } }];
}
return [{ json: { ...click, valid: true, by: approver.name, decided_at: new Date(click.now).toISOString() } }];
