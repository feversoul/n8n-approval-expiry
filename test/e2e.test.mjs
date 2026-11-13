// End-to-end tests on a real n8n (npm run test:e2e). Two parts:
//
// 1. Lab: what n8n's own nodes do with a late, repeated or simultaneous
//    click. Wait (On Webhook Call), Wait (On Form Submitted) and the Email
//    node's Send and Wait for Response, each with a time limit. The lab
//    workflows report every step they reach to the stand-in; the tests click
//    the real resume links and write down status code and page text.
// 2. Pattern: the approval workflows in workflows/. Approve, reject, timeout,
//    late click, double click, two approvers at once, a click at the moment
//    of expiry, and a restart while requests are pending. What counts is the
//    stand-in's own record of how often the guarded action ran.
//
// Assertions in the lab part pin what n8n 2.47.7 did. If a later version
// behaves differently, those tests fail and tell you what changed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.N8N_URL ?? 'http://localhost:55687';
const STANDIN = process.env.STANDIN_URL ?? 'http://localhost:58089';
const KEY = process.env.WORKFLOW_KEY ?? 'test-workflow-key';
const BACKEND = process.env.BACKEND ?? 'SQLite';
const RUN = Date.now().toString(36);
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' };

const headers = { 'x-workflow-key': KEY, 'content-type': 'application/json' };
const findings = [];
const finding = (part, what, saw) => findings.push({ part, what, saw });

async function until(check, timeoutMs = 30_000, every = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(every);
  }
}

