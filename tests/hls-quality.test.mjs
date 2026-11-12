import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { DownloadManager } from '../server/download-manager.mjs';
import { parseAttributeList, parseMasterPlaylist, chooseBestVariant, chooseAudioRendition } from '../server/hls-playlist.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(25); }
  throw new Error('Timed out waiting for selected HLS download');
}

const master = `#EXTM3U
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=99000000,RESOLUTION=4096x2160,URI="iframe.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=64x112,CODECS="avc1.42e01e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=128x224,CODECS="avc1.42e01e,mp4a.40.2"
wrong/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1500000,RESOLUTION=128x224,FRAME-RATE=10,CODECS="avc1.42e01e,mp4a.40.2"
high/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=99999999,CODECS="mp4a.40.2"
audio/index.m3u8
`;

test('HLS attributes preserve quoted commas and resolution beats lower-resolution bandwidth', () => {
  const attributes = parseAttributeList('BANDWIDTH=2128000,RESOLUTION=1080x1920,CODECS="avc1.64001f,mp4a.40.2",AUDIO="main,audio"');
  assert.equal(attributes.CODECS, 'avc1.64001f,mp4a.40.2');
  assert.equal(attributes.AUDIO, 'main,audio');
  const parsed = parseMasterPlaylist(master.replaceAll('\n', '\r\n'), 'https://media.example/path/master.m3u8');
  assert.equal(parsed.variants.length, 4);
  const best = chooseBestVariant(parsed.variants);
  assert.equal(best.url, 'https://media.example/path/high/index.m3u8');
  assert.equal(best.width, 128); assert.equal(best.height, 224); assert.equal(best.bandwidth, 2000000);
  assert.equal(best.averageBandwidth, 1500000);
});

test('HLS unknown dimensions fall back to bandwidth and audio selection honors declared default', () => {
  const parsed = parseMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=700000\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nb.m3u8', 'https://media.example/master');
  assert.match(chooseBestVariant(parsed.variants).url, /b\.m3u8$/);
  const groups = parseMasterPlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main,audio",NAME="Other",AUTOSELECT=YES,URI="other.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main,audio",NAME="Original",DEFAULT=YES,URI="audio/original.m3u8"', 'https://media.example/path/master');
  assert.equal(chooseAudioRendition(groups.audioRenditions, 'main,audio').url, 'https://media.example/path/audio/original.m3u8');
  assert.equal(chooseAudioRendition([{ groupId: 'muxed', isDefault: true, url: null }], 'muxed').url, null);
});

test('real downloads select the largest variant, preserve muxed audio and merge a separate default audio group', { timeout: 60000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'streamsave-quality-'));
  const source = path.join(temp, 'source');
  await fs.mkdir(source);
  const encode = async (name, dimensions, audioOnly = false, videoOnly = false) => {
    const directory = path.join(source, name); await fs.mkdir(directory);
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (!audioOnly) args.push('-f', 'lavfi', '-i', `testsrc=size=${dimensions}:rate=10`);
    if (!videoOnly) args.push('-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=44100');
    args.push('-t', '3');
    if (!audioOnly) args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '10', '-sc_threshold', '0');
    if (!videoOnly) args.push('-c:a', 'aac');
    args.push('-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', path.join(directory, 'index.m3u8'));
    execFileSync('ffmpeg', args, { stdio: 'pipe' });
  };
  await encode('low', '64x112'); await encode('high', '128x224');
  await encode('video', '128x224', false, true); await encode('audio', '', true, false);
  const requests = [];
  const external = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main,audio",NAME="Broken alternative",AUTOSELECT=YES,URI="not-selected/audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main,audio",NAME="Original",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=128x224,CODECS="avc1.42e01e,mp4a.40.2",AUDIO="main,audio"
video/index.m3u8
`;
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://local').pathname;
    requests.push(pathname);
    if (pathname === '/redirect') { response.writeHead(302, { Location: '/media/master' }); response.end(); return; }
    if (pathname === '/media/master') { response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); response.end(master); return; }
    if (pathname === '/media/external') { response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); response.end(external); return; }
    if (pathname === '/media/nested') { response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=128x224\nmaster\n'); return; }
    const relative = pathname.replace(/^\/media\//, '');
    const filename = path.join(source, relative);
    if (!filename.startsWith(source + path.sep)) { response.writeHead(403); response.end(); return; }
    try { const content = await fs.readFile(filename); response.writeHead(200, { 'Content-Type': filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'Content-Length': content.length }); response.end(content); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const manager = await new DownloadManager({ root: temp, dataDir: path.join(temp, 'data'), outputDir: path.join(temp, 'output') }).init();
  t.after(async () => { await manager.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await fs.rm(temp, { recursive: true, force: true }); });
  const download = async (endpoint, name) => {
    const [added] = await manager.addTasks([{ url: `${url}${endpoint}`, name }], true);
    const task = await until(() => { const task = manager.task(added.id); if (task.status === 'failed') throw new Error(`${task.error}\n${manager.diagnostics.get(task.id)}`); return task.status === 'completed' && task; });
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', task.outputPath], { encoding: 'utf8' }));
    assert.equal(probe.streams.find(stream => stream.codec_type === 'video').width, 128);
    assert.equal(probe.streams.find(stream => stream.codec_type === 'video').height, 224);
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    assert.ok(Number(probe.format.duration) >= 2.9);
    assert.equal(task.selectedQuality.width, 128); assert.equal(task.selectedQuality.height, 224);
    assert.equal(task.selectedQuality.bandwidth, 2000000);
    return task;
  };
  const muxed = await download('/redirect', '最大画质');
  assert.ok(muxed.availableQualities.length >= 3);
  assert.equal(requests.some(pathname => pathname.includes('/low/') || pathname.includes('/wrong/')), false, 'unselected variants must never be probed or downloaded');
  const separate = await download('/media/external', '独立音轨');
  assert.ok(separate.downloadedBytes > 0);
  assert.equal(requests.some(pathname => pathname.includes('/not-selected/')), false, 'nondefault external audio must not be fetched');
  await download('/media/nested', '嵌套主清单');
});
