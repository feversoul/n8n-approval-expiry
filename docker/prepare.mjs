// Used by bootstrap.sh inside the n8n container: writes the import files for
// the n8n CLI from the environment, so no secret is stored in the repository.
//   node prepare.mjs <output dir> <workflows dir>...
//
// Optional environment:
//   NOTIFY_URL, ACTION_URL    replace the stand-in addresses in the HTTP nodes
//   SWEEP_INTERVAL_SECONDS    how often the Sweep workflow runs (tests use seconds)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, ...sources] = process.argv.slice(2);
const env = process.env;

const credentials = [
  { id: 'approvalKey', name: 'Approval Key', type: 'httpHeaderAuth', data: { name: 'X-Workflow-Key', value: env.WORKFLOW_KEY } },
  // Lab only: the mail sink in the stand-in. No login, no TLS.
  { id: 'approvalLabSmtp', name: 'Approval Lab SMTP', type: 'smtp', data: { user: '', password: '', host: 'standin', port: 2525, secure: false, disableStartTls: true } },
];

mkdirSync(join(out, 'workflows'), { recursive: true });
writeFileSync(join(out, 'credentials.json'), JSON.stringify(credentials));

for (const source of sources) {
  for (const file of readdirSync(source).filter((name) => name.endsWith('.json'))) {
    let text = readFileSync(join(source, file), 'utf8');
    if (env.NOTIFY_URL) text = text.replaceAll('http://standin:8080/sink/notify', env.NOTIFY_URL);
    if (env.ACTION_URL) text = text.replaceAll('http://standin:8080/sink/action', env.ACTION_URL);
    const workflow = JSON.parse(text);
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.scheduleTrigger' && Number(env.SWEEP_INTERVAL_SECONDS) > 0) {
        node.parameters.rule = { interval: [{ field: 'seconds', secondsInterval: Number(env.SWEEP_INTERVAL_SECONDS) }] };
      }
    }
    writeFileSync(join(out, 'workflows', file), JSON.stringify(workflow));
  }
}