// One request as an approver's browser would make it: status code and the
// visible text of the answer. "no answer" when n8n does not reply in time.
async function click(url, options = {}, waitMs = 10_000) {
  let response;
  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(waitMs), ...options, headers: { ...BROWSER, ...options.headers } });
  } catch {
    return { status: 0, text: `no answer in ${waitMs / 1000} s`, body: '' };
  }
  const body = await response.text();
  const text = body
    .replace(/<(style|script|title)[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { status: response.status, text, body, headers: response.headers };
}
const short = (answer) => `${answer.status || ''} ${answer.text.replace(/\\?"/g, "'").slice(0, 110)}`.trim();
const sink = async (name, query = '') => (await (await fetch(`${STANDIN}/sink/${name}?${query}`)).json()).items;
const ready = () => until(async () => (await fetch(`${BASE}/webhook/approval/setup`, { method: 'POST', headers, body: '{}' })).status === 200, 240_000, 1000);

before(ready);

after(() => {
  console.log(`\nn8n 2.47.7, database ${BACKEND}.\n`);
  for (const part of [...new Set(findings.map((line) => line.part))]) {
    console.log(`  ${part}`);
    const lines = findings.filter((line) => line.part === part);
    const width = Math.max(...lines.map((line) => line.what.length));
    for (const line of lines) console.log(`    ${line.what.padEnd(width)}  ${line.saw}`);
    console.log('');
  }
});

// ============================================================================
// Part 1: lab. n8n's own Wait and send-and-wait nodes.
// ============================================================================

let counter = 0;
const runName = (name) => `${name}-${RUN}-${++counter}`;
const steps = (run) => sink('lab', `run=${run}`);
const step = async (run, name) => (await steps(run)).find((item) => item.step === name);
const KINDS = ['Wait (webhook)', 'Wait (form)', 'Email send-and-wait'];

// Starts one lab run and returns how to approve it, the way that node offers it.
async function startLab(kind, options) {
  const run = runName(kind === 'Wait (webhook)' ? 'hook' : kind === 'Wait (form)' ? 'form' : 'mail');
  const path = kind === 'Wait (webhook)' ? 'webhook' : kind === 'Wait (form)' ? 'form' : 'email';
  const response = await fetch(`${BASE}/webhook/approval-lab/${path}`, { method: 'POST', headers, body: JSON.stringify({ run, ...options }) });
  assert.equal(response.status, 200);
  const startedAt = Date.now();
  if (kind === 'Email send-and-wait') {
    const mail = await until(async () => (await (await fetch(`${STANDIN}/mail?to=${run}`)).json()).mails[0]);
    const approveUrl = mail.links.find((link) => link.includes('approved=true'));
    const rejectUrl = mail.links.find((link) => link.includes('approved=false'));
    assert.ok(approveUrl && rejectUrl, 'the mail carries an approve and a disapprove link');
    return { kind, run, startedAt, approve: (options) => click(approveUrl, options), reject: () => click(rejectUrl), open: () => click(approveUrl) };
  }
  const sent = await until(() => step(run, 'sent'));
  if (kind === 'Wait (form)') {
    const submit = (value) => {
      const form = new FormData();
      form.set('field-0', value);
      return click(sent.url, { method: 'POST', body: form });
    };
    return { kind, run, startedAt, url: sent.url, approve: () => submit('approve'), reject: () => submit('reject'), open: () => click(sent.url) };
  }
  return { kind, run, startedAt, url: sent.url, approve: (options) => click(`${sent.url}&decision=approve`, options), reject: () => click(`${sent.url}&decision=reject`), open: () => click(`${sent.url}&decision=approve`) };
}
const outcome = (run, name = 'after_wait', timeoutMs = 20_000) => until(() => step(run, name), timeoutMs);
const outcomes = async (run) => (await steps(run)).filter((item) => item.step === 'after_wait');

test('lab: a 3 to 5 second time limit is acted on at n8n\'s next check, and the old link afterwards', { timeout: 200_000 }, async () => {
  const hook = await startLab('Wait (webhook)', { limit_seconds: 5 });
  const chained = await startLab('Wait (webhook)', { limit_seconds: 3, then: 'second-wait', second_limit_seconds: 900 });
  const form = await startLab('Wait (form)', { limit_seconds: 3 });
  const mail = await startLab('Email send-and-wait', { limit_seconds: 3 });

  for (const lab of [hook, chained, form, mail]) {
    const result = await outcome(lab.run, 'after_wait', 120_000);
    assert.equal(result.outcome, 'timeout');
    lab.tookSeconds = (result.received_ms - lab.startedAt) / 1000;
  }
  assert.ok(hook.tookSeconds >= 5);
  finding('Lab: time limit', 'Wait (webhook), limit 5 s: timeout branch ran after', `${hook.tookSeconds.toFixed(0)} s`);
  finding('Lab: time limit', 'Wait (form), limit 3 s: timeout branch ran after', `${form.tookSeconds.toFixed(0)} s`);
  finding('Lab: time limit', 'Email send-and-wait, limit 3 s: timeout branch ran after', `${mail.tookSeconds.toFixed(0)} s`);
  await sleep(1500);

  // The execution has finished. Now the approver clicks.
  const lateHook = await hook.approve();
  assert.equal(lateHook.status, 409);
  assert.match(lateHook.text, /has finished already/);
  finding('Lab: click after the timeout branch ran', 'Wait (webhook)', short(lateHook));

  const lateFormOpen = await form.open();
  const lateFormSubmit = await form.approve();
  assert.equal(lateFormOpen.status, 200);
  assert.equal(lateFormSubmit.status, 200);
  assert.match(lateFormSubmit.text, /Your response has been recorded/);
  finding('Lab: click after the timeout branch ran', 'Wait (form), open the link', short(lateFormOpen));
  finding('Lab: click after the timeout branch ran', 'Wait (form), submit', short(lateFormSubmit));

  const lateMail = await mail.approve();
  assert.equal(lateMail.status, 200);
  assert.match(lateMail.text, /No action required/);
  finding('Lab: click after the timeout branch ran', 'Email send-and-wait', short(lateMail));

  // The execution went on to another approval Wait. The first link is the same address.
  const stale = await chained.approve();
  assert.equal(stale.status, 200);
  const second = await outcome(chained.run, 'after_second_wait');
  assert.equal(second.outcome, 'resumed');
  assert.equal(second.decision, 'approve');
  finding('Lab: click after the timeout branch ran', 'Wait (webhook), execution now in a later approval Wait', `${short(stale)} -> approved the LATER wait`);

  await sleep(1500);
  for (const lab of [hook, form, mail]) assert.deepEqual((await outcomes(lab.run)).map((item) => item.outcome), ['timeout'], `${lab.kind}: the late click changed nothing`);
});

// Runs right after the test above, so n8n's next check of waiting executions
// is most of a minute away.
test('lab: a click 5 seconds after the time limit, before n8n has acted on it, still approves', { timeout: 60_000 }, async () => {
  const labs = await Promise.all(KINDS.map((kind) => startLab(kind, { limit_seconds: 3 })));
  await sleep(8000 - (Date.now() - labs[0].startedAt));
  for (const lab of labs) {
    const answer = await lab.approve();
    const result = await outcome(lab.run);
    assert.equal(answer.status, 200);
    assert.equal(result.outcome, 'resumed');
    assert.equal(result.decision, 'approve');
    finding('Lab: click 5 s after the limit, timeout branch not run yet', lab.kind, `${short(answer)} -> approved`);
  }
});

test('lab: the same link clicked twice', { timeout: 90_000 }, async () => {
  for (const kind of KINDS) {
    const lab = await startLab(kind, { limit_seconds: 900 });
    const first = await lab.approve();
    const second = await lab.approve();
    assert.equal(first.status, 200);
    await outcome(lab.run);
    await sleep(2000);
    const third = await lab.reject();
    assert.deepEqual((await outcomes(lab.run)).map((item) => item.decision), ['approve'], `${kind}: resumed once`);
    assert.ok(!(second.status === 200 && /Workflow was started|"status":200|Got it, thanks/.test(second.text)), `${kind}: the second click must not look like a first one`);
    finding('Lab: same link twice', `${kind}, first click`, short(first));
    finding('Lab: same link twice', `${kind}, second click right behind it`, short(second));
    finding('Lab: same link twice', `${kind}, again 2 s later`, short(third));
  }
});

test('lab: approve and reject arrive at the same instant (three clicks, 4 rounds each)', { timeout: 120_000 }, async () => {
  for (const kind of KINDS) {
    const seen = new Map();
    for (let round = 0; round < 4; round++) {
      const lab = await startLab(kind, { limit_seconds: 900 });
      const answers = await Promise.all([lab.approve(), lab.reject(), lab.approve()]);
      await outcome(lab.run);
      await sleep(1500);
      const results = await outcomes(lab.run);
      assert.equal(results.length, 1, `${kind}: the execution went on exactly once`);
      const accepted = answers.filter((answer) => answer.status === 200);
      assert.equal(accepted.length, 1, `${kind}: one click was accepted`);
      for (const answer of answers) if (answer.status !== 200) seen.set(short(answer), (seen.get(short(answer)) ?? 0) + 1);
    }
    finding('Lab: three clicks at once', kind, `resumed once in 4 of 4 rounds; the others got: ${[...seen].map(([text, count]) => `${count}x ${text}`).join(' | ')}`);
  }
});

test('lab: who can trigger a resume link', { timeout: 60_000 }, async () => {
  // A Wait link is a GET. Whatever fetches it approves.
  const hook = await startLab('Wait (webhook)', { limit_seconds: 900 });
  const scanner = await click(`${hook.url}&decision=approve`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; LinkScanner/1.0; bot)' } });
  const afterScanner = await outcome(hook.run);
  assert.equal(scanner.status, 200);
  assert.equal(afterScanner.outcome, 'resumed');
  finding('Lab: a link scanner fetches the link (user agent contains "bot")', 'Wait (webhook)', `${short(scanner)} -> approved`);

  const mail = await startLab('Email send-and-wait', { limit_seconds: 900 });
  const preview = await mail.approve({ headers: { 'user-agent': 'Mozilla/5.0 (compatible; LinkScanner/1.0; bot)' } });
  await sleep(2000);
  assert.equal(preview.status, 200);
  assert.equal(preview.text, '');
  assert.equal((await outcomes(mail.run)).length, 0, 'a bot user agent does not approve a send-and-wait link');
  const person = await mail.approve();
  assert.equal(person.status, 200);
  assert.equal((await outcome(mail.run)).decision, 'approve');
  finding('Lab: a link scanner fetches the link (user agent contains "bot")', 'Email send-and-wait', '200, empty page -> nothing happened; a browser click afterwards approved');

  // The link without its signature, and a link to an execution now in a timed Wait.
  const unsigned = await click(hook.url.split('?')[0]);
  assert.equal(unsigned.status, 401);
  const paused = await startLab('Wait (webhook)', { limit_seconds: 900, then: 'pause', second_limit_seconds: 120 });
  assert.equal((await paused.approve()).status, 200);
  await outcome(paused.run);
  await sleep(1500);
  const duringPause = await paused.approve();
  assert.equal(duringPause.status, 404);
  finding('Lab: same link twice', 'Wait (webhook), again while the execution sits in a timed Wait', short(duringPause));
});

test('lab: the click arrives at the moment of the time limit (75 s limit, 10 runs)', { timeout: 200_000 }, async () => {
  const offsets = [-50, 0, 50, 100, 150, 200, 300, 500, 1000, 2000];
  const labs = await Promise.all(offsets.map(() => startLab('Wait (webhook)', { limit_seconds: 75 })));
  const sentAt = await Promise.all(labs.map(async (lab) => (await step(lab.run, 'sent')).received_ms));
  const answers = await Promise.all(
    labs.map(async (lab, index) => {
      await sleep(sentAt[index] + 75_000 + offsets[index] - Date.now());
      return lab.approve();
    }),
  );
  await sleep(5000);
  let approved = 0;
  const refusals = new Set();
  for (const [index, lab] of labs.entries()) {
    const results = await outcomes(lab.run);
    assert.equal(results.length, 1, 'one outcome per run, never both branches');
    // The approver is told the truth: 200 exactly when the approval counted.
    assert.equal(answers[index].status === 200, results[0].outcome === 'resumed', `offset ${offsets[index]} ms: answer ${answers[index].status}, outcome ${results[0].outcome}`);
    if (results[0].outcome === 'resumed') approved++;
    else refusals.add(short(answers[index]));
  }
  finding('Lab: click at the moment of the limit', 'Wait (webhook), 10 clicks from 50 ms before to 2 s after', `${approved} approved, ${10 - approved} timed out; never both. Refused clicks got: ${[...refusals].join(' | ') || '-'}`);
});

// ============================================================================
// Part 2: the approval pattern.
// ============================================================================

async function open(body) {
  const response = await fetch(`${BASE}/webhook/approval/request`, { method: 'POST', headers, body: JSON.stringify({ details: 'EUR 1,200 to Acme', payload: { invoice: 42 }, ...body }) });
  assert.equal(response.status, 200);
  const request = await response.json();
  // The links come from the message each approver was sent.
  const messages = await until(async () => {
    const items = await sink('notify', `request_id=${request.request_id}&event=approval_requested`);
    return items.length === request.approvers.length ? items : null;
  });
  const links = Object.fromEntries(messages.map((message) => [message.to, message.link]));
  return { ...request, id: request.request_id, links, expiresMs: Date.parse(request.expires_at) };
}
function press(link, decision) {
  const url = new URL(link);
  return click(`${BASE}/webhook/approval/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: url.searchParams.get('id'), t: url.searchParams.get('t'), decision }).toString(),
  });
}
const row = async (id) => (await (await fetch(`${BASE}/webhook/approval/requests?request_id=${id}`, { headers })).json()).requests[0];
const events = async (id) => (await (await fetch(`${BASE}/webhook/approval/events?request_id=${id}`, { headers })).json()).events;
const actions = (id) => sink('action', `request_id=${id}`);
const told = (id, event) => sink('notify', `request_id=${id}&event=${event}`);
const status = (id, wanted, timeoutMs = 30_000) => until(async () => {
  const found = await row(id);
  return found && found.status === wanted ? found : null;
}, timeoutMs);
const actionDone = (id) => until(async () => {
  const found = await row(id);
  return found.action_status === 'done' ? found : null;
});
const sweep = () => fetch(`${BASE}/webhook/approval/sweep`, { method: 'POST', headers, body: '{}' }).then((response) => response.json());

test('approve: the page has two buttons, opening it decides nothing, the button runs the action once', async () => {
  const request = await open({ title: `Approve ${RUN}`, approvers: ['Ana'], ttl_seconds: 600 });
  // A scanner, a preview and the approver all open the link.
  for (let i = 0; i < 3; i++) {
    const page = await click(request.links.Ana, i === 0 ? { headers: { 'user-agent': 'LinkScanner/1.0 bot' } } : {});
    assert.equal(page.status, 200);
    assert.match(page.body, /<form method="post" action="decide">/);
    assert.match(page.body, /value="approve"/);
    assert.match(page.headers.get('content-security-policy') ?? 'allow-forms', /allow-forms/, 'n8n sandboxes the page but lets the form post');
  }
  assert.equal((await row(request.id)).status, 'pending');
  assert.equal((await actions(request.id)).length, 0);

  const answer = await press(request.links.Ana, 'approve');
  assert.equal(answer.status, 200);
  assert.match(answer.text, /Approved\. Your decision was recorded at/);
  const done = await actionDone(request.id);
  assert.equal(done.status, 'approved');
  assert.equal(done.decided_by, 'Ana');
  const ran = await actions(request.id);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].idempotency_key, request.id);
  assert.deepEqual(ran[0].payload, { invoice: 42 });
  await until(async () => (await told(request.id, 'approved')).length === 1);
  finding('Pattern', 'approve', `${short(answer)}; action ran 1x`);

  const wrong = await click(`${request.links.Ana}0`);
  assert.equal(wrong.status, 404);
  assert.equal((await press(`${request.links.Ana}0`, 'approve')).status, 404);
});

test('reject: recorded, the action never runs', async () => {
  const request = await open({ title: `Reject ${RUN}`, approvers: ['Ana'], ttl_seconds: 600 });
  const answer = await press(request.links.Ana, 'reject');
  assert.equal(answer.status, 200);
  assert.match(answer.text, /Rejected\. Your decision was recorded/);
  await until(async () => (await told(request.id, 'rejected')).length === 1);
  await sleep(1500);
  assert.equal((await row(request.id)).status, 'rejected');
  assert.equal((await actions(request.id)).length, 0);
  finding('Pattern', 'reject', `${short(answer)}; action ran 0x`);
});

test('timeout, then a late click: expired by the sweep, told once, the click gets "expired at ..." and is logged', async () => {
  const request = await open({ title: `Timeout ${RUN}`, approvers: ['Ana', 'Ben'], ttl_seconds: 2 });
  const expired = await status(request.id, 'expired');
  assert.equal(expired.decided_by, 'timeout');
  await sleep(5000); // two more sweeps
  assert.equal((await told(request.id, 'expired')).length, 1, 'the timeout branch ran once');

  const stamp = request.expires_at.replace('T', ' ').slice(0, 19);
  const page = await click(request.links.Ana);
  assert.equal(page.status, 410);
  assert.ok(page.text.includes(`This request expired at ${stamp} UTC`), page.text);
  const answer = await press(request.links.Ben, 'approve');
  assert.equal(answer.status, 410);
  assert.ok(answer.text.includes(`This request expired at ${stamp} UTC`), answer.text);
  await sleep(1500);
  assert.equal((await row(request.id)).status, 'expired');
  assert.equal((await actions(request.id)).length, 0);
  const log = await events(request.id);
  assert.deepEqual(log.map((entry) => `${entry.event}:${entry.by}`).sort(), ['expired:timeout', 'late_click:Ana', 'late_click:Ben']);
  finding('Pattern', 'timeout (2 s), nobody answers', 'row expired, requester told 1x, action ran 0x');
  finding('Pattern', 'late click after expiry', `${short(answer)}; logged with the approver's name; action ran 0x`);
});

test('late click before the sweep has run: refused by the deadline in the row itself', { timeout: 60_000 }, async () => {
  // Eight requests, each clicked 100 to 800 ms after its own deadline. The
  // sweep runs every 2 s, so for most of them it has not run yet.
  const requests = await Promise.all(Array.from({ length: 8 }, (_, index) => open({ title: `Late ${RUN} ${index}`, approvers: ['Ana'], ttl_seconds: 3 })));
  const answers = await Promise.all(
    requests.map(async (request, index) => {
      await sleep(request.expiresMs + 100 * (index + 1) - Date.now());
      return press(request.links.Ana, 'approve');
    }),
  );
  let beforeSweep = 0;
  for (const [index, request] of requests.entries()) {
    assert.equal(answers[index].status, 410, `click ${100 * (index + 1)} ms late`);
    await status(request.id, 'expired');
    const log = await until(async () => {
      const entries = await events(request.id);
      return entries.length === 2 ? entries : null;
    });
    const late = log.find((entry) => entry.event === 'late_click');
    const expired = log.find((entry) => entry.event === 'expired');
    if (late.at < expired.at) beforeSweep++;
    assert.equal((await actions(request.id)).length, 0);
  }
  assert.ok(beforeSweep >= 1, 'at least one click arrived before the sweep');
  finding('Pattern', 'click 100-800 ms after the deadline (8 requests)', `8 of 8 got 410; ${beforeSweep} of them arrived before the sweep had run; action ran 0x`);
});

test('double click: five presses of the same button at once, 6 rounds', { timeout: 60_000 }, async () => {
  for (let round = 0; round < 6; round++) {
    const request = await open({ title: `Double ${RUN} ${round}`, approvers: ['Ana'], ttl_seconds: 600 });
    const answers = await Promise.all(Array.from({ length: 5 }, () => press(request.links.Ana, 'approve')));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409, 409, 409, 409]);
    for (const answer of answers.filter((entry) => entry.status === 409)) assert.match(answer.text, /already approved by Ana at/);
    await actionDone(request.id);
    await sleep(500);
    assert.equal((await actions(request.id)).length, 1);
    assert.equal((await events(request.id)).filter((entry) => entry.event === 'repeat_click').length, 4);
  }
  finding('Pattern', 'double click: 5 presses at once, 6 rounds', 'each round 1x 200 and 4x 409 "already approved by Ana at ..."; action ran 1x per round');
});

