const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
const now = Date.now();
return [{ json: { now, at: new Date(now).toISOString(), sweep_id: 'sweep-' + $execution.id + '-' + hex() + hex() } }];
