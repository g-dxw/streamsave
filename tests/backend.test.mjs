import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/index.mjs';
import { sanitizeName, validateSettings, validateUrl } from '../server/download-manager.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(40); }
  throw new Error('Timed out waiting for download state');
}

test('validates URLs, names, settings and injected headers', () => {
  assert.equal(validateUrl(' https://example.com/video.m3u8?a=1 '), 'https://example.com/video.m3u8?a=1');
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@example.com/x', 'broken']) assert.throws(() => validateUrl(value));
  assert.equal(sanitizeName('../危险/文件:*?'), '__危险_文件___');
  const current = { concurrency: 3, headers: { referer: '', userAgent: '' } };
  for (const patch of [{ concurrency: 9 }, { concurrency: 1.1 }, { padWidth: 0 }, { format: 'exe' }, { outputDir: '../relative' }, { namingPattern: '../{name}' }, { headers: { userAgent: 'ok\r\nInjected: yes' } }]) assert.throws(() => validateSettings(patch, current));
  assert.equal(validateSettings({ concurrency: 8, padWidth: 6 }, current).concurrency, 8);
});

test('local API and real FFmpeg HLS downloads', { timeout: 90000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'streamsave-backend-'));
  const sourceDir = path.join(temp, 'source');
  const outputDir = path.join(temp, 'output');
  await fs.mkdir(sourceDir);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=44100', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-sc_threshold', '0', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', path.join(sourceDir, 'index.m3u8')], { stdio: 'pipe' });
  const playlist = await fs.readFile(path.join(sourceDir, 'index.m3u8'), 'utf8');
  const segments = playlist.split('\n').filter(line => line.endsWith('.ts'));
  assert.ok(segments.length >= 3);
  const sourceRequests = new Set();
  const sourceErrors = [];
  const handleSourceRequest = async (request, response) => {
    const pathname = new URL(request.url, 'http://local').pathname;
    const basename = path.basename(pathname);
    if (pathname.startsWith('/protected/') && (request.headers.referer !== 'https://example.com/' || request.headers['user-agent'] !== 'StreamSaveTest')) { response.writeHead(403); response.end(); return; }
    if (basename === 'index.m3u8') { const content = pathname.startsWith('/live/') ? playlist.replace('#EXT-X-ENDLIST', '') : playlist; response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', ...(!pathname.startsWith('/chunked/') ? { 'Content-Length': Buffer.byteLength(content) } : {}) }); response.end(content); return; }
    if (pathname.startsWith('/broken/') && basename === segments[1]) { response.writeHead(404); response.end(); return; }
    if (basename.endsWith('.ts')) {
      if (pathname.startsWith('/slow/')) await wait(250);
      const content = await fs.readFile(path.join(sourceDir, basename));
      response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': content.length });
      response.end(content);
      return;
    }
    response.writeHead(404); response.end();
  };
  const sourceServer = http.createServer((request, response) => {
    const operation = handleSourceRequest(request, response);
    sourceRequests.add(operation);
    void operation.then(() => sourceRequests.delete(operation), error => {
      sourceRequests.delete(operation);
      sourceErrors.push(error);
      // Retain fixture failures for the test assertion; HTTP listeners do not
      // consume rejected async callbacks on their own.
      response.destroy();
    });
  });
  await new Promise(resolve => sourceServer.listen(0, '127.0.0.1', resolve));
  const sourceUrl = `http://127.0.0.1:${sourceServer.address().port}`;
  let app = await createApp({ port: 0, dataDir: path.join(temp, 'data'), outputDir, publicDir: sourceDir });
  const api = async (route, method = 'GET', value) => {
    const response = await fetch(`${app.url}${route}`, { method, headers: value === undefined ? {} : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(result)}`);
    return result;
  };
  t.after(async () => {
    await app.close();
    await new Promise(resolve => { sourceServer.close(resolve); sourceServer.closeAllConnections(); });
    // Closing sockets does not cancel delayed request handlers. Drain them
    // before removing files that a cancelled FFmpeg request may still read.
    await Promise.allSettled([...sourceRequests]);
    await fs.rm(temp, { recursive: true, force: true });
    assert.equal(sourceErrors.length, 0, sourceErrors.map(error => error.stack || String(error)).join('\n'));
  });

  await t.test('rejects cross-origin mutations and malformed batches', async () => {
    const response = await fetch(`${app.url}/api/queue/start`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
    const invalid = await fetch(`${app.url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ url: 'file:///tmp/private' }] }) });
    assert.equal(invalid.status, 400);
    assert.equal((await api('/api/state')).tasks.length, 0);
    assert.equal((await fetch(`${app.url}/missing.css`)).status, 404);
  });

  let completed;
  await t.test('downloads HLS, preserves an existing filename and exposes the real file', async () => {
    await api('/api/settings', 'PATCH', { namingPattern: '{number}_{name}', concurrency: 1 });
    const added = await api('/api/tasks', 'POST', { items: [{ url: `${sourceUrl}/vod/index.m3u8`, name: '实际下载' }] });
    const task = added.tasks[0];
    await fs.writeFile(task.outputPath, 'keep existing content');
    await api('/api/queue/start', 'POST', {});
    completed = await until(async () => { const task = (await api('/api/state')).tasks[0]; if (task.status === 'failed') throw new Error(`${task.error}\n${app.manager.diagnostics.get(task.id)}`); return task.status === 'completed' ? task : false; });
    assert.match(completed.filename, /\(1\)\.mp4$/);
    assert.equal(await fs.readFile(task.outputPath, 'utf8'), 'keep existing content');
    assert.ok(completed.downloadedBytes > 10000);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', completed.outputPath], { encoding: 'utf8' }));
    assert.ok(Number(probe.format.duration) >= 5.9);
    assert.ok(probe.streams.some(stream => stream.codec_name === 'h264'));
    const file = await fetch(`${app.url}/api/tasks/${completed.id}/file`, { headers: { Range: 'bytes=0-31' } });
    assert.equal(file.status, 206);
    assert.equal((await file.arrayBuffer()).byteLength, 32);
  });

  await t.test('valid chunked HLS manifests download successfully', async () => {
    const added = await api('/api/tasks', 'POST', { items: [{ url: `${sourceUrl}/chunked/index.m3u8`, name: '分块传输清单' }], start: true });
    await until(() => { const task = app.manager.task(added.tasks[0].id); if (task.status === 'failed') throw new Error(`${task.error}\n${app.manager.diagnostics.get(task.id)}`); return task.status === 'completed'; });
    assert.ok((await fs.stat(app.manager.task(added.tasks[0].id).outputPath)).size > 10000);
  });

  await t.test('queued jobs adopt settings, bounded concurrency and pause/resume work', async () => {
    await api('/api/queue/pause', 'POST', {});
    const added = await api('/api/tasks', 'POST', { items: [{ url: `${sourceUrl}/slow/index.m3u8`, name: '队列一' }, { url: `${sourceUrl}/slow/index.m3u8`, name: '队列二' }] });
    await api('/api/settings', 'PATCH', { namingPattern: '{name}_{number}', padWidth: 4, concurrency: 2 });
    assert.match(app.manager.task(added.tasks[0].id).filename, /^队列一_\d{4}\.mp4$/);
    await api('/api/queue/start', 'POST', {});
    await until(() => added.tasks.every(task => app.manager.active.get(task.id)?.child));
    assert.equal((await api('/api/state')).tasks.filter(task => task.status === 'downloading').length, 2);
    await api('/api/settings', 'PATCH', { concurrency: 1 });
    const running = (await api('/api/state')).tasks.filter(task => task.status === 'downloading');
    assert.equal(running.length, 1);
    assert.equal(app.manager.task(added.tasks[1].id).status, 'queued');
    await api('/api/queue/pause', 'POST', {});
    assert.equal(app.manager.task(added.tasks[0].id).status, 'paused');
    assert.equal(app.manager.task(added.tasks[1].id).status, 'paused');
    await wait(350);
    assert.notEqual(app.manager.task(added.tasks[0].id).status, 'completed');
    await api('/api/queue/start', 'POST', {});
    await until(() => added.tasks.every(task => app.manager.task(task.id).status === 'completed'));
  });

  await t.test('missing HLS segments and live playlists fail instead of saving partial success', async () => {
    const added = await api('/api/tasks', 'POST', { items: [{ url: `${sourceUrl}/broken/index.m3u8`, name: '损坏分片' }, { url: `${sourceUrl}/live/index.m3u8`, name: '持续直播' }], start: true });
    await until(() => added.tasks.every(task => app.manager.task(task.id).status === 'failed'));
    for (const entry of added.tasks) {
      const task = app.manager.task(entry.id);
      assert.equal(task.status, 'failed');
      await assert.rejects(fs.access(task.outputPath));
    }
    assert.match(app.manager.task(added.tasks[1].id).error, /直播/);
  });

  await t.test('retry failed leaves unrelated paused downloads paused', async () => {
    await api('/api/queue/pause', 'POST', {});
    const added = await api('/api/tasks', 'POST', { items: [{ url: `${sourceUrl}/slow/index.m3u8`, name: '保持暂停' }] });
    const pausedId = added.tasks[0].id;
    await api(`/api/tasks/${pausedId}/pause`, 'POST', {});
    const failedIds = (await api('/api/state')).tasks.filter(task => task.status === 'failed').map(task => task.id);
    assert.ok(failedIds.length > 0);
    await api('/api/tasks/retry-failed', 'POST', {});
    assert.equal(app.manager.task(pausedId).status, 'paused');
    await until(() => failedIds.every(id => app.manager.task(id).status === 'failed'));
    assert.equal(app.manager.task(pausedId).status, 'paused');
    assert.equal(app.manager.active.has(pausedId), false);
    await api(`/api/tasks/${pausedId}`, 'DELETE', {});
  });

  await t.test('Referer and User Agent reach the source and failed tasks can retry', async () => {
    const added = await api('/api/tasks', 'POST', { items: [{ url: `${sourceUrl}/protected/index.m3u8`, name: '请求头测试' }], start: true });
    await until(() => app.manager.task(added.tasks[0].id).status === 'failed');
    await api('/api/settings', 'PATCH', { headers: { referer: 'https://example.com/', userAgent: 'StreamSaveTest' } });
    await api(`/api/tasks/${added.tasks[0].id}/retry`, 'POST', {});
    await until(() => { const task = app.manager.task(added.tasks[0].id); if (task.status === 'failed') throw new Error(task.error); return task.status === 'completed'; });
    assert.equal('inputHeaders' in (await api('/api/state')).tasks[0], false);
  });

  await t.test('cancel, edit, delete, completed clear and restart persistence work', async () => {
    await api('/api/queue/pause', 'POST', {});
    const added = await api('/api/tasks', 'POST', { items: [{ url: `${sourceUrl}/slow/index.m3u8`, name: '可取消' }, { url: `${sourceUrl}/slow/index.m3u8`, name: '重启恢复' }] });
    const id = added.tasks[0].id;
    await api(`/api/tasks/${id}`, 'PATCH', { name: '已改名', number: 42 });
    assert.equal(app.manager.task(id).number, 42);
    await api(`/api/tasks/${id}/resume`, 'POST', {});
    await until(() => app.manager.active.get(id)?.child);
    await api(`/api/tasks/${id}/cancel`, 'POST', {});
    assert.equal(app.manager.task(id).status, 'cancelled');
    assert.equal(app.manager.active.has(id), false);
    await assert.rejects(fs.access(app.manager.task(id).outputPath));
    await api('/api/queue/pause', 'POST', {});
    await api(`/api/tasks/${id}`, 'DELETE', {});
    assert.throws(() => app.manager.task(id));
    const completedPath = completed.outputPath;
    await api('/api/tasks/clear', 'POST', { status: 'completed' });
    assert.ok((await fs.stat(completedPath)).size > 0);
    await app.close();
    app = await createApp({ port: 0, dataDir: path.join(temp, 'data'), outputDir, publicDir: sourceDir });
    assert.equal(app.manager.task(added.tasks[1].id).status, 'paused');
    assert.equal(app.manager.queueRunning, false);
  });
});