test('two approvers at once: Ana approves while Ben rejects, 12 rounds', { timeout: 90_000 }, async () => {
  const winners = { Ana: 0, Ben: 0 };
  for (let round = 0; round < 12; round++) {
    const request = await open({ title: `Two ${RUN} ${round}`, approvers: ['Ana', 'Ben'], ttl_seconds: 600 });
    const [ana, ben] = await Promise.all([press(request.links.Ana, 'approve'), press(request.links.Ben, 'reject')]);
    assert.deepEqual([ana.status, ben.status].sort(), [200, 409], 'exactly one decision');
    const winner = ana.status === 200 ? 'Ana' : 'Ben';
    winners[winner]++;
    const decided = await until(async () => {
      const found = await row(request.id);
      return found.status !== 'approved' || found.action_status === 'done' ? found : null;
    });
    assert.equal(decided.decided_by, winner);
    assert.equal(decided.status, winner === 'Ana' ? 'approved' : 'rejected');
    const loser = winner === 'Ana' ? ben : ana;
    assert.match(loser.text, new RegExp(`already ${decided.status} by ${winner} at`));
    await sleep(400);
    assert.equal((await actions(request.id)).length, winner === 'Ana' ? 1 : 0);
  }
  finding('Pattern', 'two approvers at once (approve vs reject), 12 rounds', `one decision per round (Ana ${winners.Ana}, Ben ${winners.Ben}); the other was told who decided; action ran only when the approval won`);
});

