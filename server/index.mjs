import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, DownloadManager } from './download-manager.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.ts': 'video/mp2t', '.ico': 'image/x-icon', '.png': 'image/png' };

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError('请求需要使用 application/json。', 415);
  let value = '';
  for await (const chunk of request) { value += chunk; if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new ApiError('导入内容过大，请分批导入。', 413); }
  if (!value) return {};
  try { return JSON.parse(value); } catch { throw new ApiError('JSON 内容无效。'); }
}

function runNative(command, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new ApiError('文件夹选择已超时，请重试。', 408)); }, timeout);
    timer.unref();
    child.stdout.on('data', data => { output += data; });
    child.once('error', () => { clearTimeout(timer); reject(new ApiError('无法打开系统文件管理器，请直接输入保存路径。', 500)); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new ApiError('已取消选择文件夹。', 400)); });
  });
}

async function sendFile(request, response, filename, downloadName) {
  const stat = await fs.stat(filename).catch(() => { throw new ApiError('文件不存在或已被移动。', 404); });
  if (!stat.isFile()) throw new ApiError('找不到文件。', 404);
  const headers = { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="video.${path.extname(filename).slice(1)}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  else headers['Cache-Control'] = 'no-cache';
  let range;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!match) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
    const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
    if (start > end || start >= stat.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    range = { start, end };
  }
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(filename, range);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

export async function createApp(options = {}) {
  const root = options.root || PROJECT_ROOT;
  const publicDir = options.publicDir || path.join(root, 'public');
  const manager = await new DownloadManager({ ...options, root }).init();
  const server = http.createServer(async (request, response) => {
    try {
      const address = server.address();
      const validHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`]);
      if (!validHosts.has(request.headers.host)) throw new ApiError('仅支持从本机地址访问此服务。', 403);
      if (request.headers.origin && ![...validHosts].some(host => request.headers.origin === `http://${host}`)) throw new ApiError('不接受其他网站发起的本机请求。', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('不接受跨站请求。', 403);
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = request.method;
      if (pathname === '/api/state' && method === 'GET') return json(response, 200, manager.snapshot(existsSync(path.join(publicDir, 'vendor/hls.js'))));
      if (pathname === '/api/settings' && method === 'PATCH') return json(response, 200, await manager.updateSettings(await body(request)));
      if (pathname === '/api/tasks' && method === 'POST') { const value = await body(request); return json(response, 201, { tasks: await manager.addTasks(value.items, value.start === true) }); }
      if (pathname === '/api/queue/start' && method === 'POST') { await body(request); await manager.start(); return json(response, 200, { ok: true }); }
      if (pathname === '/api/queue/pause' && method === 'POST') { await body(request); await manager.pause(); return json(response, 200, { ok: true }); }
      if (pathname === '/api/tasks/clear' && method === 'POST') { const value = await body(request); if (value.status !== 'completed') throw new ApiError('仅支持清理已完成的任务记录。'); await manager.clearCompleted(); return json(response, 200, { ok: true }); }
      if (pathname === '/api/tasks/retry-failed' && method === 'POST') { await body(request); await manager.retryFailed(); return json(response, 200, { ok: true }); }
      if (pathname === '/api/folder/pick' && method === 'POST') {
        await body(request);
        let folder;
        if (process.platform === 'darwin') {
          try { folder = await runNative('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择视频保存位置")']); }
          catch (error) { if (error.status === 400) return json(response, 200, { cancelled: true }); throw error; }
        }
        else throw new ApiError('当前系统请直接输入保存目录的绝对路径。', 501);
        return json(response, 200, { path: folder.replace(/\/$/, '') || '/' });
      }
      if (pathname === '/api/folder/open' && method === 'POST') {
        const value = await body(request);
        const task = value.taskId ? manager.task(value.taskId) : null;
        const target = task?.status === 'completed' ? task.outputPath : task?.outputDir || manager.settings.outputDir;
        await fs.access(target).catch(() => { throw new ApiError('保存目录或文件不存在。', 404); });
        if (process.platform === 'darwin') await runNative('open', task?.status === 'completed' ? ['-R', target] : [target], 10000);
        else if (process.platform === 'linux') await runNative('xdg-open', [task?.outputDir || target], 10000);
        else if (process.platform === 'win32') await runNative('explorer.exe', [target], 10000);
        else throw new ApiError('当前系统不支持打开文件夹。', 501);
        return json(response, 200, { ok: true });
      }
      const match = /^\/api\/tasks\/([\w-]+)(?:\/(pause|resume|retry|cancel|file))?$/.exec(pathname);
      if (match) {
        const [, id, action] = match;
        if (action === 'file' && ['GET', 'HEAD'].includes(method)) { const task = manager.task(id); if (task.status !== 'completed') throw new ApiError('视频尚未下载完成。', 409); return await sendFile(request, response, task.outputPath, task.filename); }
        if (action && method === 'POST') { await body(request); return json(response, 200, await manager.action(id, action)); }
        if (!action && method === 'PATCH') return json(response, 200, await manager.editTask(id, await body(request)));
        if (!action && method === 'DELETE') { await body(request); await manager.remove(id); return json(response, 200, { ok: true }); }
      }
      if (pathname.startsWith('/api/')) throw new ApiError('接口不存在。', 404);
      if (!['GET', 'HEAD'].includes(method)) throw new ApiError('请求方法不支持。', 405);
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = path.resolve(publicDir, relative);
      if (!file.startsWith(`${publicDir}${path.sep}`)) throw new ApiError('文件路径无效。', 403);
      return await sendFile(request, response, file);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error.status || (error instanceof URIError ? 400 : 500);
      json(response, status, { error: error.status ? error.message : error.code === 'EACCES' ? '保存目录没有写入权限。' : '服务暂时无法处理请求，请检查本地目录和服务状态。' });
    }
  });
  server.requestTimeout = 150000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.PORT || 4173), '127.0.0.1', resolve); });
  const close = async () => { await manager.close(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); };
  return { server, manager, close, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  console.log(`StreamSave 已启动：${app.url}`);
  console.log(`FFmpeg ${app.manager.ffmpegAvailable ? '已就绪' : '未找到，请先安装'} · 保存位置 ${app.manager.settings.outputDir}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
}
