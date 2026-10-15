const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { encode, FrameReader, ipcPaths, DiscordRpc } = require('../discord');

test('encode writes op and length as little-endian int32 before the JSON', () => {
  const buf = encode(1, { a: 'é' });
  assert.equal(buf.readInt32LE(0), 1);
  const body = Buffer.from(JSON.stringify({ a: 'é' }));
  assert.equal(buf.readInt32LE(4), body.length);
  assert.deepEqual(buf.subarray(8), body);
});

test('FrameReader joins split chunks and splits joined ones', () => {
  const got = [];
  const r = new FrameReader((op, data) => got.push([op, data]));
  const both = Buffer.concat([encode(1, { n: 1 }), encode(3, { n: 2 })]);
  r.push(both.subarray(0, 5));
  r.push(both.subarray(5, 20));
  r.push(both.subarray(20));
  assert.deepEqual(got, [[1, { n: 1 }], [3, { n: 2 }]]);
});

test('ipcPaths: Windows named pipes, else the runtime folder', () => {
  assert.equal(ipcPaths('win32', {})[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(ipcPaths('win32', {}).length, 10);
  assert.equal(ipcPaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000' })[0], '/run/user/1000/discord-ipc-0');
});

// A fake Discord client: answers the handshake with READY and records every command.
function fakeDiscord(pipe) {
  const seen = [];
  const server = net.createServer(sock => {
    const reader = new FrameReader((op, data) => {
      seen.push({ op, data });
      if (op === 0) sock.write(encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'tester' } } }));
      else if (op === 1) sock.write(encode(1, { cmd: data.cmd, nonce: data.nonce, data: {} }));
    });
    sock.on('data', c => reader.push(c));
  });
  return new Promise(res => server.listen(pipe, () => res({ server, seen })));
}
const pipeName = () => (process.platform === 'win32'
  ? `\\\\?\\pipe\\breeze-test-${process.pid}-${Date.now()}`
  : path.join(os.tmpdir(), `breeze-test-${process.pid}-${Date.now()}.sock`));

test('DiscordRpc handshakes with the client id, sets and clears the activity', async () => {
  const pipe = pipeName();
  const { server, seen } = await fakeDiscord(pipe);
  const rpc = new DiscordRpc('123456789', { paths: [pipe], pid: 42 });
  const user = await rpc.connect();
  assert.equal(user.username, 'tester');
  await rpc.setActivity({ details: 'Editing app.js', state: 'my-project', startTimestamp: 1000 });
  await rpc.setActivity(null);
  rpc.close();
  server.close();
  assert.deepEqual(seen[0], { op: 0, data: { v: 1, client_id: '123456789' } });
  assert.equal(seen[1].data.cmd, 'SET_ACTIVITY');
  assert.equal(seen[1].data.args.pid, 42);
  assert.equal(seen[1].data.args.activity.details, 'Editing app.js');
  assert.deepEqual(seen[1].data.args.activity.timestamps, { start: 1000 });
  assert.equal(seen[2].data.args.activity, undefined);
});

test('DiscordRpc explains when Discord is not running', async () => {
  const rpc = new DiscordRpc('1', { paths: [pipeName()] });
  await assert.rejects(rpc.connect(), /Discord isn't running/);
});