test('approve at the moment of expiry, with the sweep called in the same instant: 14 requests', { timeout: 90_000 }, async () => {
  const offsets = [-200, -80, -40, -20, -10, -5, 0, 5, 10, 20, 40, 80, 300, 600];
  const requests = await Promise.all(offsets.map((offset, index) => open({ title: `Edge ${RUN} ${index}`, approvers: ['Ana'], ttl_seconds: 3 })));
  const answers = await Promise.all(
    requests.map(async (request, index) => {
      await sleep(request.expiresMs + offsets[index] - Date.now());
      const [answer] = await Promise.all([press(request.links.Ana, 'approve'), sweep()]);
      return answer;
    }),
  );
  await Promise.all(requests.map((request) => until(async () => ((await row(request.id)).status !== 'pending' ? true : null))));
  await sleep(5000);
  let approved = 0;
  for (const [index, request] of requests.entries()) {
    const final = await row(request.id);
    const won = final.status === 'approved';
    assert.ok(won || final.status === 'expired', `offset ${offsets[index]}: ${final.status}`);
    assert.equal(answers[index].status, won ? 200 : 410, `offset ${offsets[index]} ms: the page tells what the row says`);
    assert.equal((await actions(request.id)).length, won ? 1 : 0);
    assert.equal((await told(request.id, 'expired')).length, won ? 0 : 1);
    assert.equal((await told(request.id, 'approved')).length, won ? 1 : 0);
    if (offsets[index] >= 300) assert.equal(won, false, 'a click 300 ms or more past the deadline never wins');
    if (won) approved++;
  }
  finding('Pattern', 'approve from 200 ms before to 600 ms after the deadline, sweep called in the same instant (14 requests)', `${approved} approved, ${14 - approved} expired; never both: action and "expired" message never for the same request`);
});

