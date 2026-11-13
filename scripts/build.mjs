// Builds workflows/*.json (the approval pattern) and lab/*.json (the
// workflows that measure n8n's own Wait and send-and-wait behaviour).
//
// The results are plain n8n exports: import them and they run, no build
// needed. This script exists so the repeated parts are written once and the
// Code nodes can live in readable files (scripts/code/*.js). After a change:
//   node scripts/build.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Where messages and the guarded action go in the local stack. Replace the
// two HTTP nodes with your own (Slack, mail, your API); docker/prepare.mjs
// swaps these addresses when NOTIFY_URL or ACTION_URL is set.
const NOTIFY = 'http://standin:8080/sink/notify';
const ACTION = 'http://standin:8080/sink/action';
const LAB = 'http://standin:8080/sink/lab';

const REQUESTS = 'approval_requests';
const EVENTS = 'approval_events';
const TABLES = {
  [REQUESTS]: [
    ['request_id', 'string'], // random, also the first half of every link
    ['title', 'string'],
    ['details', 'string'],
    ['payload', 'string'], // JSON text handed to the guarded action
    ['status', 'string'], // pending | approved | rejected | expired
    ['approvers', 'string'], // JSON list of { name, token }: one link per approver
    ['created_at', 'string'],
    ['expires_at', 'number'], // epoch ms; compared inside the update's filter
    ['decided_by', 'string'], // approver name, or "timeout"
    ['decided_at', 'string'],
    ['decision_id', 'string'], // the click (or sweep run) that decided the row
    ['action_status', 'string'], // "" | running | done | failed
    ['action_result', 'string'],
  ],
  [EVENTS]: [
    ['request_id', 'string'],
    ['at', 'string'],
    ['event', 'string'], // approved | rejected | expired | late_click | repeat_click | action_done | action_failed
    ['by', 'string'],
    ['detail', 'string'],
  ],
};

const KEY = { httpHeaderAuth: { id: 'approvalKey', name: 'Approval Key' } };
const SMTP = { smtp: { id: 'approvalLabSmtp', name: 'Approval Lab SMTP' } };

