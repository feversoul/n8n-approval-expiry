# n8n approval expiry

[![test](https://github.com/feversoul/n8n-approval-expiry/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-approval-expiry/actions/workflows/test.yml)

Human approval in n8n, and the question that comes after the timeout branch: what happens to the approver who clicks late? This repository has two parts. A lab that measures what n8n's own nodes do with a late, repeated or simultaneous click (Wait on webhook, Wait on form, and Send and Wait for Response). And a set of workflows where the late answer is handled on purpose: the request is a row, it is decided once, it expires by a scheduled sweep, and every late or repeated click gets a page that says what happened.

Built-in nodes and **Data Tables** only: no external database, no community nodes.

Everything was run on n8n 2.47.7, on SQLite and on PostgreSQL. Slack was not used: the send-and-wait measurements were made with the Email node against a local mail sink.

| Asked in the thread                                                 | What you get                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How do you handle a late approval after expiry?                     | Measured first: a late form submit is answered "Your response has been recorded" and dropped. In the workflows here the late click gets `410` "This request expired at ..." and a row in the log with the approver's name.                                                                                           |
| Both routes need an explicit timeout branch                         | True, and with a limit under about a minute the branch does not run at the limit: n8n checks waiting executions once a minute. A 3 to 5 second limit was acted on 54 to 58 seconds later, and until then a click still approved. A 75 second limit ran on time. Here the deadline is checked by the decision itself. |
| A status row, set to expired by the timeout branch                  | `approval_requests`, one row per request: `pending`, then `approved`, `rejected` or `expired`, set by one conditional update.                                                                                                                                                                                        |
| The link should point at a page with the row id, not the resume URL | Each approver gets `approval/open?id=...&t=...` with their own token. It keeps answering for as long as the row exists.                                                                                                                                                                                              |
| Test an approval arriving after `expiresAt` while timeout is late   | Tested: 8 clicks 100 to 800 ms past the deadline, most before the sweep had run, all refused. And 14 clicks around the deadline with the sweep fired in the same instant.                                                                                                                                            |

## What n8n's own nodes did

Lab workflows in `lab/`, each with a time limit on the wait. "Timeout branch ran" means the execution continued past the node without an answer.

| Case                                                      | Wait, On Webhook Call                                                                        | Wait, On Form Submitted                                                                           | Email, Send and Wait (approve / disapprove) |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Time limit of 3 to 5 s: timeout branch ran after          | 55 to 58 s                                                                                   | 54 to 57 s                                                                                        | 54 to 57 s                                  |
| Click 5 s after the limit, timeout branch not run yet     | `200`, approved                                                                              | `200`, approved                                                                                   | `200` "Got it, thanks", approved            |
| Click after the timeout branch ran                        | `409` "The execution ... has finished already."                                              | `200` "Form Submitted. Your response has been recorded", on open and on submit. Nothing happened. | `200` "No action required"                  |
| Same link again, right behind the first click             | `409` "... is running already."                                                              | no answer within 10 s                                                                             | `409` "... is running already."             |
| Same link again, 2 s later                                | `409` "... has finished already."                                                            | `200` "Form Submitted. Your response has been recorded"                                           | `200` "No action required"                  |
| Approve, reject and approve at the same instant, 4 rounds | resumed once per round; the other two got `500` "There was a problem executing the workflow" | same                                                                                              | same                                        |
| The link fetched with a bot user agent                    | `200`, approved                                                                              | not run                                                                                           | `200`, empty page, nothing happened         |
| Click after n8n was stopped for 15 s and started again    | `200`, approved                                                                              | `200`, approved                                                                                   | `200`, approved                             |

Only run on the webhook Wait:

| Case                                                                                   | Result                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old link clicked after the timeout branch ran, execution now in a second approval Wait | `200`, and the second Wait continued as approved                                                                                                         |
| Link clicked again while the execution sits in a timed Wait                            | `404` "... does not contain a waiting webhook with a matching path/method."                                                                              |
| Link without its `signature` parameter                                                 | `401` "Invalid token"                                                                                                                                    |
| 75 s limit, 10 runs, clicked from 50 ms before to 2 s after the limit                  | 2 approved, 8 timed out (both databases). Every run took one branch, and the click got `200` exactly when it counted. Refused clicks got `500` or `409`. |
| 10 s limit that passed while n8n was down                                              | timeout branch ran 14 to 15 s after n8n was started again                                                                                                |

What this means in practice:

- **The time limit is not a deadline for the click.** A limit shorter than about a minute was acted on at n8n's next check of waiting executions, which runs once a minute: 54 to 58 s in the test runs, 23 to 44 s in runs by hand (a 75 second limit was acted on within about a second). Until the timeout branch has actually run, the link still approves.
- **A late form submit looks like a success.** After the timeout branch ran, opening or submitting the old Wait form link returns `200` and "Form Submitted. Your response has been recorded". Nothing was recorded.
- **A late webhook click gets a JSON error**, a late send-and-wait click gets "No action required". Neither says that the request expired or who decided it.
- **The resume link belongs to the execution, not to the request.** If the execution has moved on to another approval Wait, the first link approves that later one.
- **The same link twice, or approve and reject at once:** the execution resumed exactly once in every round. The other clicks got `409`, `500`, or (second form submit) no answer at all.
- **A Wait link is a plain GET.** A request with a bot user agent approved it. Send and Wait ignores user agents that look like bots, so a scanner does not approve there.
- **A restart does not lose the wait.** Links worked after n8n came back.

## The pattern

Four workflows and two data tables.

```
                 button pressed, row is pending, deadline not passed
              ┌──────────────────────────────────────────────▶ approved ──▶ action, once
   pending ───┤                                               ▶ rejected
              └── sweep: still pending, deadline passed ─────▶ expired  ──▶ timeout branch, once

   any click on a row that is not pending, or past its deadline:
   409 "already approved by Ana at ..."   or   410 "This request expired at ..."   + a row in approval_events
```

- **0 Setup** creates the tables. Run it once.
- **1 Request** takes `{ title, details, approvers, ttl_seconds, payload }` from an Execute Sub-workflow node or a webhook. It writes the row as `pending` with `expires_at`, sends each approver their own link, and ends. Nothing waits in a Wait node.
- **2 Decide** is what the link reaches.
  - `GET approval/open` shows a page. Still open: title, details, two buttons. Not open: what happened, and the visit is logged. Opening decides nothing, so a mail scanner or a link preview cannot approve.
  - `POST approval/decide` is the button. One update with the filter `request_id` matches, `status = pending`, `expires_at > now`. The click whose id is in the row afterwards decided it. Every other click reads the row and is told.
  - Only the click that won an approve reaches **Do the approved thing**, with the request id as `Idempotency-Key`.
- **3 Sweep** runs every minute: one update sets rows that are `pending` and past `expires_at` to `expired`, logs it and runs the timeout branch once per request.

The deadline is enforced twice on purpose. The decision checks `expires_at` itself, so a late click is refused even when the sweep has not run. The sweep makes the row say `expired` and tells the requester.

`approval_events` holds `approved`, `rejected`, `expired`, `late_click`, `repeat_click`, `action_done`, `action_failed`, each with time, approver and detail.

## Add it to your n8n

Data Tables are available on n8n Cloud. I did not test on Cloud itself. There, **3 Sweep** is one execution a minute once it is published, about 43,200 a month, which is more than the Starter plan (2,500 a month) or the Pro plan (10,000) includes (Cloud plan page, 2026-11-14). Open **Every minute** and set a longer interval: a late click is still refused at the deadline, only the row turns `expired` and the requester hears about it that much later.

1. Create a **Header Auth** credential named `Approval Key` (header `X-Workflow-Key`, any long random value). The request, list, setup and sweep webhooks use it. The two approver webhooks (`open`, `decide`) are public and check the token in the link.
2. Import the four files in `workflows/` (Workflows > Import from File) and pick the credential on the protected webhook nodes. You do not need `lab/`.
3. Open **Approval · 0 Setup** and press **Execute workflow** once.
4. In **1 Request**, replace **Send the request** with your Slack, mail or Teams node. It receives one item per approver with `to`, `title`, `details`, `link` and `expires_at`. Send the link as a plain link or a link button. If n8n is not reachable under its own `WEBHOOK_URL`, set `PUBLIC_URL` in **One message per approver**.
5. In **2 Decide**, replace **Do the approved thing** with your action, and adapt **Judge the action** if success is not a 2xx. Replace **Tell the requester** (two nodes) or delete them.
6. In **3 Sweep**, replace **Timeout branch** with what should happen when nobody answered.
7. Publish 1, 2 and 3. Open a request from your own workflow with an **Execute Sub-workflow** node on **1 Request**, or `POST /webhook/approval/request`.

`GET /webhook/approval/requests?status=pending` lists rows, `?request_id=...` shows one, `GET /webhook/approval/events?request_id=...` its log.

If a late approval should still go through, do not reopen the old row. Open a new request: it gets a new id and new links, and the old links keep saying "expired".

## What was tested

`npm run test:e2e` and `npm run test:e2e:postgres`, each from a fresh stack, n8n 2.47.7. The sweep ran every 2 seconds. "Action ran" is the stand-in's own count of requests it received for that request id.

| Case                                                                                                   | Result                                                                                                                                                                       | Guarded action ran             |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Approve. The link was opened three times first, once with a bot user agent                             | opening changed nothing; button: `200` "Approved. Your decision was recorded at ..."                                                                                         | 1                              |
| Reject                                                                                                 | `200` "Rejected. ... Nothing will be done."                                                                                                                                  | 0                              |
| Timeout (2 s), nobody answers                                                                          | row `expired` by the sweep, requester told once, also after more sweeps                                                                                                      | 0                              |
| Late click after expiry, on the link and on the button                                                 | `410` "This request expired at <deadline>. Nothing was done. ..."; `late_click` logged with the approver's name                                                              | 0                              |
| Button pressed 100 to 800 ms after the deadline, 8 requests                                            | 8 of 8 got `410`. 6 (SQLite) and 4 (PostgreSQL) of them arrived before the sweep had run.                                                                                    | 0                              |
| Double click: 5 presses at once, 6 rounds                                                              | per round one `200` and four `409` "already approved by Ana at ..."; 4 `repeat_click` rows                                                                                   | 1 per round                    |
| Two approvers at once, Ana approves and Ben rejects, 12 rounds                                         | one decision per round (Ana won 8 to 12 of the 12, depending on the run); the other was told who decided and when                                                            | 1 when Ana won, 0 when Ben won |
| Approve from 200 ms before to 600 ms after the deadline, sweep called in the same instant, 14 requests | SQLite: 1 approved, 13 expired. PostgreSQL: 2 approved, 12 expired. Page said `200` exactly for the approved ones. No request got both the action and the "expired" message. | 1 for approved, 0 for expired  |
| n8n stopped for 15 s with a request open                                                               | approve after the restart: `200`; the second approver then got `409`                                                                                                         | 1                              |
| n8n stopped for 15 s, the deadline passed meanwhile                                                    | `expired` by the first sweep after the start, requester told once, late click `410`                                                                                          | 0                              |
| Wrong token in the link                                                                                | `404` "This link is not valid", on the link and on the button                                                                                                                | 0                              |

| Run                           | Result          |
| ----------------------------- | --------------- |
| n8n with SQLite (its default) | 14 of 14 passed |
| n8n with PostgreSQL           | 14 of 14 passed |

Six of the 14 tests are the lab measurements above; they assert what n8n 2.47.7 did, so they fail if a later version behaves differently.

## What was not tested, and other limits

- **Slack.** The Slack node's Send and Wait for Response was not run. Reading n8n's source, Slack's plain link buttons use the same shared send-and-wait code as the Email node (link, signature, wait), so the email results are a reasonable guess for them, not a measurement. With **Capture Who Responded** Slack goes through its interactive buttons, a different path that was not touched.
- n8n Cloud, queue mode, versions other than 2.47.7.
- **Two requests for the same action.** The `Idempotency-Key` of **Do the approved thing** is the request id. If a reminder or a replacement goes out as a new request, both can be approved and the action runs twice. To prevent that, key the action on what it does (its target plus a hash of the payload) with a unique constraint, as discussed at the end of the forum thread.
- **A real browser.** Pages were fetched with a browser user agent and the form was posted as a browser would. n8n serves webhook HTML with a sandbox header; it contains `allow-forms` (asserted), but nobody clicked the button in a real browser.
- **n8n dying between the decision and the action.** The row then stays `approved` with `action_status = running`, and nothing runs the action again. Look for such rows by hand. The action carries the request id as `Idempotency-Key` for the case you add a retry.
- **A failing action.** `action_failed` is written by the same nodes as `action_done`, but the stand-in never fails, so that path did not run.
- The deadline is compared with the clock of the n8n process, not the database clock. The Data Table node cannot use database time in a filter.
- The link token is the only thing that identifies an approver. Whoever has Ana's link is Ana. Tokens are 128 random bits from n8n's Crypto node.
- The public webhooks have no rate limit. An unknown id or token gets `404` and is not logged.
- Data Table updates return rows differently per database (PostgreSQL: the rows it changed; SQLite: rows read before the update). The workflows therefore decide "did this click win" by the click id stored in the row, never by whether a row came back.
- Rows are never deleted.

## Run the tests yourself

```sh
git clone https://github.com/feversoul/n8n-approval-expiry
cd n8n-approval-expiry
npm run test:e2e            # n8n on SQLite
npm run test:e2e:postgres   # n8n on PostgreSQL
```

Needs Docker and Node 20 or newer. A run takes about five minutes, most of it waiting for n8n's time limits. `KEEP_STACK=1` leaves the stack up: the editor is on http://localhost:55687, the stand-in on http://localhost:58089 (`/sink/notify`, `/sink/action`, `/sink/lab`, `/mail`).

To look around by hand: `cp .env.example .env`, fill it in, `docker compose up -d`. Then:

```sh
curl -s -X POST localhost:5678/webhook/approval/request -H "X-Workflow-Key: $WORKFLOW_KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Pay invoice 42","details":"EUR 1,200 to Acme","approvers":["Ana","Ben"],"ttl_seconds":120}'
curl -s localhost:8080/sink/notify   # the two links
```

The Code nodes live in `scripts/code/*.js`. After changing them or `scripts/build.mjs`, run `npm run build` to write `workflows/*.json` and `lab/*.json` again.

## License

MIT.