// ============================================================================
// Restart: both parts.
// ============================================================================

test('n8n stopped for 15 s while approvals are open', { timeout: 300_000, skip: !process.env.STOP_N8N && 'needs STOP_N8N and START_N8N (npm run test:e2e sets them)' }, async () => {
  const compose = (variable) => {
    const [command, ...args] = JSON.parse(process.env[variable]);
    assert.equal(spawnSync(command, args, { stdio: 'ignore' }).status, 0, variable);
  };
  const labs = await Promise.all(KINDS.map((kind) => startLab(kind, { limit_seconds: 900 })));
  const passing = await startLab('Wait (webhook)', { limit_seconds: 10 }); // its limit passes while n8n is down
  const open1 = await open({ title: `Restart ${RUN}`, approvers: ['Ana', 'Ben'], ttl_seconds: 600 });
  const short1 = await open({ title: `Restart short ${RUN}`, approvers: ['Ana'], ttl_seconds: 6 }); // expires while n8n is down

  compose('STOP_N8N');
  await sleep(15_000);
  const startedAt = Date.now();
  compose('START_N8N');
  await ready();

  // n8n's own nodes: the wait is in the database and the links still work.
  for (const lab of labs) {
    const answer = await lab.approve();
    assert.equal(answer.status, 200, lab.kind);
    assert.equal((await outcome(lab.run)).outcome, 'resumed');
    finding('Restart while waiting', `${lab.kind}, click after the restart`, `${short(answer)} -> approved`);
  }
  const passed = await outcome(passing.run, 'after_wait', 150_000);
  assert.equal(passed.outcome, 'timeout');
  finding('Restart while waiting', 'Wait (webhook) whose 10 s limit passed while n8n was down', `timeout branch ran ${((passed.received_ms - startedAt) / 1000).toFixed(0)} s after n8n was started again`);

  // The pattern: rows, so nothing to resume.
  const expired = await status(short1.id, 'expired');
  assert.equal(expired.decided_by, 'timeout');
  const late = await press(short1.links.Ana, 'approve');
  assert.equal(late.status, 410);
  const page = await click(open1.links.Ben);
  assert.equal(page.status, 200);
  const answer = await press(open1.links.Ana, 'approve');
  assert.equal(answer.status, 200);
  await actionDone(open1.id);
  const again = await press(open1.links.Ben, 'approve');
  assert.equal(again.status, 409);
  await sleep(3000);
  assert.equal((await actions(open1.id)).length, 1);
  assert.equal((await actions(short1.id)).length, 0);
  assert.equal((await told(short1.id, 'expired')).length, 1);
  finding('Restart while waiting', 'Pattern: request open across the restart', `${short(answer)}; action ran 1x`);
  finding('Restart while waiting', 'Pattern: request whose deadline passed while n8n was down', `expired by the first sweep, requester told 1x, late click: ${short(late)}`);
});