const uuid = (seed) => {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const source = (...files) => files.map((file) => readFileSync(join(root, 'scripts/code', `${file}.js`), 'utf8').trimEnd()).join('\n\n');

const tableRef = (table) => ({ __rl: true, mode: 'name', value: table });
const where = (...conditions) => ({
  matchType: 'allConditions',
  filters: { conditions: conditions.map(([keyName, keyValue, condition = 'eq']) => ({ keyName, condition, keyValue })) },
});
const mapped = (table, values) => ({
  mappingMode: 'defineBelow',
  value: values,
  matchingColumns: [],
  schema: TABLES[table]
    .filter(([column]) => column in values)
    .map(([column, type]) => ({ id: column, displayName: column, required: false, defaultMatch: false, display: true, type, canBeUsedToMatch: true })),
  attemptToConvertTypes: false,
  convertFieldsToString: false,
});
// Column values taken from fields of the same name on the incoming item.
const fromItem = (table, ...columns) => mapped(table, Object.fromEntries(columns.map((column) => [column, `={{ $json.${column} }}`])));

function workflow(id, name, build) {
  const nodes = [];
  const connections = {};
  const api = {
    node(nodeName, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({ parameters, id: uuid(`${id}/${nodeName}`), name: nodeName, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra });
      return nodeName;
    },
    note(nodeName, lines, position, width, height, color = 4) {
      return api.node(nodeName, 'stickyNote', 1, position, { content: lines.join('\n'), width, height, color });
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: 0 });
    },
    chain(...names) {
      for (let i = 1; i < names.length; i++) api.link(names[i - 1], names[i]);
    },
    // A webhook. Protected ones need the header X-Workflow-Key; the two an
    // approver opens (open, decide) are public and guarded by the link token.
    hook(nodeName, method, path, position, { open = false, ...parameters } = {}) {
      return api.node(
        nodeName,
        'webhook',
        2,
        position,
        { httpMethod: method, path, ...(open ? {} : { authentication: 'headerAuth' }), responseMode: 'lastNode', options: {}, ...parameters },
        { webhookId: uuid(`${id}/webhook/${path}`), ...(open ? {} : { credentials: KEY }) },
      );
    },
    code(nodeName, position, ...files) {
      return api.node(nodeName, 'code', 2, position, { jsCode: source(...files) });
    },
    // An IF node on one JavaScript condition. Output 0 is true, 1 is false.
    when(nodeName, position, expression) {
      return api.node(nodeName, 'if', 2.2, position, {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{ id: uuid(`${id}/${nodeName}/condition`), leftValue: `={{ ${expression} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
          combinator: 'and',
        },
        options: { looseTypeValidation: true },
      });
    },
    rows(nodeName, position, table, operation, parameters, extra = {}) {
      return api.node(nodeName, 'dataTable', 1.1, position, { resource: 'row', operation, dataTableId: tableRef(table), ...parameters }, extra);
    },
    // POST the incoming item as JSON. Nothing here retries by itself.
    post(nodeName, position, url, body = '={{ JSON.stringify($json) }}', headers) {
      return api.node(
        nodeName,
        'httpRequest',
        4.2,
        position,
        {
          method: 'POST',
          url,
          ...(headers ? { sendHeaders: true, headerParameters: { parameters: headers } } : {}),
          sendBody: true,
          specifyBody: 'json',
          jsonBody: body,
          options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 10000 },
        },
        { onError: 'continueRegularOutput', retryOnFail: false },
      );
    },
    // An HTML page for the approver, with the status code the Code node chose.
    respond(nodeName, position, from) {
      return api.node(nodeName, 'respondToWebhook', 1.1, position, {
        respondWith: 'text',
        responseBody: `={{ ${from}.html }}`,
        options: { responseCode: `={{ ${from}.code }}`, responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } },
      });
    },
  };
  build(api);
  return { name, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, id };
}

// --- 0. Setup ----------------------------------------------------------------

const setup = workflow('approvalSetup', 'Approval · 0 Setup', (w) => {
  w.note(
    'About',
    [
      '## Approval · Setup',
      `Run this once: open it and press **Execute workflow**. It creates two data tables: \`${REQUESTS}\` (one row per request) and \`${EVENTS}\` (every decision, expiry and late or repeated click). Running it again changes nothing.`,
      '',
      'The webhook does the same for scripted installs (`POST approval/setup`). You can delete it.',
    ],
    [-40, -240],
    560,
    190,
  );
  w.node('Run once', 'manualTrigger', 1, [0, 0], {});
  w.hook('Or call', 'POST', 'approval/setup', [0, 180]);
  let previous;
  Object.entries(TABLES).forEach(([table, columns], index) => {
    const name = `Create ${table}`;
    w.node(name, 'dataTable', 1.1, [240 + index * 220, 0], {
      resource: 'table',
      operation: 'create',
      tableName: table,
      columns: { column: columns.map(([column, type]) => ({ name: column, type })) },
      options: { createIfNotExists: true },
    });
    if (previous) w.link(previous, name);
    else {
      w.link('Run once', name);
      w.link('Or call', name);
    }
    previous = name;
  });
});

// --- 1. Request ----------------------------------------------------------------

const request = workflow('approvalRequest', 'Approval · 1 Request', (w) => {
  w.note(
    'About',
    [
      '## Approval · Request',
      'Opens an approval request and sends each approver their own link. Then this workflow is **finished**: nothing waits in a Wait node, the request is a row in the data table.',
      '',
      'Call it with `{ title, details, approvers: ["Ana", "Ben"], ttl_seconds, payload }` from an **Execute Sub-workflow** node or `POST approval/request`. `payload` is handed to the guarded action when someone approves.',
      '',
      '- The row starts as `pending` with `expires_at`.',
      '- The link in the message points at **Approval · 2 Decide** (`approval/open?id=...&t=...`), not at a resume URL. It stays answerable for as long as the row exists.',
      '- Replace **Send the request** with your Slack, mail or Teams node: one item per approver with `to`, `title`, `details`, `link`, `expires_at`.',
      '',
      '`GET approval/requests?request_id=...` or `?status=pending` lists rows, `GET approval/events?request_id=...` the log.',
    ],
    [-40, -560],
    700,
    420,
  );
  w.node('When called', 'executeWorkflowTrigger', 1.1, [0, -80], { inputSource: 'passthrough' });
  w.hook('Request', 'POST', 'approval/request', [0, 100]);
  w.code('Entry', [220, 0], 'request-entry');
  // Random 128-bit tokens from n8n's Crypto node (the Code node has no crypto).
  w.node('Random tokens', 'crypto', 1, [440, 0], { action: 'generate', dataPropertyName: 'token', encodingType: 'hex', stringLength: 32 });
  w.code('Build the request', [660, 0], 'request-build');
  w.rows('Save as pending', [880, 0], REQUESTS, 'insert', {
    columns: fromItem(REQUESTS, 'request_id', 'title', 'details', 'payload', 'status', 'approvers', 'created_at', 'expires_at'),
    options: {},
  });
  w.code('One message per approver', [1100, 0], 'request-messages');
  w.post('Send the request', [1320, 0], NOTIFY);
  w.code('Result', [1540, 0], 'request-result');
  w.chain('When called', 'Entry');
  w.chain('Request', 'Entry', 'Random tokens', 'Build the request', 'Save as pending', 'One message per approver', 'Send the request', 'Result');

  // The rows and the log, for a person or a dashboard.
  w.hook('Requests', 'GET', 'approval/requests', [0, 420]);
  w.rows(
    'Rows',
    [220, 420],
    REQUESTS,
    'get',
    {
      matchType: 'anyCondition',
      filters: {
        conditions: [
          { keyName: 'request_id', condition: 'eq', keyValue: "={{ $json.query.request_id ?? '-' }}" },
          { keyName: 'status', condition: 'eq', keyValue: "={{ $json.query.status ?? '-' }}" },
        ],
      },
      returnAll: true,
    },
    { alwaysOutputData: true },
  );
  w.code('As a list', [440, 420], 'list-requests');
  w.chain('Requests', 'Rows', 'As a list');

  w.hook('Events', 'GET', 'approval/events', [0, 620]);
  w.rows('Event rows', [220, 620], EVENTS, 'get', { ...where(['request_id', "={{ $json.query.request_id ?? '-' }}"]), returnAll: true }, { alwaysOutputData: true });
  w.code('As a log', [440, 620], 'list-events');
  w.chain('Events', 'Event rows', 'As a log');
});

// --- 2. Decide -----------------------------------------------------------------

const decide = workflow('approvalDecide', 'Approval · 2 Decide', (w) => {
  w.note(
    'About',
    [
      '## Approval · Decide',
      'What an approver reaches from the link. Two public webhooks, guarded by the token in the link.',
      '',
      '**Open** (`GET approval/open`) only shows a page. A request that is still open gets two buttons. One that expired or was decided gets "expired at ..." or "already approved by ... at ...", and the visit is logged. Opening decides nothing, so a mail scanner or a link preview cannot approve.',
      '',
      '**Decide** (`POST approval/decide`) is the button. The decision is **one conditional update**: `request_id` matches, `status` is `pending`, `expires_at` is later than now. Whoever gets that update decided the request; every other click, late or repeated, reads the row and is told what happened. It works without the sweep having run.',
      '',
      'Only the click that won an **approve** reaches **Do the approved thing**. Replace that node with your action; `request_id` goes along as `Idempotency-Key`. **Tell the requester** reports approved and rejected.',
    ],
    [-40, -620],
    760,
    400,
  );

  // Open: a page, never a decision.
  w.hook('Open', 'GET', 'approval/open', [0, -120], { open: true, responseMode: 'responseNode' });
  w.rows('Find it', [220, -120], REQUESTS, 'get', { ...where(['request_id', "={{ $json.query.id ?? '-' }}"]), returnAll: false, limit: 1 }, { alwaysOutputData: true });
  w.code('Page', [440, -120], 'pages', 'open-page');
  w.when('Late or repeated?', [660, -120], '$json.log');
  w.rows('Log the visit', [880, -220], EVENTS, 'insert', { columns: fromItem(EVENTS, 'request_id', 'at', 'event', 'by', 'detail'), options: {} });
  w.respond('Show status', [1100, -220], "$('Page').first().json");
  w.respond('Show page', [880, -40], '$json');
  w.chain('Open', 'Find it', 'Page', 'Late or repeated?');
  w.link('Late or repeated?', 'Log the visit', 0);
  w.link('Late or repeated?', 'Show page', 1);
  w.chain('Log the visit', 'Show status');

  // Decide: one conditional update.
  w.hook('Decide', 'POST', 'approval/decide', [0, 260], { open: true, responseMode: 'responseNode' });
  w.code('Read the click', [220, 260], 'decide-read');
  w.rows('Find the request', [440, 260], REQUESTS, 'get', { ...where(['request_id', '={{ $json.request_id }}']), returnAll: false, limit: 1 }, { alwaysOutputData: true });
  w.code('Check the link', [660, 260], 'pages', 'decide-check');
  w.when('Valid?', [880, 260], '$json.valid');
  w.respond('Not valid', [1100, 440], '$json');
  w.rows(
    'Decide once',
    [1100, 200],
    REQUESTS,
    'update',
    {
      ...where(['request_id', '={{ $json.request_id }}'], ['status', 'pending'], ['expires_at', '={{ $json.now }}', 'gt']),
      columns: mapped(REQUESTS, { status: '={{ $json.decision }}', decided_by: '={{ $json.by }}', decided_at: '={{ $json.decided_at }}', decision_id: '={{ $json.decision_id }}' }),
      options: {},
    },
    { alwaysOutputData: true },
  );
  w.rows('Read it back', [1320, 200], REQUESTS, 'get', { ...where(['request_id', "={{ $('Check the link').first().json.request_id }}"]), returnAll: false, limit: 1 });
  w.code('Outcome', [1540, 200], 'pages', 'decide-outcome');
  w.rows('Log it', [1760, 200], EVENTS, 'insert', { columns: fromItem(EVENTS, 'request_id', 'at', 'event', 'by', 'detail'), options: {} });
  w.respond('Answer', [1980, 200], "$('Outcome').first().json");
  w.when('Won?', [2200, 200], "$('Outcome').first().json.won");
  w.when('Approved?', [2420, 120], "$('Outcome').first().json.status === 'approved'");
  const mine = ['request_id', "={{ $('Outcome').first().json.request_id }}"];
  w.rows('Mark action running', [2640, 40], REQUESTS, 'update', { ...where(mine), columns: mapped(REQUESTS, { action_status: 'running' }), options: {} });
  w.post(
    'Do the approved thing',
    [2860, 40],
    ACTION,
    "={{ JSON.stringify({ request_id: $('Outcome').first().json.request_id, title: $('Outcome').first().json.title, payload: JSON.parse($('Outcome').first().json.payload), approved_by: $('Outcome').first().json.by }) }}",
    [{ name: 'Idempotency-Key', value: "={{ $('Outcome').first().json.request_id }}" }],
  );
  w.code('Judge the action', [3080, 40], 'action-judge');
  w.rows('Save the action result', [3300, 40], REQUESTS, 'update', { ...where(['request_id', '={{ $json.request_id }}']), columns: fromItem(REQUESTS, 'action_status', 'action_result'), options: {} });
  w.rows('Log the action', [3520, 40], EVENTS, 'insert', {
    columns: mapped(EVENTS, Object.fromEntries(['request_id', 'at', 'event', 'by', 'detail'].map((column) => [column, `={{ $('Judge the action').first().json.${column} }}`]))),
    options: {},
  });
  const told = (extra) =>
    `={{ JSON.stringify({ event: $('Outcome').first().json.status, request_id: $('Outcome').first().json.request_id, title: $('Outcome').first().json.title, decided_by: $('Outcome').first().json.by, decided_at: $('Outcome').first().json.at${extra} }) }}`;
  w.post('Tell the requester', [3740, 40], NOTIFY, told(", action: $('Judge the action').first().json.action_status"));
  w.post('Tell the requester (rejected)', [2640, 220], NOTIFY, told(''));

  w.chain('Decide', 'Read the click', 'Find the request', 'Check the link', 'Valid?');
  w.link('Valid?', 'Decide once', 0);
  w.link('Valid?', 'Not valid', 1);
  w.chain('Decide once', 'Read it back', 'Outcome', 'Log it', 'Answer', 'Won?');
  w.link('Won?', 'Approved?', 0);
  w.link('Approved?', 'Mark action running', 0);
  w.link('Approved?', 'Tell the requester (rejected)', 1);
  w.chain('Mark action running', 'Do the approved thing', 'Judge the action', 'Save the action result', 'Log the action', 'Tell the requester');
});

// --- 3. Sweep ------------------------------------------------------------------

const sweep = workflow('approvalSweep', 'Approval · 3 Sweep', (w) => {
  w.note(
    'About',
    [
      '## Approval · Sweep',
      'Runs every minute and closes what nobody answered: one update sets every row that is still `pending` and past `expires_at` to `expired`. This is the timeout branch. It runs from the table, so it survives a restart and does not depend on a paused execution.',
      '',
      'A late click is already refused before this runs (the decision checks `expires_at` itself). The sweep makes the row say so and tells the requester once: replace **Timeout branch** with what should happen when nobody answered.',
      '',
      '`POST approval/sweep` runs it on demand.',
    ],
    [-40, -420],
    700,
    300,
  );
  w.node('Every minute', 'scheduleTrigger', 1.2, [0, -80], { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } });
  w.hook('Or call', 'POST', 'approval/sweep', [0, 100]);
  w.code('Now', [220, 0], 'sweep-now');
  w.rows(
    'Expire what is overdue',
    [440, 0],
    REQUESTS,
    'update',
    {
      ...where(['status', 'pending'], ['expires_at', '={{ $json.now }}', 'lte']),
      columns: mapped(REQUESTS, { status: 'expired', decided_by: 'timeout', decided_at: '={{ $json.at }}', decision_id: '={{ $json.sweep_id }}' }),
      options: {},
    },
    { alwaysOutputData: true },
  );
  w.code('Mine only', [660, 0], 'sweep-mine');
  w.when('Any?', [880, 0], '$json.expired.length > 0');
  w.code('One event each', [1100, -80], 'sweep-split');
  w.rows('Log the expiry', [1320, -80], EVENTS, 'insert', { columns: fromItem(EVENTS, 'request_id', 'at', 'event', 'by', 'detail'), options: {} });
  w.code('One message each', [1540, -80], 'sweep-notify');
  w.post('Timeout branch', [1760, -80], NOTIFY);
  w.node('Summary', 'set', 3.4, [1980, -80], {
    mode: 'raw',
    jsonOutput: "={{ JSON.stringify({ expired: $('Mine only').first().json.expired.map((row) => row.request_id) }) }}",
    options: {},
  }, { executeOnce: true });
  w.node('Nothing due', 'set', 3.4, [1100, 100], { mode: 'raw', jsonOutput: '={{ JSON.stringify({ expired: [] }) }}', options: {} });
  w.chain('Every minute', 'Now');
  w.chain('Or call', 'Now', 'Expire what is overdue', 'Mine only', 'Any?');
  w.link('Any?', 'One event each', 0);
  w.link('Any?', 'Nothing due', 1);
  w.chain('One event each', 'Log the expiry', 'One message each', 'Timeout branch', 'Summary');
});

