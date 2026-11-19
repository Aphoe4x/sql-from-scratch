// Smoke test for BTree: sequential inserts, finds, scan order, random inserts, stats.
import { FileManager, serializeLeaf, LEAF } from './fs.mjs';
import { BTree } from './btree.mjs';

const fm = FileManager.create('smoke_btree.db');
const root = fm.allocatePage();
fm.writePage(root, serializeLeaf({ type: LEAF, pageNum: root, entries: [] }));
const bt = new BTree(fm, root);

// 1. Sequential inserts
for (let i = 0; i < 1000; i++) bt.insert(i, Buffer.from(`value-${i}`));
// 2. Find every key
for (let i = 0; i < 1000; i++) {
  const f = bt.find(i);
  if (!f.found || f.value.toString() !== `value-${i}`) throw new Error(`find(${i}) failed: found=${f.found} value=${f.value}`);
}
// 3. Scan must be ascending 0..999
{
  const got = [...bt.scan()].map((e) => e.key);
  const want = Array.from({ length: 1000 }, (_, i) => i);
  if (got.length !== want.length || got.some((v, i) => v !== want[i])) throw new Error('scan order mismatch');
  console.log('sequential: 1000 inserts, 1000 finds, scan ok, stats:', bt.stats());
}

// 4. Random inserts: half of 2000 keys, then verify all.
{
  const root2 = fm.allocatePage();
  fm.writePage(root2, serializeLeaf({ type: LEAF, pageNum: root2, entries: [] }));
  const bt2 = new BTree(fm, root2);
  const set = new Set();
  for (let i = 0; i < 2000; i += 2) {
    bt2.insert(i, Buffer.from(`v-${i}`));
    set.add(i);
  }
  for (let i = 0; i < 2000; i++) {
    const f = bt2.find(i);
    if (set.has(i) && (!f.found || f.value.toString() !== `v-${i}`)) throw new Error(`random find(${i}) failed`);
    if (!set.has(i) && f.found) throw new Error(`random find(${i}) found but should not be`);
  }
  const got = [...bt2.scan()].map((e) => e.key);
  const want = [...set].sort((a, b) => a - b);
  if (got.length !== want.length || got.some((v, i) => v !== want[i])) throw new Error('random scan mismatch');
  // 5. Overwrite existing key
  const before = bt2.find(42);
  if (!before.found || before.value.toString() !== 'v-42') throw new Error('pre-overwrite find failed');
  bt2.insert(42, Buffer.from('overwritten'));
  const after = bt2.find(42);
  if (after.value.toString() !== 'overwritten') throw new Error('overwrite failed');
  console.log('random: 1000 inserts, all finds ok + overwrite ok, stats:', bt2.stats());
}

fm.commit();
const fm2 = FileManager.open('smoke_btree.db');
const bt3 = new BTree(fm2, bt.rootPage); // root may have moved after splits
if (bt3.find(123).value?.toString() !== 'value-123') throw new Error('reopen find failed'); // in tree #1 (root)
// 6. Stress: 6000 sequential inserts on tree 1 (exercises internal splits)
{
  const btS = new BTree(fm2, bt3.rootPage);
  const n = 6000;
  for (let i = 1000; i < 1000 + n; i++) btS.insert(i, Buffer.from(`stress-${i}`));
  for (let i = 0; i < 1000 + n; i++) {
    const f = btS.find(i);
    if (!f.found) throw new Error(`stress find(${i}) failed`);
  }
  const scanned = [...btS.scan()].map((e) => e.key);
  const want = scanned.length;
  const sorted = [...scanned].sort((a, b) => a - b);
  if (scanned.some((v, i) => v !== sorted[i])) throw new Error('stress scan not sorted');
  fm2.commit();
  console.log(`stress ok: ${want} entries, stats:`, btS.stats());
}
console.log('btree smoke OK');
