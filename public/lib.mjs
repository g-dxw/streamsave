export function parseImport(text, existingUrls = new Set()) {
  const items = [], invalid = [], seen = new Set(existingUrls);
  let duplicates = 0;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let csvHeader;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    let url = '', name = '';
    if (!csvHeader && /^https?:\/\//i.test(line)) {
      [url, name = ''] = line.split(/\s*\|\s*|\t/, 2);
    } else {
      const fields = line.includes('|') ? line.split('|') : line.includes('\t') ? line.split('\t') : parseCsvLine(line);
      if (fields.some(value => /^(url|地址|链接)$/i.test(value.trim()))) {
        csvHeader = fields.map(value => value.trim().toLowerCase());
        continue;
      }
      if (csvHeader) {
        url = fields[csvHeader.findIndex(value => /^(url|地址|链接)$/.test(value))] || '';
        name = fields[csvHeader.findIndex(value => /^(name|title|名称|视频名称)$/.test(value))] || '';
      } else {
        const urlIndex = fields.findIndex(value => /^https?:\/\//i.test(value.trim()));
        url = fields[urlIndex] || '';
        name = fields.filter((_, i) => i !== urlIndex).join(' ').trim();
      }
    }
    url = url.trim();
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /[\r\n\s]/.test(url)) throw new Error();
      url = parsed.href;
      if (seen.has(url)) { duplicates++; continue; }
      seen.add(url);
      items.push({url, name: name.trim() || nameFromUrl(parsed, items.length + 1)});
    } catch {
      invalid.push({line: index + 1, text: line, reason: '请填写有效的 HTTP 或 HTTPS 视频地址'});
    }
  }
  return {items, invalid, duplicates};
}

export function parseCsvLine(line) {
  const fields = []; let current = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { fields.push(current.trim()); current = ''; }
    else current += char;
  }
  fields.push(current.trim());
  return fields;
}

function nameFromUrl(url, index) {
  let base = url.pathname.split('/').filter(Boolean).at(-1) || '';
  try { base = decodeURIComponent(base); } catch { /* Keep malformed URL components readable. */ }
  base = base.replace(/\.(m3u8|mp4|mkv|mov|webm|ts|m4v)$/i, '');
  return /^(index|master|playlist|video|stream|main|chunklist.*)$/i.test(base) || !base ? `视频 ${index}` : base;
}

export function previewFilename(settings, name = '视频名称', number = settings.startNumber) {
  const serial = String(number ?? 1).padStart(Number(settings.padWidth) || 1, '0');
  const base = (settings.namingPattern || '{number}_{name}').replaceAll('{number}', serial).replaceAll('{name}', name);
  return `${base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.+$/g, '').trim() || '视频'}.${settings.format || 'mp4'}`;
}

export function formatBytes(value = 0) {
  const size = Math.max(0, Number(value) || 0);
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${Math.round(size)} B`;
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
}
