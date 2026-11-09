// A stand-in T3 Code server on localhost: hands out websocket tickets, accepts the
// websocket (and ignores what's sent on it) and answers who it is.

import http from 'node:http';
import { createHash } from 'node:crypto';

export async function fakeT3({ environmentId = 'env-fake', port = 0 } = {}) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/auth/websocket-ticket/rpc') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ticket: 'ticket' }));
    }
    if (req.url === '/.well-known/t3/environment') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ environmentId, label: environmentId, orchestrationProtocolVersion: 2 }));
    }
    res.statusCode = 404;
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// A localhost port nothing listens on.
export async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Resolves once `client` is in the wanted state, or a state its error satisfies.
export function waitForState(client, wanted, timeoutMs = 10000) {
  const done = () => (typeof wanted === 'function' ? wanted(client.state, client.error) : client.state === wanted);
  if (done()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still ${client.state} (${client.error}) after ${timeoutMs} ms`)), timeoutMs);
    const on = () => {
      if (!done()) return;
      clearTimeout(timer);
      client.off('state', on);
      resolve();
    };
    client.on('state', on);
  });
}
