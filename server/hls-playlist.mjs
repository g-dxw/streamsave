/** Parse HLS attribute lists without splitting commas inside quoted values. */
export function parseAttributeList(value) {
  const result = {};
  const pattern = /(?:^|,)\s*([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))/gi;
  for (const match of String(value).matchAll(pattern)) result[match[1].toUpperCase()] = (match[2] ?? match[3]).trim();
  return result;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function parseMasterPlaylist(text, baseUrl) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim());
  const variants = [];
  const audioRenditions = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      if (attributes.TYPE !== 'AUDIO') continue;
      audioRenditions.push({ groupId: attributes['GROUP-ID'] || '', name: attributes.NAME || '', language: attributes.LANGUAGE || '', isDefault: attributes.DEFAULT === 'YES', autoselect: attributes.AUTOSELECT === 'YES', url: attributes.URI ? new URL(attributes.URI, baseUrl).href : null });
    }
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attributes = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
    let uri;
    for (let next = index + 1; next < lines.length; next++) {
      if (!lines[next]) continue;
      if (lines[next].startsWith('#EXT-X-STREAM-INF:')) break;
      if (!lines[next].startsWith('#')) { uri = lines[next]; index = next; break; }
    }
    if (!uri) continue;
    const dimensions = /^(\d+)x(\d+)$/i.exec(attributes.RESOLUTION || '');
    const width = dimensions ? positiveNumber(dimensions[1]) : 0;
    const height = dimensions ? positiveNumber(dimensions[2]) : 0;
    const codecs = attributes.CODECS || '';
    const videoCodec = /(?:avc[13]|hvc1|hev1|vp0?9|vp08|av01|mp4v|theora)/i.test(codecs);
    const knownAudioCodec = /(?:mp4a|ac-3|ec-3|opus|vorbis|flac)/i.test(codecs);
    variants.push({ url: new URL(uri, baseUrl).href, width, height, bandwidth: positiveNumber(attributes.BANDWIDTH), averageBandwidth: positiveNumber(attributes['AVERAGE-BANDWIDTH']), frameRate: positiveNumber(attributes['FRAME-RATE']), audioGroup: attributes.AUDIO || '', isAudioOnly: !width && !height && !videoCodec && knownAudioCodec });
  }
  return { variants, audioRenditions };
}

export function chooseBestVariant(variants) {
  if (!variants.length) return null;
  const videoCandidates = variants.filter(variant => !variant.isAudioOnly);
  const candidates = videoCandidates.length ? videoCandidates : variants;
  return [...candidates].sort((left, right) =>
    (right.width * right.height - left.width * left.height) ||
    ((right.bandwidth || right.averageBandwidth) - (left.bandwidth || left.averageBandwidth)) ||
    (right.averageBandwidth - left.averageBandwidth) ||
    (right.frameRate - left.frameRate)
  )[0];
}

export function chooseAudioRendition(renditions, groupId) {
  if (!groupId) return null;
  const matching = renditions.filter(rendition => rendition.groupId === groupId);
  return matching.find(rendition => rendition.isDefault) || matching.find(rendition => rendition.autoselect) || matching[0] || null;
}

export function qualityMetadata(variant) {
  const { width = 0, height = 0, bandwidth = 0, averageBandwidth = 0, frameRate = 0 } = variant;
  return { width, height, bandwidth, averageBandwidth, frameRate, label: width && height ? `${width}×${height}` : bandwidth || averageBandwidth ? `${((bandwidth || averageBandwidth) / 1000000).toFixed(2)} Mbps` : '原始画质' };
}
