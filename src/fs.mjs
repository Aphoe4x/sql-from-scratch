// FileManager — the storage engine's "disk". A real OS file holding fixed-size
// pages (4096 bytes). Pages: 0 = meta page; data pages = internal/leaf B-tree pages.
// A write-ahead log (<db>.wal) records every page write and every commit.

import fs from 'node:fs';
import { crc32 } from './util.mjs';

export const PAGE_SIZE = 4096;
export const INTERNAL = 0;
export const LEAF = 1;

const MAGIC = 0x535144; // "SQD"
const VERSION = 1;

// ---- page serialization helpers -------------------------------------------

/** Internal page: [type u32][n seps u32 x n][children u32 x (n+1)]  (seps.length + 1 === children.length) */
export function serializeInternal(node) {
  const buf = Buffer.alloc(PAGE_SIZE);
  buf.writeUInt32LE(INTERNAL, 0);
  buf.writeUInt32LE(node.seps.length, 4);
  node.seps.forEach((s, i) => buf.writeUInt32LE(s, 8 + 4 * i));
  node.children.forEach((c, i) => buf.writeUInt32LE(c, 8 + 4 * node.seps.length + 4 * i));
  return buf;
}
export function deserializeInternal(buf) {
  const n = buf.readUInt32LE(4);
  const seps = Array.from({ length: n }, (_, i) => buf.readUInt32LE(8 + 4 * i));
  const children = Array.from({ length: n + 1 }, (_, i) => buf.readUInt32LE(8 + 4 * n + 4 * i));
  return { seps, children };
}

/** Leaf page: [type u32][count u32][entries] where entry = [key u32][valueLen u16][value] */
export function serializeLeaf(node) {
  const buf = Buffer.alloc(PAGE_SIZE);
  buf.writeUInt32LE(LEAF, 0);
  buf.writeUInt32LE(node.entries.length, 4);
  let off = 8;
  for (const e of node.entries) {
    buf.writeUInt32LE(e.key, off);
    off += 4;
    buf.writeUInt16LE(e.value.length, off);
    off += 2;
    e.value.copy(buf, off, 0, e.value.length);
    off += e.value.length;
  }
  return buf;
}
export function deserializeLeaf(buf) {
  const count = buf.readUInt32LE(4);
  const entries = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    const key = buf.readUInt32LE(off);
    off += 4;
    const len = buf.readUInt16LE(off);
    off += 2;
    const value = Buffer.from(buf.slice(off, off + len));
    off += len;
    entries.push({ key, value });
  }
  return entries;
}

// ---- WAL record layout ------------------------------------------------------
// [crc u32][payloadLen u32][type u8][lsn u32][payload]
// type 1 = PAGE: payload = [pageNum u32][page data]
// type 2 = COMMIT

const WAL_REC_FIXED = 13; // crc(4) + len(4) + type(1) + lsn(4)
const WAL_TYPE_PAGE = 1;
const WAL_TYPE_COMMIT = 2;

export class FileManager {
  /**
   * @param {string} filePath - path of the database file.
   * @param {{ create?: boolean }} [options] - create=true writes a fresh file; otherwise open existing.
   */
  constructor(filePath, { create = false } = {}) {
    this.path = filePath;
    this.walPath = filePath + '.wal';
    this.fd = fs.openSync(filePath, create ? 'w+' : 'r+', 0o666);
    this.walFd = fs.openSync(this.walPath, create ? 'w+' : 'r+', 0o666);
    this.pageCount = 1; // page 0 is the meta page, always present
    this.lastCommitLSN = 0;
    this.tables = []; // serialized table entries (see writeMeta)
    this.dirty = new Map(); // pageNum -> Buffer, staged by writePage, flushed on commit
    this.lsn = 0; // last WAL record sequence
    this.walLen = 0;
    if (create) {
      fs.ftruncateSync(this.fd, 0);
      fs.ftruncateSync(this.walFd, 0);
      this.writeMeta();
    } else {
      this.recover();
      this.readMeta();
    }
  }

  static create(filePath) {
    return new FileManager(filePath, { create: true });
  }
  static open(filePath) {
    return new FileManager(filePath);
  }

  // ---- meta page -----------------------------------------------------------

  writeMeta() {
    const buf = Buffer.alloc(PAGE_SIZE);
    buf.writeUInt32LE(MAGIC, 0);
    buf.writeUInt32LE(VERSION, 4);
    buf.writeUInt32LE(this.pageCount, 8);
    buf.writeUInt32LE(this.lastCommitLSN, 12);
    buf.writeUInt32LE(this.tables.length, 16);
    let off = 20;
    for (const t of this.tables) {
      buf.writeUInt32LE(t.name.length, off);
      off += 4;
      buf.write(t.name, 'utf8');
      off += t.name.length;
      buf.writeUInt32LE(t.columns.length, off);
      off += 4;
      for (const c of t.columns) {
        buf.writeUInt32LE(c.name.length, off);
        off += 4;
        buf.write(c.name, 'utf8');
        off += c.name.length;
        buf[off] = c.type === 'integer' ? 0 : 1;
        off += 1;
        buf[off] = c.isKey ? 1 : 0;
        off += 1;
      }
      buf.writeUInt32LE(t.rootPage, off);
      off += 4;
      buf.writeUInt32LE(t.nextId, off);
      off += 4;
    }
    fs.writeSync(this.fd, buf, 0, PAGE_SIZE, 0);
    fs.fsyncSync(this.fd);
  }

