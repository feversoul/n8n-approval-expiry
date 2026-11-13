// Stand-in for the outside world in the local stack and the tests. It only
// records what it receives, so a test can ask "what was really sent?".
//
//   POST /sink/<name>            store the JSON body under <name>
//   GET  /sink/<name>?key=value  what was stored, filtered by top-level fields
//   GET  /mail?to=<address>      mails received over SMTP (port 2525), with the links in them
//
// The workflows use three sinks: "notify" (messages to approvers and to the
// requester), "action" (the guarded action) and "lab" (reports from the
// measurement workflows in lab/).

import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

const sinks = new Map();
const mails = [];

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

createServer((request, response) => {
  const url = new URL(request.url, 'http://standin');
  const [, area, name] = url.pathname.split('/');
  if (area === 'sink' && name && request.method === 'POST') {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(text || '{}');
      } catch {
        body = { raw: text };
      }
      const list = sinks.get(name) ?? [];
      sinks.set(name, list);
      list.push({ ...body, received_at: new Date().toISOString(), received_ms: Date.now(), idempotency_key: request.headers['idempotency-key'] });
      json(response, 200, { ok: true });
    });
    return;
  }
  if (area === 'sink' && name && request.method === 'GET') {
    const wanted = [...url.searchParams];
    const items = (sinks.get(name) ?? []).filter((item) => wanted.every(([key, value]) => String(item[key]) === value));
    return json(response, 200, { items });
  }
  if (area === 'mail' && request.method === 'GET') {
    const to = url.searchParams.get('to');
    return json(response, 200, { mails: mails.filter((mail) => !to || mail.to.some((address) => address.includes(to))) });
  }
  if (area === 'health') return json(response, 200, { ok: true });
  json(response, 404, { error: 'not found' });
}).listen(8080);

// A mail sink: just enough SMTP for n8n's Email node to deliver one message.
const decodeQuotedPrintable = (text) => text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const decodeBody = (raw) => {
  const base64 = /content-transfer-encoding:\s*base64/i.test(raw);
  const body = raw.slice(raw.search(/\r?\n\r?\n/));
  return base64 ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : decodeQuotedPrintable(body);
};

createTcpServer((socket) => {
  let buffer = '';
  let inData = false;
  let mail = { to: [] };
  socket.setEncoding('utf8');
  socket.write('220 standin ESMTP\r\n');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        const html = decodeBody(raw);
        mails.push({
          to: mail.to,
          subject: /^subject:\s*(.*)$/im.exec(raw)?.[1] ?? '',
          links: [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1].replaceAll('&amp;', '&')),
          received_at: new Date().toISOString(),
        });
        mail = { to: [] };
        socket.write('250 stored\r\n');
        continue;
      }
      const lineEnd = buffer.indexOf('\r\n');
      if (lineEnd === -1) return;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      const command = line.slice(0, 4).toUpperCase();
      if (command === 'EHLO' || command === 'HELO') socket.write('250 standin\r\n');
      else if (command === 'MAIL') socket.write('250 ok\r\n');
      else if (command === 'RCPT') {
        mail.to.push(/<([^>]*)>/.exec(line)?.[1] ?? line);
        socket.write('250 ok\r\n');
      } else if (command === 'DATA') {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (command === 'QUIT') {
        socket.write('221 bye\r\n');
        socket.end();
      } else socket.write('250 ok\r\n');
    }
  });
}).listen(2525);

console.log('stand-in: http on 8080, smtp on 2525');