// --- lab: what n8n's own nodes do with a late click ------------------------------

// Shared shape: POST approval-lab/<name> { run, limit_seconds, then } starts a
// run. The workflow reports its resume link and every step it reaches to the
// stand-in, where the test reads them.
const report = (step, fields) => `={{ JSON.stringify({ run: $('Start run').first().json.run, step: '${step}', execution_id: $execution.id${fields} }) }}`;
const limit = (amount) => ({ limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: amount, resumeUnit: 'seconds' });
const START = [
  'const body = $input.first().json.body ?? {};',
  "return [{ json: { run: String(body.run), limit: Number(body.limit_seconds ?? 5), then: String(body.then ?? 'end'), second_limit: Number(body.second_limit_seconds ?? 30) } }];",
].join('\n');
// After a Wait: did a request resume it, or did the time limit?
const AFTER = (step, resumedTest, decision) =>
  [
    'const data = $input.first().json;',
    `const resumed = ${resumedTest};`,
    `return [{ json: { run: $('Start run').first().json.run, step: '${step}', execution_id: $execution.id, outcome: resumed ? 'resumed' : 'timeout', decision: resumed ? String(${decision} ?? '') : '' } }];`,
  ].join('\n');

function lab(id, name, about, build) {
  return workflow(id, name, (w) => {
    w.note('About', [`## ${name}`, ...about, '', 'Measurement only. Not part of the approval pattern; see the README for what it showed.'], [-40, -360], 640, 240, 5);
    w.hook('Start', 'POST', `approval-lab/${id.replace('approvalLab', '').toLowerCase()}`, [0, 0], { responseMode: 'onReceived' });
    w.node('Start run', 'code', 2, [220, 0], { jsCode: START });
    build(w);
  });
}

