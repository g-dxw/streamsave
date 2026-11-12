import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const FORMATS = new Set(['mp4', 'mkv', 'ts']);
const DEFAULT_UA = 'Mozilla/5.0 StreamSave/1.0';

export function validateUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new ApiError('请输入有效的视频流地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError('视频地址仅支持 http 和 https。');
  if (url.username || url.password) throw new ApiError('请使用请求头设置认证，不要在地址中包含用户名或密码。');
  if (url.href.length > 16384) throw new ApiError('视频地址过长。');
  return url.href;
}

export function sanitizeName(value) {
  return String(value ?? '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/\.{2,}/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100) || '未命名视频';
}

function integer(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new ApiError(`${label}应为 ${min} 至 ${max} 的整数。`);
  return number;
}

export function validateSettings(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError('设置格式无效。');
  const next = { ...current, headers: { ...current.headers } };
  if ('concurrency' in patch) next.concurrency = integer(patch.concurrency, 1, 8, '并发数');
  if ('startNumber' in patch) next.startNumber = integer(patch.startNumber, 0, 999999999, '起始编号');
  if ('padWidth' in patch) next.padWidth = integer(patch.padWidth, 1, 6, '编号位数');
  if ('outputDir' in patch) {
    if (typeof patch.outputDir !== 'string' || !path.isAbsolute(patch.outputDir) || patch.outputDir.includes('\0')) throw new ApiError('保存目录必须是本机的绝对路径。');
    next.outputDir = path.resolve(patch.outputDir.trim());
  }
  if ('format' in patch) {
    if (!FORMATS.has(patch.format)) throw new ApiError('输出格式仅支持 MP4、MKV 或 TS。');
    next.format = patch.format;
  }
  if ('quality' in patch && patch.quality !== 'best') throw new ApiError('当前支持下载最佳可用画质。');
  if ('namingPattern' in patch) {
    if (typeof patch.namingPattern !== 'string' || patch.namingPattern.length < 1 || patch.namingPattern.length > 160 || /[<>:"/\\|?*\u0000-\u001f]/.test(patch.namingPattern) || /[{}]/.test(patch.namingPattern.replaceAll('{number}', '').replaceAll('{name}', ''))) throw new ApiError('命名模板仅支持 {number} 和 {name}，不能包含路径或特殊字符。');
    next.namingPattern = patch.namingPattern;
  }
  if ('headers' in patch) {
    if (!patch.headers || typeof patch.headers !== 'object' || Array.isArray(patch.headers)) throw new ApiError('请求头格式无效。');
    for (const key of ['referer', 'userAgent']) {
      if (!(key in patch.headers)) continue;
      if (typeof patch.headers[key] !== 'string' || /[\r\n\0]/.test(patch.headers[key]) || patch.headers[key].length > 4096) throw new ApiError('请求头不能包含换行符，且长度不能超过 4096。');
      if (key === 'referer' && patch.headers[key]) validateUrl(patch.headers[key]);
      next.headers[key] = patch.headers[key].trim();
    }
  }
  return next;
}

function canRun(command) {
  return spawnSync(command, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}

function publicTask(task) {
  const { inputHeaders, temporaryPath, ...result } = task;
  return result;
}

export class DownloadManager {
  constructor(options = {}) {
    this.root = options.root || process.cwd();
    this.dataDir = options.dataDir || path.join(this.root, '.data');
    this.ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
    this.ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
    this.settings = { concurrency: 3, outputDir: options.outputDir || path.join(this.root, 'downloads'), namingPattern: '{number}_{name}', startNumber: 1, padWidth: 3, format: 'mp4', quality: 'best', headers: { referer: '', userAgent: '' } };
    this.tasks = [];
    this.queueRunning = false;
    this.active = new Map();
    this.diagnostics = new Map();
    this.persistChain = Promise.resolve();
    this.storageWarning = '';
    this.closing = false;
    this.operationChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.dataDir, 'state.json'), 'utf8'));
      this.settings = validateSettings(saved.settings || {}, this.settings);
      this.tasks = Array.isArray(saved.tasks) ? saved.tasks.filter(task => task && typeof task.id === 'string').map(task => {
        if (['queued', 'downloading', 'paused'].includes(task.status)) return { ...task, status: 'paused', speed: 0, error: task.status === 'downloading' ? '上次服务已退出，继续后将重新下载此任务。' : task.error || '' };
        return task;
      }) : [];
      // Temporary fragments from a previous process cannot be resumed safely.
      await Promise.all(this.tasks.filter(task => task.temporaryPath).map(task => fs.rm(task.temporaryPath, { force: true }).catch(() => {})));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.storageWarning = '历史任务文件无法读取，已保留备份。';
        await fs.rename(path.join(this.dataDir, 'state.json'), path.join(this.dataDir, `state.corrupt.${Date.now()}.json`)).catch(() => {});
      }
    }
    this.ffmpegAvailable = canRun(this.ffmpegPath);
    this.ffprobeAvailable = canRun(this.ffprobePath);
    await this.persist();
    return this;
  }

  snapshot(hlsAvailable = false) {
    const counts = Object.fromEntries(['queued', 'downloading', 'paused', 'completed', 'failed', 'cancelled'].map(status => [status, this.tasks.filter(task => task.status === status).length]));
    return { settings: this.settings, tasks: this.tasks.map(publicTask), queueRunning: this.queueRunning, system: { ffmpegAvailable: this.ffmpegAvailable, ffprobeAvailable: this.ffprobeAvailable, hlsAvailable, platform: process.platform, storageWarning: this.storageWarning }, summary: { ...counts, total: this.tasks.length, downloadedBytes: this.tasks.reduce((sum, task) => sum + (task.downloadedBytes || 0), 0), speed: this.tasks.filter(task => task.status === 'downloading').reduce((sum, task) => sum + (task.speed || 0), 0) } };
  }

  persist() {
    const content = JSON.stringify({ version: 1, settings: this.settings, tasks: this.tasks }, null, 2);
    this.persistChain = this.persistChain.catch(() => {}).then(async () => {
      const temp = path.join(this.dataDir, 'state.tmp.json');
      await fs.writeFile(temp, content, { mode: 0o600 });
      await fs.rename(temp, path.join(this.dataDir, 'state.json'));
    }).catch(error => { this.storageWarning = `任务记录保存失败：${error.code || '未知错误'}`; });
    return this.persistChain;
  }

  async updateSettings(patch) {
    const next = validateSettings(patch, this.settings);
    await fs.mkdir(next.outputDir, { recursive: true });
    await fs.access(next.outputDir, fs.constants.W_OK);
    this.settings = next;
    const running = this.tasks.filter(task => task.status === 'downloading');
    for (const task of running.slice(next.concurrency)) {
      await this.pauseTask(task);
      task.status = 'queued';
    }
    // Unstarted jobs follow current settings; active jobs retain their file handles.
    for (const task of this.tasks) {
      if (this.active.has(task.id) || task.status === 'completed') continue;
      Object.assign(task, { outputDir: next.outputDir, format: next.format, namingPattern: next.namingPattern, padWidth: next.padWidth, inputHeaders: { ...next.headers } });
      Object.assign(task, await this.reserveFilename(this.baseName(task), task.format, task.outputDir, task.id));
    }
    await this.persist();
    this.schedule();
    return this.settings;
  }

  task(id) {
    const task = this.tasks.find(item => item.id === id);
    if (!task) throw new ApiError('找不到该任务。', 404);
    return task;
  }

  async reserveFilename(base, extension, directory, excludedId) {
    const safeBase = sanitizeName(base);
    const occupied = new Set(this.tasks.filter(task => task.id !== excludedId).map(task => task.outputPath));
    for (let index = 0; index < 100000; index++) {
      const filename = `${safeBase}${index ? ` (${index})` : ''}.${extension}`;
      const outputPath = path.join(directory, filename);
      if (occupied.has(outputPath)) continue;
      try { await fs.access(outputPath); } catch (error) { if (error.code === 'ENOENT') return { filename, outputPath }; throw error; }
    }
    throw new ApiError('同名文件过多，请更换命名规则。');
  }

  baseName(task) {
    return task.namingPattern.replaceAll('{number}', String(task.number).padStart(task.padWidth, '0')).replaceAll('{name}', task.name);
  }

  addTasks(items, start = false) {
    const work = this.operationChain.then(() => this._addTasks(items, start));
    this.operationChain = work.catch(() => {});
    return work;
  }

  async _addTasks(items, start) {
    if (!Array.isArray(items) || !items.length || items.length > 500) throw new ApiError('每次请输入 1 至 500 条视频地址。');
    const validated = items.map((item, index) => {
      if (!item || typeof item !== 'object') throw new ApiError(`第 ${index + 1} 条视频格式无效。`);
      return { url: validateUrl(item.url), name: sanitizeName(item.name || `视频 ${index + 1}`) };
    });
    if (this.tasks.length + validated.length > 10000) throw new ApiError('任务记录已达上限，请清理已完成的任务。');
    if (this.settings.startNumber + validated.length > 999999999) throw new ApiError('编号已超出范围，请减小起始编号。');
    await fs.mkdir(this.settings.outputDir, { recursive: true });
    const added = [];
    let number = this.settings.startNumber;
    for (const item of validated) {
      const task = { id: randomUUID(), ...item, number: number++, status: 'queued', progress: 0, downloadedBytes: 0, downloadedSeconds: 0, duration: null, speed: 0, error: '', createdAt: new Date().toISOString(), outputDir: this.settings.outputDir, format: this.settings.format, namingPattern: this.settings.namingPattern, padWidth: this.settings.padWidth, inputHeaders: { ...this.settings.headers } };
      Object.assign(task, await this.reserveFilename(this.baseName(task), task.format, task.outputDir));
      this.tasks.push(task);
      added.push(publicTask(task));
    }
    this.settings.startNumber = number;
    if (start) this.queueRunning = true;
    await this.persist();
    this.schedule();
    return added;
  }

  async editTask(id, patch) {
    const task = this.task(id);
    if (task.status === 'downloading' || task.status === 'completed') throw new ApiError('请先暂停正在下载的任务；已完成的文件不支持改名。', 409);
    if (!patch || typeof patch !== 'object') throw new ApiError('任务内容无效。');
    if ('name' in patch) task.name = sanitizeName(patch.name);
    if ('number' in patch) task.number = integer(patch.number, 0, 999999999, '视频编号');
    Object.assign(task, await this.reserveFilename(this.baseName(task), task.format, task.outputDir, id));
    await this.persist();
    return publicTask(task);
  }

  schedule() {
    if (!this.queueRunning || this.closing || !this.ffmpegAvailable) return;
    let available = this.settings.concurrency - this.tasks.filter(task => task.status === 'downloading').length;
    for (const task of this.tasks) {
      if (available <= 0) break;
      if (task.status !== 'queued') continue;
      const record = this.active.get(task.id);
      task.status = 'downloading';
      task.error = '';
      available--;
      if (record?.child) {
        record.lastBytes = task.downloadedBytes || 0;
        record.lastTime = Date.now();
        try { record.child.kill('SIGCONT'); } catch { /* Close handler reports failure. */ }
      } else if (!record) {
        void this.startTask(task);
      }
    }
  }

  async start() {
    if (!this.ffmpegAvailable) throw new ApiError('未检测到 FFmpeg，请先安装 FFmpeg 后重启服务。', 503);
    this.queueRunning = true;
    this.tasks.filter(task => task.status === 'paused').forEach(task => { task.status = 'queued'; });
    this.schedule();
    await this.persist();
  }

  async pause() {
    this.queueRunning = false;
    for (const task of this.tasks) if (task.status === 'downloading' || task.status === 'queued') await this.pauseTask(task);
    await this.persist();
  }

  async pauseTask(task) {
    if (!['queued', 'downloading'].includes(task.status)) return;
    task.status = 'paused';
    task.speed = 0;
    const record = this.active.get(task.id);
    if (record?.child) record.child.kill('SIGSTOP');
  }

  async action(id, action) {
    const task = this.task(id);
    if (action === 'pause') await this.pauseTask(task);
    else if (action === 'resume' || action === 'retry') {
      if (task.status === 'completed' || task.status === 'downloading') throw new ApiError('该任务当前无需继续。', 409);
      if (!this.ffmpegAvailable) throw new ApiError('未检测到 FFmpeg。', 503);
      if (!this.active.has(id)) { task.progress = 0; task.downloadedBytes = 0; task.downloadedSeconds = 0; }
      task.status = 'queued';
      task.error = '';
      this.queueRunning = true;
    } else if (action === 'cancel') await this.cancelTask(task);
    else throw new ApiError('不支持的任务操作。', 404);
    this.schedule();
    await this.persist();
    return publicTask(task);
  }

  async cancelTask(task) {
    if (task.status === 'completed') return;
    task.status = 'cancelled';
    task.speed = 0;
    const record = this.active.get(task.id);
    if (record) {
      record.cancelled = true;
      record.preflight?.abort();
      if (record.probe) record.probe.kill('SIGKILL');
      if (record.probing) await record.probing;
      if (record.child) {
        record.child.kill('SIGCONT');
        record.child.kill('SIGTERM');
        const timer = setTimeout(() => record.child?.kill('SIGKILL'), 2500);
        timer.unref();
        await record.done;
        clearTimeout(timer);
      }
    }
    if (task.temporaryPath) await fs.rm(task.temporaryPath, { force: true }).catch(() => {});
  }

  async remove(id) {
    const task = this.task(id);
    await this.cancelTask(task);
    this.tasks = this.tasks.filter(item => item.id !== id);
    await this.persist();
    this.schedule();
  }

  async clearCompleted() {
    this.tasks = this.tasks.filter(task => task.status !== 'completed');
    await this.persist();
  }

  async retryFailed() {
    if (!this.ffmpegAvailable) throw new ApiError('未检测到 FFmpeg，请先安装 FFmpeg 后重启服务。', 503);
    for (const task of this.tasks) if (task.status === 'failed') { task.status = 'queued'; task.error = ''; task.progress = 0; task.downloadedBytes = 0; task.downloadedSeconds = 0; }
    this.queueRunning = true;
    this.schedule();
    await this.persist();
  }

  inputArgs(task) {
    const args = ['-protocol_whitelist', 'http,https,tcp,tls,crypto', '-rw_timeout', '15000000', '-user_agent', task.inputHeaders?.userAgent || DEFAULT_UA];
    if (task.inputHeaders?.referer) args.push('-referer', task.inputHeaders.referer);
    return args;
  }

  probeDuration(task, record) {
    if (!this.ffprobeAvailable) return Promise.resolve(null);
    return new Promise(resolve => {
      let output = '';
      const child = spawn(this.ffprobePath, ['-v', 'error', ...this.inputArgs(task), '-show_entries', 'format=duration,format_name', '-of', 'json', task.url], { stdio: ['ignore', 'pipe', 'ignore'] });
      record.probe = child;
      const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
      timer.unref();
      const finish = () => { clearTimeout(timer); record.probe = null; let duration = null; try { const format = JSON.parse(output).format; record.isHls ||= format?.format_name?.includes('hls'); const value = Number(format?.duration); if (Number.isFinite(value) && value > 0) duration = value; } catch { /* Missing duration is supported for direct files. */ } resolve(duration); };
      child.stdout.on('data', data => { if (output.length < 65536) output += data; });
      child.once('error', finish);
      child.once('close', finish);
    });
  }

  async startTask(task) {
    const record = { child: null, probe: null, cancelled: false, lastBytes: 0, lastTime: Date.now(), done: null };
    this.active.set(task.id, record);
    try {
      if (/\.m3u8(?:$|\?)/i.test(task.url)) {
        record.isHls = true;
        await this.checkHlsVod(task, record);
      }
      record.probing = this.probeDuration(task, record);
      task.duration = await record.probing;
      record.probing = null;
      if (record.isHls && !/\.m3u8(?:$|\?)/i.test(task.url) && !record.cancelled && !this.closing) await this.checkHlsVod(task, record);
      if (record.cancelled || task.status !== 'downloading' || this.closing) {
        this.active.delete(task.id);
        this.schedule();
        return;
      }
      await fs.mkdir(task.outputDir, { recursive: true });
      task.temporaryPath = path.join(task.outputDir, `.${task.id}.part.${task.format}`);
      await fs.rm(task.temporaryPath, { force: true });
      if (record.cancelled || task.status !== 'downloading' || this.closing) { this.active.delete(task.id); this.schedule(); return; }
      // FFmpeg reports a benign EIO at the end of chunked HLS manifests under
      // -xerror. For HLS, detect irreversible skipped segments explicitly instead.
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning', ...(record.isHls ? [] : ['-xerror']), '-n', ...this.inputArgs(task), '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
      if (record.isHls) args.push('-seg_max_retry', '2');
      args.push('-i', task.url, '-c', 'copy');
      if (task.format === 'mp4') args.push('-movflags', '+faststart');
      args.push('-f', task.format === 'ts' ? 'mpegts' : task.format === 'mkv' ? 'matroska' : 'mp4', '-progress', 'pipe:1', '-nostats', task.temporaryPath);
      let stderr = '';
      let skippedSegments = false;
      let progressBuffer = '';
      const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      record.child = child;
      record.lastTime = Date.now();
      record.done = new Promise(resolve => {
        let finished = false;
        const finish = async (code, error) => {
          if (finished) return;
          finished = true;
          task.speed = 0;
          try {
            if (!record.cancelled && !this.closing && code === 0 && !error && !skippedSegments) {
              const stat = await fs.stat(task.temporaryPath);
              if (!stat.size) throw new Error('视频文件为空。');
              // Hard-link commits atomically without ever replacing an existing file.
              for (;;) {
                try { await fs.link(task.temporaryPath, task.outputPath); break; } catch (linkError) {
                  if (linkError.code !== 'EEXIST') throw linkError;
                  Object.assign(task, await this.reserveFilename(this.baseName(task), task.format, task.outputDir, task.id));
                }
              }
              task.status = 'completed';
              task.progress = 100;
              task.downloadedBytes = stat.size;
              task.totalBytes = stat.size;
              task.completedAt = new Date().toISOString();
              task.error = '';
            } else if (!record.cancelled && !this.closing) {
              task.status = 'failed';
              this.diagnostics.set(task.id, stderr);
              if (this.diagnostics.size > 50) this.diagnostics.delete(this.diagnostics.keys().next().value);
              const httpCode = stderr.match(/(?:HTTP error|Server returned|HTTP\/\S+)[^\n]*?\b([45]\d\d)\b/i)?.[1];
              task.error = error?.code === 'ENOENT' ? '找不到 FFmpeg，请安装后重启服务。' : skippedSegments ? '视频分片缺失或无法读取，未保存不完整的视频，请重试。' : httpCode ? `视频源返回 HTTP ${httpCode}，请检查地址有效期及 Referer。` : /Permission denied/i.test(stderr) ? '保存目录没有写入权限。' : /Invalid data|Error opening input|Unable to open/i.test(stderr) ? '无法读取视频流，请检查链接、格式及请求头。' : `下载失败${code == null ? '' : `（FFmpeg 退出码 ${code}）`}，请检查视频源后重试。`;
            }
          } catch (finishError) {
            if (!this.closing && !record.cancelled) { task.status = 'failed'; task.error = `文件保存失败：${finishError.code || finishError.message}`; }
          }
          await fs.rm(task.temporaryPath, { force: true }).catch(() => {});
          delete task.temporaryPath;
          this.active.delete(task.id);
          await this.persist();
          this.schedule();
          resolve();
        };
        child.stdout.on('data', data => {
          progressBuffer += data.toString();
          const lines = progressBuffer.split('\n');
          progressBuffer = lines.pop() || '';
          for (const line of lines) {
            const [key, value] = line.trim().split('=');
            if (key === 'total_size' && Number.isFinite(Number(value))) task.downloadedBytes = Math.max(0, Number(value));
            if (key === 'out_time_us' && Number.isFinite(Number(value))) {
              task.downloadedSeconds = Math.max(0, Number(value) / 1000000);
              if (task.duration) task.progress = Math.max(0, Math.min(99.5, task.downloadedSeconds / task.duration * 100));
            }
            if (key === 'progress' && task.status === 'downloading') {
              const now = Date.now();
              task.speed = Math.max(0, (task.downloadedBytes - record.lastBytes) / Math.max(0.001, (now - record.lastTime) / 1000));
              record.lastBytes = task.downloadedBytes;
              record.lastTime = now;
            }
          }
        });
        child.stderr.on('data', data => {
          stderr = (stderr + data.toString()).slice(-16384);
          skippedSegments ||= /Segment .*failed too many times, skipping|Error when loading first segment/i.test(stderr);
        });
        child.once('error', error => { void finish(null, error); });
        child.once('close', code => { void finish(code); });
      });
      await this.persist();
    } catch (error) {
      this.active.delete(task.id);
      if (!record.cancelled && !this.closing) { task.status = 'failed'; task.error = `无法开始下载：${error.code || error.message}`; }
      await this.persist();
      this.schedule();
    }
  }

  async checkHlsVod(task, record) {
    let manifestUrl = task.url;
    for (let level = 0; level < 5; level++) {
      if (record.cancelled || this.closing) return;
      const controller = new AbortController();
      record.preflight = controller;
      const timer = setTimeout(() => controller.abort(), 12000);
      timer.unref();
      let text = '';
      try {
        const response = await fetch(manifestUrl, { signal: controller.signal, headers: { 'User-Agent': task.inputHeaders?.userAgent || DEFAULT_UA, ...(task.inputHeaders?.referer ? { Referer: task.inputHeaders.referer } : {}) } });
        if (!response.ok) throw new ApiError(`视频源返回 HTTP ${response.status}，请检查地址有效期及 Referer。`);
        for await (const chunk of response.body) { text += Buffer.from(chunk).toString('utf8'); if (text.length > 2 * 1024 * 1024) { controller.abort(); throw new ApiError('视频清单过大，暂不支持此来源。'); } }
        if (!text.trimStart().startsWith('#EXTM3U')) return;
        if (/^#EXT-X-KEY:.*METHOD=(?:SAMPLE-AES|SAMPLE-AES-CTR)/m.test(text)) throw new ApiError('该视频使用 DRM 保护，暂不支持下载。');
        const variants = [...text.matchAll(/^#EXT-X-STREAM-INF:([^\r\n]+)[\r\n]+([^#\r\n][^\r\n]*)/gm)].map(match => ({ url: new URL(match[2].trim(), response.url).href, bandwidth: Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(match[1])?.[1] || 0) }));
        if (variants.length) { variants.sort((a, b) => b.bandwidth - a.bandwidth); manifestUrl = validateUrl(variants[0].url); continue; }
        if (!/^#EXT-X-ENDLIST\s*$/m.test(text)) throw new ApiError('检测到持续更新的直播流。当前支持点播视频，请使用包含结束标记的 m3u8。');
        return;
      } catch (error) {
        if (record.cancelled || this.closing) return;
        if (error instanceof ApiError) throw error;
        throw new ApiError(error.name === 'AbortError' ? '视频清单请求超时，请检查链接后重试。' : '无法获取视频清单，请检查网络及请求头。');
      } finally { clearTimeout(timer); record.preflight = null; }
    }
    throw new ApiError('视频清单嵌套过深，无法识别可下载的视频。');
  }

  async close() {
    this.closing = true;
    this.queueRunning = false;
    const waits = [];
    for (const task of this.tasks) {
      const record = this.active.get(task.id);
      if (['downloading', 'queued'].includes(task.status) || record) { task.status = 'paused'; task.speed = 0; task.error = record ? '服务已退出，继续后将重新下载此任务。' : task.error; }
      if (!record) continue;
      record.probe?.kill('SIGKILL');
      record.preflight?.abort();
      if (record.child) {
        record.child.kill('SIGCONT');
        record.child.kill('SIGKILL');
        if (record.done) waits.push(record.done);
      }
    }
    await Promise.allSettled(waits);
    await this.persist();
  }
}
