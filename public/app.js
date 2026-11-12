import {parseImport, previewFilename, formatBytes, escapeHtml as esc} from './lib.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let state = {settings:{}, tasks:[], system:{}, queueRunning:false};
let connected = false, initialized = false, settingsDirty = false, saving = false, filter = 'all';
let lastTaskSignature = '', lastSettingsSignature = '', editingId = '', hls = null, confirmAction = null;
let busyActions = new Set();
const statuses = {queued:'等待下载', downloading:'正在下载', paused:'已暂停', completed:'已完成', failed:'下载失败', cancelled:'已取消'};
const statusIcons = {queued:'clock', downloading:'download-simple', paused:'pause', completed:'check-circle', failed:'warning-circle', cancelled:'stop'};

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]:not(.icon-ready)').forEach(element => {
    const name = element.dataset.icon;
    if (!/^[a-z-]+$/.test(name)) return;
    element.style.maskImage = `url("/vendor/icons/${name}.svg")`;
    element.style.webkitMaskImage = `url("/vendor/icons/${name}.svg")`;
    element.classList.add('icon-ready');
    element.setAttribute('aria-hidden','true');
  });
}
function icon(name) { return `<span data-icon="${name}"></span>`; }
function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.setAttribute('role', error ? 'alert' : 'status');
  element.innerHTML = `${icon(error ? 'warning-circle' : 'check-circle')}<span>${esc(message)}</span>`;
  $('#toast-stack').append(element); hydrateIcons(element);
  setTimeout(() => { element.classList.add('leaving'); setTimeout(() => element.remove(),300); }, error ? 6500 : 3500);
}

