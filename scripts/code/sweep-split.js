const sweep = $('Now').first().json;
return $input.first().json.expired.map((row) => ({ json: {
  request_id: row.request_id, at: sweep.at, event: 'expired', by: 'timeout', detail: 'deadline was ' + row.expires_at,
} }));