const labWebhook = lab(
  'approvalLabWebhook',
  'Approval lab · Wait (webhook)',
  ['A Wait node that resumes **On Webhook Call** with a time limit. `then: "second-wait"` adds a second approval Wait in the same execution, `then: "pause"` a plain timed Wait.'],
  (w) => {
    w.post('Send the link', [440, 0], LAB, report('sent', ', url: $execution.resumeUrl'));
    w.node('Wait for approval', 'wait', 1.1, [660, 0], { resume: 'webhook', httpMethod: 'GET', responseMode: 'onReceived', ...limit("={{ $('Start run').first().json.limit }}"), options: {} }, { webhookId: uuid('lab/webhook/wait1') });
    w.node('What happened', 'code', 2, [880, 0], { jsCode: AFTER('after_wait', 'data.headers !== undefined && data.query !== undefined', 'data.query.decision') });
    w.post('Report', [1100, 0], LAB);
    w.when('Second approval?', [1320, 0], "$('Start run').first().json.then === 'second-wait'");
    w.node('Second approval', 'wait', 1.1, [1540, -100], { resume: 'webhook', httpMethod: 'GET', responseMode: 'onReceived', ...limit("={{ $('Start run').first().json.second_limit }}"), options: {} }, { webhookId: uuid('lab/webhook/wait2') });
    w.node('What happened then', 'code', 2, [1760, -100], { jsCode: AFTER('after_second_wait', 'data.headers !== undefined && data.query !== undefined', 'data.query.decision') });
    w.post('Report again', [1980, -100], LAB);
    w.when('Pause?', [1540, 100], "$('Start run').first().json.then === 'pause'");
    w.node('Pause', 'wait', 1.1, [1760, 100], { resume: 'timeInterval', amount: "={{ $('Start run').first().json.second_limit }}", unit: 'seconds' }, { webhookId: uuid('lab/webhook/pause') });
    w.post('Report the pause', [1980, 100], LAB, report('after_pause', ''));
    w.chain('Start', 'Start run', 'Send the link', 'Wait for approval', 'What happened', 'Report', 'Second approval?');
    w.link('Second approval?', 'Second approval', 0);
    w.link('Second approval?', 'Pause?', 1);
    w.chain('Second approval', 'What happened then', 'Report again');
    w.chain('Pause?', 'Pause', 'Report the pause');
  },
);