async function api(path, method = 'GET', data, timeout = 20000) {
  const response = await fetch(path, {method, headers: method === 'GET' ? {} : {'Content-Type':'application/json'}, ...(method === 'GET' ? {} : {body:JSON.stringify(data ?? {})}), signal:AbortSignal.timeout(timeout)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
  return result;
}

async function refresh() {
  try {
    const next = await api('/api/state');
    const wasConnected = connected;
    state = next; connected = true;
    if (!initialized) {
      fillSettings(state.settings); initialized = true;
      if (state.system.storageWarning) toast(state.system.storageWarning,true);
      if (!state.system.ffmpegAvailable) toast('未检测到 FFmpeg，请安装后重启本地服务。',true);
    } else {
      if (!wasConnected) toast('已重新连接本地下载服务');
      if (!settingsDirty && JSON.stringify(state.settings) !== lastSettingsSignature) fillSettings(state.settings);
    }
    renderState();
  } catch {
    connected = false;
    $('#connection').className = 'connection offline';
    $('#connection').innerHTML = '<i></i>本地服务未连接';
    $('#start-all').disabled = true; $('#pause-all').disabled = true; $('#add-tasks').disabled = true;
    if (!initialized) $('#queue-footnote').innerHTML = '<i class="tiny-dot"></i>请先在项目中运行 npm start';
  }
}

function renderState() {
  const tasks = state.tasks;
  const counts = Object.fromEntries(['all',...Object.keys(statuses)].map(status => [status, status === 'all' ? tasks.length : tasks.filter(task=>task.status === status).length]));
  const bytes = tasks.filter(task=>task.status==='completed').reduce((sum,task)=>sum+(Number(task.downloadedBytes)||0),0);
  const speed = tasks.filter(task=>task.status === 'downloading').reduce((sum,task)=>sum+(Number(task.speed)||0),0);
  $('#connection').className = 'connection';
  $('#connection').innerHTML = '<i></i>本地服务已连接';
  $('#stat-total').innerHTML = `${counts.all}<small>个视频</small>`;
  $('#stat-active').innerHTML = `${counts.downloading}<small>个任务</small>`;
  $('#stat-done').innerHTML = `${counts.completed}<small>个视频</small>`;
  $('#stat-speed').innerHTML = `${speed > 0 ? (speed / 1024 ** 2).toFixed(1) : '0'}<small>MB/s</small>`;
  $('#nav-count').textContent = counts.all; $('#nav-completed').textContent = counts.completed;
  $('#queue-count').textContent = counts.all;
  $('#filter-all-count').textContent = counts.all; $('#filter-active-count').textContent = counts.downloading;
  $('#filter-done-count').textContent = counts.completed; $('#filter-failed-count').textContent = counts.failed;
  $('#clear-completed').disabled = !counts.completed || busyActions.has('clear');
  $('#export-tasks').disabled = !counts.all;
  $('#retry-failed').hidden = !counts.failed;
  const pending = counts.queued + counts.paused;
  $('#start-all').disabled = !pending || !state.system.ffmpegAvailable || busyActions.has('start');
  $('#pause-all').disabled = !(counts.downloading || (state.queueRunning && counts.queued)) || busyActions.has('pause');
  $('#start-count').textContent = pending;
  const percent = counts.all ? Math.round(tasks.reduce((sum, task)=>sum+(task.status === 'completed' ? 100 : Number(task.progress)||0),0) / counts.all) : 0;
  $('#overall-percent').textContent = `${percent}%`; $('#overall-progress-bar').style.width = `${percent}%`;
  $('#overall-title').textContent = counts.downloading ? `${counts.downloading} 个任务正在下载` : counts.all && counts.completed === counts.all ? '这一批，已全部保存。' : counts.paused ? `${counts.paused} 个任务已暂停` : counts.failed && !pending ? `${counts.failed} 个任务需要重试` : pending ? `${pending} 个视频，等待出发。` : '准备好，开始收藏。';
  $('#overall-subtitle').textContent = counts.all ? `已完成 ${counts.completed} / ${counts.all} · 已保存 ${formatBytes(bytes)}` : '添加视频链接后，即可开始批量下载';
  $('#queue-footnote').innerHTML = `<i class="tiny-dot"></i>${counts.downloading ? `正在使用 ${counts.downloading} / ${state.settings.concurrency} 个并发任务` : counts.all ? `共 ${counts.all} 个任务，已完成 ${counts.completed} 个` : '准备就绪，等待添加任务'}`;
  $('#system-checks').innerHTML = `<span class="${state.system.ffmpegAvailable?'':'unavailable'}">${icon(state.system.ffmpegAvailable?'check-circle':'warning-circle')}FFmpeg ${state.system.ffmpegAvailable?'已就绪':'未安装'}</span><span class="${state.system.hlsAvailable?'':'unavailable'}">${icon(state.system.hlsAvailable?'check-circle':'warning-circle')}本地 hls.js ${state.system.hlsAvailable?'已接入':'未构建'}</span>`;
  const signature = JSON.stringify([tasks,filter]);
  if (signature !== lastTaskSignature) {
    const focus = document.activeElement?.closest('[data-task-action]');
    const focusedTask = focus?.dataset.taskId, focusedAction = focus?.dataset.taskAction;
    renderTasks(); lastTaskSignature = signature;
    if (focusedTask) $(`[data-task-id="${CSS.escape(focusedTask)}"][data-task-action="${CSS.escape(focusedAction)}"]`)?.focus({preventScroll:true});
  }
  updateImport(); hydrateIcons();
}

function renderTasks() {
  const tasks = state.tasks.filter(task=>filter === 'all' || task.status === filter);
  if (!state.tasks.length) {
    $('#task-list').innerHTML = `<div class="empty-state"><div class="empty-art"><div class="empty-art-back"></div><div class="empty-art-front">${icon('film-strip')}<span class="empty-art-plus">+</span></div><i class="art-dot dot-one"></i><i class="art-dot dot-two"></i></div><h3>好内容，值得好好保存。</h3><p>添加你的第一批视频链接，<br>下载进度会在这里一目了然。</p><div class="empty-steps"><span>粘贴地址</span>${icon('arrow-right')}<span>设置规则</span>${icon('arrow-right')}<span>开始下载</span></div></div>`;
    return;
  }
  if (!tasks.length) {
    const labels = {downloading:'还没有正在下载的视频',completed:'还没有下载完成的视频',failed:'目前没有失败的任务'};
    $('#task-list').innerHTML = `<div class="empty-state empty-filter">${icon(filter==='failed'?'check-circle':filter==='completed'?'folder-simple':'clock')}<h3>${labels[filter] || '这里暂时没有任务'}</h3><p>${filter==='failed'?'每一次顺利保存，都值得安心。':'开始下载后，任务状态会显示在这里。'}</p><button class="text-button" data-show-all style="margin-top:16px">查看全部任务 ${icon('arrow-right')}</button></div>`;
    return;
  }
  $('#task-list').innerHTML = tasks.map(task=>{
    let domain = '';
    try { domain = new URL(task.url).hostname; } catch { domain = '视频地址'; }
    const status = Object.hasOwn(statuses,task.status) ? task.status : 'queued';
    const progress = Math.max(0,Math.min(100,Number(task.progress)||0));
    const unknown = status === 'downloading' && !task.duration;
    const id = esc(task.id);
    const actionButton = (action, label, glyph) => `<button class="icon-button" data-task-action="${action}" data-task-id="${id}" aria-label="${label}：${esc(task.name)}" title="${label}" ${busyActions.has(task.id)?'disabled':''}>${icon(glyph)}</button>`;
    const running = status === 'downloading';
    const editable = ['queued','paused','failed','cancelled'].includes(status);
    const primaryAction = running || status === 'queued' ? actionButton('pause','暂停下载','pause') : status === 'completed' ? actionButton('open','在文件夹中显示','folder-open') : actionButton(status === 'failed' || status==='cancelled' ? 'retry':'resume',status === 'failed'?'重试下载':'继续下载',status === 'failed'?'arrow-clockwise':'play');
    return `<article class="task-row" aria-label="${esc(task.name)}，${statuses[status]}"><div class="task-identity"><span class="task-file-icon">${icon('file-video')}<span class="task-number">${esc(String(task.number).padStart(Number(task.padWidth || state.settings.padWidth)||1,'0'))}</span></span><div class="task-name-wrap"><button class="task-name" data-task-action="preview" data-task-id="${id}" title="预览 ${esc(task.filename || task.name)}">${esc(task.filename || task.name)}</button><div class="task-meta"><span>${formatBytes(task.downloadedBytes)}</span><span class="meta-separator">·</span><span class="source-domain" title="${esc(domain)}">${esc(domain)}</span></div></div></div><div class="task-status status-${status}"><div class="status-top"><span class="status-label">${icon(statusIcons[status])}${statuses[status]}</span><span>${unknown ? '解析中' : `${Math.round(progress)}%`}</span></div><div class="progress-track" role="progressbar" aria-label="${esc(task.name)}下载进度" aria-valuemin="0" aria-valuemax="100" ${unknown?'':`aria-valuenow="${Math.round(progress)}"`}><span style="width:${unknown?24:progress}%" ${unknown?'class="pulse-progress"':''}></span></div>${task.error?`<p class="task-error" title="${esc(task.error)}">${esc(task.error)}</p>`:running&&task.speed?`<div class="task-speed">${formatBytes(task.speed)}/s</div>`:''}</div><div class="task-actions">${primaryAction}${editable?actionButton('edit','编辑名称与编号','pencil-simple'):actionButton('preview','视频预览','play')}${actionButton('delete','移除任务','trash')}</div></article>`;
  }).join('');
}

function formSettings() {
  const preset = $('#naming-preset').value;
  return {
    concurrency:Number($('#concurrency').value), outputDir:$('#output-dir').value.trim(),
    namingPattern:preset === 'custom' ? $('#naming-pattern').value.trim() : preset,
    startNumber:Number($('#start-number').value), padWidth:Number($('#pad-width').value), format:$('#format').value,
    headers:{referer:$('#referer').value.trim(), userAgent:$('#user-agent').value.trim()}
  };
}
function fillSettings(settings) {
  lastSettingsSignature = JSON.stringify(settings);
  $('#concurrency').value = settings.concurrency;
  $('#output-dir').value = settings.outputDir;
  $('#format').value = settings.format;
  $('#start-number').value = settings.startNumber;
  $('#pad-width').value = settings.padWidth;
  $('#naming-pattern').value = settings.namingPattern;
  $('#naming-preset').value = ['{number}_{name}','{name}_{number}','{name}'].includes(settings.namingPattern) ? settings.namingPattern : 'custom';
  $('#referer').value = settings.headers?.referer || ''; $('#user-agent').value = settings.headers?.userAgent || '';
  settingsDirty = false; updateSettingsPreview();
}
function updateSettingsPreview() {
  $('#concurrency-display').textContent = $('#concurrency').value;
  $('#concurrency-minus').disabled = Number($('#concurrency').value) <= 1;
  $('#concurrency-plus').disabled = Number($('#concurrency').value) >= 8;
  $('#custom-pattern-field').hidden = $('#naming-preset').value !== 'custom';
  $('#filename-preview').textContent = previewFilename(formSettings(), parseImport($('#stream-input').value).items[0]?.name || '视频名称');
  $('#settings-state').textContent = settingsDirty ? '待保存' : '已保存';
  $('#settings-state').classList.toggle('dirty',settingsDirty);
}
function dirtySettings() { settingsDirty = true; $('#settings-error').hidden = true; updateSettingsPreview(); }
async function saveSettings(showToast = true) {
  if (saving) throw new Error('设置正在保存，请稍后。');
  if (!$('#settings-form').reportValidity()) throw new Error('请检查下载设置中的输入内容。');
  saving = true; $('#settings-state').textContent = '保存中…';
  try {
    await api('/api/settings','PATCH',formSettings());
    settingsDirty = false; $('#settings-error').hidden = true;
    updateSettingsPreview(); if (showToast) toast('下载设置已保存');
  } catch (error) {
    $('#settings-error').textContent = error.message; $('#settings-error').hidden = false;
    throw error;
  } finally { saving = false; $('#settings-state').textContent = settingsDirty ? '待保存' : '已保存'; }
}

function updateImport() {
  const result = parseImport($('#stream-input').value,new Set(state.tasks.map(task=>task.url)));
  const hasText = $('#stream-input').value.trim().length > 0;
  $('#import-count').textContent = result.items.length ? `已识别 ${result.items.length} 个视频${result.duplicates ? ` · ${result.duplicates} 条重复已跳过` : ''}` : result.duplicates ? `${result.duplicates} 条链接已在队列中` : '支持 M3U8、MP4 等视频地址';
  $('#add-tasks').disabled = !connected || !result.items.length || result.invalid.length > 0 || busyActions.has('add');
  const lines = Math.min(50,Math.max(4,$('#stream-input').value.split('\n').length));
  $('#editor-gutter').innerHTML = Array.from({length:lines},(_,index)=>String(index+1).padStart(2,'0')).join('<br>');
  const feedback = $('#import-feedback');
  feedback.hidden = !hasText || (!result.invalid.length && result.items.length <= 500);
  if (!feedback.hidden) feedback.textContent = result.items.length > 500 ? '每批最多添加 500 个视频，请拆成多批导入。' : `第 ${result.invalid.slice(0,4).map(item=>item.line).join('、')} 行地址无效，请修改后添加${result.invalid.length>4?`（共 ${result.invalid.length} 行）`:''}。`;
  if (result.items.length > 500) $('#add-tasks').disabled = true;
  if (initialized) $('#filename-preview').textContent = previewFilename(formSettings(),result.items[0]?.name || '视频名称');
  return result;
}
async function addTasks() {
  const result = updateImport();
  if (!result.items.length || result.invalid.length || busyActions.has('add')) return;
  busyActions.add('add'); updateImport();
  try {
    if (settingsDirty) await saveSettings(false);
    await api('/api/tasks','POST',{items:result.items,start:false});
    $('#stream-input').value = ''; setFilter('all');
    toast(`已添加 ${result.items.length} 个视频，点击「开始下载」即可保存`);
    await refresh();
    $('#queue-heading').scrollIntoView({behavior:reduceMotion()?'instant':'smooth',block:'nearest'});
  } catch (error) { toast(error.message,true); }
  finally { busyActions.delete('add'); updateImport(); }
}

function reduceMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
function setFilter(next, fromNav = false) {
  filter = next;
  $$('[data-filter]').forEach(button=>{button.classList.toggle('active',button.dataset.filter===next);button.setAttribute('aria-selected',String(button.dataset.filter===next));});
  if (fromNav || next !== 'completed') {
    $$('[data-view]').forEach(button=>{const active=button.dataset.view===(next==='completed'?'completed':'all');button.classList.toggle('active',active);active?button.setAttribute('aria-current','page'):button.removeAttribute('aria-current');});
    $('#page-title').textContent = next==='completed'?'每一份收藏，都在这里。':'下载，井然有序。';
    $('#page-description').textContent = next==='completed'?'查看已经保存的视频，继续预览，或在本地文件夹中找到它们。':'把视频流变成你的本地收藏。从一条链接，到一整个系列。';
    $('#breadcrumb-current').textContent = next==='completed'?'已完成':'下载工作台';
    $('#import-panel').hidden = next==='completed';
  }
  renderState();
}
function showDialog(id) { const dialog = $(id); dialog.showModal(); hydrateIcons(dialog); }
function confirm(title, description, label, callback) {
  $('#confirm-title').textContent = title; $('#confirm-description').textContent = description;
  $('#confirm-action').textContent = label; confirmAction = callback; showDialog('#confirm-dialog');
}

async function queueAction(action) {
  if (busyActions.has(action)) return;
  busyActions.add(action); renderState();
  try {
    if (action === 'start' && settingsDirty) await saveSettings(false);
    await api(`/api/queue/${action}`,'POST');
    toast(action==='start'?'下载队列已启动':'下载队列已暂停');
  } catch(error) {toast(error.message,true);}
  finally {busyActions.delete(action); await refresh();}
}

async function taskAction(action,id) {
  const task = state.tasks.find(item=>item.id===id);
  if (!task || busyActions.has(id)) return;
  if (action === 'preview') { preview(task); return; }
  if (action === 'edit') {
    editingId = id; $('#edit-name').value = task.name; $('#edit-number').value = task.number;
    $('#edit-error').hidden = true; showDialog('#edit-dialog'); return;
  }
  if (action === 'delete') {
    confirm('移除这条任务？',task.status==='completed'?'只清除下载记录，保存在电脑中的视频会保留。':'此操作会停止下载，并移除这条任务的未完成文件。','移除任务',async()=>{await api(`/api/tasks/${encodeURIComponent(id)}`,'DELETE');toast('任务已移除');});
    return;
  }
  busyActions.add(id); lastTaskSignature=''; renderState();
  try {
    if (action === 'open') await api('/api/folder/open','POST',{taskId:id});
    else {if (settingsDirty && ['retry','resume'].includes(action)) await saveSettings(false); await api(`/api/tasks/${encodeURIComponent(id)}/${action}`,'POST');}
  } catch(error) {toast(error.message,true);}
  finally {busyActions.delete(id);lastTaskSignature='';await refresh();}
}

function preview(task) {
  const video = $('#preview-video');
  if (hls) {hls.destroy();hls=null;}
  video.pause(); video.removeAttribute('src'); video.load();
  $('#preview-title').textContent = task.name;
  const message = $('#preview-message'); message.className='preview-message';message.textContent='正在载入视频…';
  showDialog('#preview-dialog');
  const source = task.status==='completed'?`/api/tasks/${encodeURIComponent(task.id)}/file`:task.url;
  if (task.status==='completed' && task.format && task.format!=='mp4') {
    message.textContent='MKV / TS 在部分浏览器中无法预览，可在本地文件夹中使用视频播放器打开。';
  }
  const error = () => {message.classList.add('error');message.textContent=task.status==='completed'?'当前浏览器无法播放此视频格式，请在本地播放器中打开。':'预览未能载入。视频源可能限制跨域访问或需要请求头；你仍可尝试本地下载。';};
  video.onerror = error;
  video.onloadedmetadata = ()=>{message.className='preview-message';message.textContent=task.status==='completed'?'正在预览本地已保存的视频。':'源视频预览 · 下载文件会保存到设置中的本地目录。';};
  if (task.status!=='completed' && !/\.(mp4|m4v|mov|webm|mkv|ts)(?:$|[?#])/i.test(source) && window.Hls?.isSupported()) {
    hls = new window.Hls({enableWorker:true,maxBufferLength:20});
    hls.on(window.Hls.Events.ERROR,(_,data)=>{if(data.fatal){hls?.destroy();hls=null;video.src=source;error();}});
    hls.loadSource(source);hls.attachMedia(video);
  } else video.src=source;
}

$('#settings-form').addEventListener('input',dirtySettings);
$('#settings-form').addEventListener('change',dirtySettings);
$('#settings-form').addEventListener('submit',async event=>{event.preventDefault();try{await saveSettings();await refresh();}catch(error){toast(error.message,true);}});
$('#concurrency-minus').addEventListener('click',()=>{$('#concurrency').stepDown();dirtySettings();});
$('#concurrency-plus').addEventListener('click',()=>{$('#concurrency').stepUp();dirtySettings();});
$('#stream-input').addEventListener('input',updateImport);
$('#stream-input').addEventListener('scroll',()=>{$('#editor-gutter').scrollTop=$('#stream-input').scrollTop;});
$('#stream-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();addTasks();}});
$('#add-tasks').addEventListener('click',addTasks);
$('#load-example').addEventListener('click',()=>{$('#stream-input').value='HLS 测试短片 | https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8\nBig Buck Bunny | https://test-streams.mux.dev/bbb-360p-playlist.m3u8';updateImport();$('#stream-input').focus();toast('已填入公开测试流，添加后再开始下载');});
$('#file-import').addEventListener('change',async event=>{
  const file=event.target.files[0]; if(!file)return;
  try {
    if(file.size>2*1024*1024)throw new Error('文件超过 2 MB，请分批导入。');
    const content=await file.text();
    const existing=$('#stream-input').value.trim();
    $('#stream-input').value=existing?`${existing}\n${content}`:content;updateImport();toast(`已读取 ${file.name}，请检查后添加到队列`);
  }catch(error){toast(error.message,true);}finally{event.target.value='';}
});
$('.file-import').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('#file-import').click();}});
$('#new-batch').addEventListener('click',()=>{setFilter('all',true);$('#import-panel').scrollIntoView({behavior:reduceMotion()?'instant':'smooth',block:'center'});$('#stream-input').focus({preventScroll:true});});
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>setFilter(button.dataset.view,true)));
$$('[data-filter]').forEach(button=>button.addEventListener('click',()=>setFilter(button.dataset.filter)));
$('.filter-tabs').addEventListener('keydown',event=>{const tabs=$$('[data-filter]');const index=tabs.indexOf(document.activeElement);if(index<0)return;let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();tabs[next].focus();setFilter(tabs[next].dataset.filter);});
$('#task-list').addEventListener('click',event=>{const button=event.target.closest('[data-task-action]');if(button)taskAction(button.dataset.taskAction,button.dataset.taskId);else if(event.target.closest('[data-show-all]'))setFilter('all');});
$('#start-all').addEventListener('click',()=>queueAction('start'));
$('#pause-all').addEventListener('click',()=>queueAction('pause'));
$('#retry-failed').addEventListener('click',async()=>{try{if(settingsDirty)await saveSettings(false);await api('/api/tasks/retry-failed','POST');toast('失败的任务已重新加入下载');await refresh();}catch(error){toast(error.message,true);}});
$('#clear-completed').addEventListener('click',()=>confirm('清理已完成的任务记录？','已下载的视频会保留在本地文件夹中。清理后，可通过「打开下载目录」找到文件。','清理记录',async()=>{await api('/api/tasks/clear','POST',{status:'completed'});toast('已清理完成记录，本地视频已保留');}));
$('#confirm-action').addEventListener('click',async()=>{if(!confirmAction)return;const button=$('#confirm-action');button.disabled=true;try{await confirmAction();$('#confirm-dialog').close();await refresh();}catch(error){toast(error.message,true);}finally{button.disabled=false;confirmAction=null;}});
$('#edit-form').addEventListener('submit',async event=>{event.preventDefault();const button=$('#edit-form [type=submit]');button.disabled=true;try{await api(`/api/tasks/${encodeURIComponent(editingId)}`,'PATCH',{name:$('#edit-name').value.trim(),number:Number($('#edit-number').value)});$('#edit-dialog').close();toast('视频名称与编号已更新');await refresh();}catch(error){$('#edit-error').hidden=false;$('#edit-error').textContent=error.message;}finally{button.disabled=false;}});
$('#pick-folder').addEventListener('click',async()=>{const button=$('#pick-folder');button.disabled=true;try{const result=await api('/api/folder/pick','POST',{},130000);if(result.path){$('#output-dir').value=result.path;dirtySettings();}}catch(error){toast(error.message,true);}finally{button.disabled=false;}});
$('#nav-folder').addEventListener('click',async()=>{try{await api('/api/folder/open','POST');}catch(error){toast(error.message,true);}});
$$('.help-trigger').forEach(button=>button.addEventListener('click',()=>showDialog('#help-dialog')));
$$('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close();}));
$('#preview-dialog').addEventListener('close',()=>{if(hls){hls.destroy();hls=null;}$('#preview-video').pause();$('#preview-video').removeAttribute('src');$('#preview-video').load();});
$('#export-tasks').addEventListener('click',()=>{const rows=['name,url',...state.tasks.map(task=>[task.name,task.url].map(value=>`"${String(value).replaceAll('"','""')}"`).join(','))];const blob=new Blob(['\uFEFF'+rows.join('\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`流存任务_${new Date().toLocaleDateString('sv-SE')}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('任务清单已导出');});

hydrateIcons(); updateSettingsPreview();
await refresh();
async function poll(){await refresh();setTimeout(poll,1500);}
setTimeout(poll,1500);
