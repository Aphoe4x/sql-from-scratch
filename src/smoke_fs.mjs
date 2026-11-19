// Smoke test for FileManager: create, write, commit, close, reopen (recovery).
import fs from 'node:fs';
import { FileManager, serializeLeaf, deserializeLeaf, LEAF } from '../src/fs.mjs';

const dbPath = 'smoke.db';

const fm = FileManager.create(dbPath);
console.log('pageCount:', fm.pageCount, 'lastCommitLSN:', fm.lastCommitLSN);

const p1 = fm.allocatePage();
fm.writePage(p1, serializeLeaf({ pageNum: p1, type: LEAF, entries: [{ key: 7, value: Buffer.from('seven') }] }));
const p2 = fm.allocatePage();
fm.writePage(p2, serializeLeaf({ pageNum: p2, type: LEAF, entries: [{ key: 9, value: Buffer.from('nine') }] }));
console.log('staged pages:', [...fm.dirty.keys()].join(','), 'pageCount:', fm.pageCount);

fm.commit();
console.log('after commit, dirty:', fm.dirty.size, 'lastCommitLSN:', fm.lastCommitLSN);

// read back through a fresh open (forces recovery path)
const fm2 = FileManager.open(dbPath);
console.log('reopened: pageCount:', fm2.pageCount, 'lastCommitLSN:', fm2.lastCommitLSN);
const e = deserializeLeaf(fm2.readPage(p1));
console.log('page', p1, 'entries:', JSON.stringify(e));
if (e.length !== 1 || e[0].key !== 7 || e[0].value.toString() !== 'seven') throw new Error('readback failed');

console.log('fs smoke OK');