const labForm = lab('approvalLabForm', 'Approval lab · Wait (form)', ['A Wait node that resumes **On Form Submitted** with a time limit.'], (w) => {
  w.post('Send the link', [440, 0], LAB, report('sent', ', url: $execution.resumeFormUrl'));
  w.node(
    'Wait for approval',
    'wait',
    1.1,
    [660, 0],
    {
      resume: 'form',
      formTitle: 'Approve the request?',
      formDescription: 'Lab form',
      formFields: { values: [{ fieldLabel: 'Decision', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'approve' }, { option: 'reject' }] }, requiredField: true }] },
      responseMode: 'onReceived',
      ...limit("={{ $('Start run').first().json.limit }}"),
      options: {},
    },
    { webhookId: uuid('lab/form/wait1') },
  );
  w.node('What happened', 'code', 2, [880, 0], { jsCode: AFTER('after_wait', 'data.submittedAt !== undefined', 'data.Decision') });
  w.post('Report', [1100, 0], LAB);
  w.chain('Start', 'Start run', 'Send the link', 'Wait for approval', 'What happened', 'Report');
});

const labEmail = lab(
  'approvalLabEmail',
  'Approval lab · Email send and wait',
  ['The Email node\'s **Send and Wait for Response** (approve / disapprove) with a time limit, sent to a local mail sink. The same send-and-wait mechanics as the Slack node, without Slack.'],
  (w) => {
    w.node(
      'Send and wait',
      'emailSend',
      2.1,
      [440, 0],
      {
        operation: 'sendAndWait',
        fromEmail: 'n8n@example.test',
        toEmail: "={{ $json.run + '@example.test' }}",
        subject: "={{ 'Approve ' + $json.run + '?' }}",
        message: 'Lab approval request',
        responseType: 'approval',
        approvalOptions: { values: { approvalType: 'double' } },
        options: { limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: '={{ $json.limit }}', resumeUnit: 'seconds' } } },
      },
      { webhookId: uuid('lab/email/wait1'), credentials: SMTP },
    );
    w.node('What happened', 'code', 2, [660, 0], { jsCode: AFTER('after_wait', 'data.data !== undefined && data.data.approved !== undefined', "(data.data.approved ? 'approve' : 'reject')") });
    w.post('Report', [880, 0], LAB);
    w.chain('Start', 'Start run', 'Send and wait', 'What happened', 'Report');
  },
);

const write = (folder, file, data) => {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, file), `${JSON.stringify(data, null, 2)}\n`);
};
write('workflows', '0-setup.json', setup);
write('workflows', '1-request.json', request);
write('workflows', '2-decide.json', decide);
write('workflows', '3-sweep.json', sweep);
write('lab', 'lab-wait-webhook.json', labWebhook);
write('lab', 'lab-wait-form.json', labForm);
write('lab', 'lab-email-send-and-wait.json', labEmail);
console.log('workflows/ and lab/ written');