  readMeta() {
    const buf = Buffer.alloc(PAGE_SIZE);
    fs.readSync(this.fd, buf, 0, PAGE_SIZE, 0);
    if (buf.readUInt32LE(0) !== MAGIC) throw new Error(`corrupt meta page in ${this.path}`);
    this.pageCount = buf.readUInt32LE(8);
    this.lastCommitLSN = buf.readUInt32LE(12);
    this.tables = [];
    let off = 20;
    const count = buf.readUInt32LE(16);
    for (let i = 0; i < count; i++) {
      const nameLen = buf.readUInt32LE(off);
      off += 4;
      const name = buf.slice(off, off + nameLen).toString('utf8');
      off += nameLen;
      const colCount = buf.readUInt32LE(off);
      off += 4;
      const columns = [];
      for (let j = 0; j < colCount; j++) {
        const cnameLen = buf.readUInt32LE(off);
        off += 4;
        const cname = buf.slice(off, off + cnameLen).toString('utf8');
        off += cnameLen;
        const type = buf[off] === 0 ? 'integer' : 'text';
        off += 1;
        const isKey = buf[off] === 1;
        off += 1;
        columns.push({ name: cname, type, isKey });
      }
      const rootPage = buf.readUInt32LE(off);
      off += 4;
      const nextId = buf.readUInt32LE(off);
      off += 4;
      this.tables.push({ name, columns, rootPage, nextId });
    }
  }

  // ---- page I/O -------------------------------------------------------------

  /** Read a page (from dirty set if staged, else from the file). */
  readPage(pageNum) {
    const staged = this.dirty.get(pageNum);
    if (staged) return staged;
    const buf = Buffer.alloc(PAGE_SIZE);
    fs.readSync(this.fd, buf, 0, PAGE_SIZE, pageNum * PAGE_SIZE);
    return buf;
  }

  /** Stage a page for the next commit. Also appends a WAL page record. */
  writePage(pageNum, buf) {
    if (buf.length !== PAGE_SIZE) throw new Error(`page buffer must be PAGE_SIZE`);
    this.dirty.set(pageNum, buf);
    this.walAppend(WAL_TYPE_PAGE, { pageNum, data: buf });
  }

  allocatePage() {
    const n = this.pageCount++;
    return n;
  }

  // ---- commit / rollback -----------------------------------------------------

  /**
   * Flush all staged pages to the file, then append a COMMIT record.
   * Returns the commit LSN.
   */
  commit() {
    for (const [pageNum, buf] of [...this.dirty].sort((a, b) => a[0] - b[0])) {
      fs.writeSync(this.fd, buf, 0, PAGE_SIZE, pageNum * PAGE_SIZE);
    }
    fs.fsyncSync(this.fd);
    this.dirty.clear();
    this.lastCommitLSN = this.walAppend(WAL_TYPE_COMMIT, {});
    this.writeMeta();
  }

  /** Drop all staged (uncommitted) changes. */
  rollback() {
    this.dirty.clear();
  }

  // ---- WAL -------------------------------------------------------------------

  walAppend(type, payload) {
    const payloadLen = type === WAL_TYPE_PAGE ? 4 + PAGE_SIZE : 0;
    const buf = Buffer.alloc(WAL_REC_FIXED + payloadLen);
    const lsn = ++this.lsn;
    buf.writeUInt32LE(crc32(buf.slice(4)), 0); // placeholder, real crc written after body
    buf.writeUInt32LE(payloadLen, 4);
    buf[8] = type;
    buf.writeUInt32LE(lsn, 9);
    if (type === WAL_TYPE_PAGE) {
      buf.writeUInt32LE(payload.pageNum, 13);
      payload.data.copy(buf, 17, 0, PAGE_SIZE);
    }
    buf.writeUInt32LE(crc32(buf.slice(4, WAL_REC_FIXED + payloadLen)), 0);
    fs.writeSync(this.walFd, buf, 0, buf.length, this.walLen);
    this.walLen += buf.length;
    return lsn;
  }

  /** Replay the WAL: uncommitted tail is discarded; committed pages are re-written. */
  recover() {
    const size = fs.fstatSync(this.walFd).size;
    if (size > 0) {
      const buf = Buffer.alloc(size);
      fs.readSync(this.walFd, buf, 0, size, 0);
      let pos = 0;
      const committed = []; // [{pageNum, data}]
      let pending = []; // uncommitted tail: written to file if a COMMIT precedes, else dropped
      while (pos + WAL_REC_FIXED <= size) {
        const crc = buf.readUInt32LE(pos);
        const payloadLen = buf.readUInt32LE(pos + 4);
        const type = buf[pos + 8];
        const lsn = buf.readUInt32LE(pos + 9);
        const end = pos + WAL_REC_FIXED + payloadLen;
        if (end > size) break; // torn tail — stop
        const crcOk = crc32(buf.slice(pos + 4, end)) === crc;
        if (!crcOk) break;
        if (type === WAL_TYPE_PAGE) {
          const pageNum = buf.readUInt32LE(pos + 13);
          pending.push({ pageNum, data: Buffer.from(buf.slice(pos + 17, pos + 17 + PAGE_SIZE)) });
        } else if (type === WAL_TYPE_COMMIT) {
          // commit: everything pending is durable now
          for (const { pageNum, data } of pending) {
            fs.writeSync(this.fd, data, 0, PAGE_SIZE, pageNum * PAGE_SIZE);
          }
          fs.fsyncSync(this.fd);
          this.lastCommitLSN = Math.max(this.lastCommitLSN, lsn);
          this.lsn = Math.max(this.lsn, lsn);
          pending = [];
        }
        pos = end;
      }
      // tail without COMMIT: discard (uncommitted). Truncate the WAL to the committed prefix end.
      fs.ftruncateSync(this.walFd, 0);
      this.walLen = 0;
      this.lsn = Math.max(this.lsn, this.lastCommitLSN);
    }
  }
}
