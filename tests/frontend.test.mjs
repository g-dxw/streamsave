import test from 'node:test';
import assert from 'node:assert/strict';
import {parseImport, previewFilename, escapeHtml} from '../public/lib.mjs';

test('imports plain URLs, URL queries with commas, named streams and duplicate detection',()=>{
  const result=parseImport('https://example.com/master.m3u8?token=a,b\n第一课 | https://example.com/b.m3u8\nhttps://example.com/b.m3u8\nhttps://existing.com/video.mp4',new Set(['https://existing.com/video.mp4']));
  assert.equal(result.items.length,2);assert.equal(result.duplicates,2);assert.deepEqual(result.invalid,[]);
  assert.equal(result.items[0].url,'https://example.com/master.m3u8?token=a,b');
  assert.equal(result.items[1].name,'第一课');
});
test('imports CSV in either column order with escaped quotes and comma titles',()=>{
  const first=parseImport('url,name\nhttps://example.com/a.m3u8,"第一课,开始"');
  assert.deepEqual(first.items,[{url:'https://example.com/a.m3u8',name:'第一课,开始'}]);
  const second=parseImport('\uFEFFname,url\n"课时 ""一""",https://example.com/b.m3u8');
  assert.deepEqual(second.items,[{url:'https://example.com/b.m3u8',name:'课时 "一"'}]);
});
test('imports a CSV file appended to existing pasted URLs',()=>{
  const result=parseImport('https://example.com/one.mp4\nname,url\n第二课,https://example.com/two.m3u8');
  assert.equal(result.items.length,2);assert.equal(result.items[1].name,'第二课');assert.equal(result.invalid.length,0);
});
test('marks invalid and credential-bearing addresses with original line numbers',()=>{
  const result=parseImport('\n# 视频列表\nfile:///tmp/video\nhttps://user:pass@example.com/a\nhttps://example.com/a b\nhttps://example.com/good.mp4');
  assert.deepEqual(result.invalid.map(item=>item.line),[3,4,5]);assert.equal(result.items.length,1);
});
test('previews custom numbering and escapes executable title markup',()=>{
  assert.equal(previewFilename({namingPattern:'课程{number}_{name}',startNumber:7,padWidth:4,format:'mkv'},'上/下'), '课程0007_上_下.mkv');
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});
