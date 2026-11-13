const events = $input.all().map((item) => item.json).filter((row) => row.id !== undefined)
  .map((row) => ({ request_id: row.request_id, at: row.at, event: row.event, by: row.by, detail: row.detail }));
return [{ json: { events } }];
