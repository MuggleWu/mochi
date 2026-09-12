/**
 * git blob sha 计算。
 *
 * 为什么自己实现：远端树里给出的 sha 就是 `sha1("blob " + 字节长度 + "\0" + 内容)`，
 * 本地按同一算法算出 sha 后，"文件变没变"只需比字符串，**永远不必为了比较而读内容**。
 *
 * 用 Web Crypto（`crypto.subtle`）而不是 node:crypto —— 同一份代码要跑在
 * Android WebView 和 Node 测试里，node: 前缀在 WebView 中不存在。
 */

const encoder = new TextEncoder();
const HEX = '0123456789abcdef';

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
  return out;
}

/** 计算字节内容的 git blob sha（小写十六进制，40 字符）。 */
export async function blobShaOfBytes(bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header, 0);
  payload.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest('SHA-1', payload as unknown as BufferSource);
  return toHex(digest);
}

/** 计算文本内容的 git blob sha（UTF-8 编码，不做换行转换）。 */
export function blobShaOfText(text: string): Promise<string> {
  return blobShaOfBytes(encoder.encode(text));
}
