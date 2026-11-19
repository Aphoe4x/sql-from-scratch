// src/btree.mjs — classic bottom-up B-tree over the FileManager pages.
//
// Invariant: an internal page P with n separators has n+1 children:
//   children[0] = keys <= seps[0],  children[i] = keys in (seps[i-1], seps[i]]
//   for 0 < i < n,  children[n] = keys > seps[n-1].
// Search: i = first index with key > seps[i]; descend children[i].
// Leaf entry: [key u32][valueLen u16][value]. Internal: seps[], children[].

import {
  serializeInternal,
  deserializeInternal,
  serializeLeaf,
  deserializeLeaf,
  INTERNAL,
  LEAF,
} from './fs.mjs';

export const MAX_ENTRIES = 100;

export class BTree {
  /**
   * @param {import('./fs.mjs').FileManager} fm
   * @param {number} rootPage
   */
  constructor(fm, rootPage) {
    this.fm = fm;
    this.rootPage = rootPage;
    this.visited = 0; // pages read (used by find()/scan() stats)
  }

  read(pageNum) {
    this.visited++;
    const buf = this.fm.readPage(pageNum);
    const type = buf[0] === INTERNAL ? INTERNAL : LEAF;
    return type === INTERNAL ? { type, pageNum, ...deserializeInternal(buf) } : { type, pageNum, entries: deserializeLeaf(buf) };
  }

  childIndex(node, key) {
    let i = 0;
    while (i < node.seps.length && key > node.seps[i]) i++;
    return i;
  }

  /** Find a key. Returns { found, key, value }. */
  find(key) {
    this.visited = 0;
    let node = this.read(this.rootPage);
    while (node.type === INTERNAL) {
      node = this.read(node.children[this.childIndex(node, key)]);
    }
    const idx = node.entries.findIndex((e) => e.key === key);
    return idx === -1 ? { found: false, key, value: undefined } : { found: true, key: node.entries[idx].key, value: node.entries[idx].value };
  }

  /** Insert or replace a (key, value). */
  insert(key, value) {
    const path = []; // [{ node, k }] for each internal level descended
    let node = this.read(this.rootPage);
    while (node.type === INTERNAL) {
      const k = this.childIndex(node, key);
      path.push({ node, k });
      node = this.read(node.children[k]);
    }

    const pos = node.entries.findIndex((e) => e.key >= key);
    if (pos !== -1 && node.entries[pos].key === key) {
      node.entries[pos].value = value;
      this.fm.writePage(node.pageNum, serializeLeaf(node));
      return;
    }
    const insertAt = pos === -1 ? node.entries.length : pos;
    node.entries.splice(insertAt, 0, { key, value });

    let split = null;
    if (node.entries.length > MAX_ENTRIES) {
      const mid = Math.floor(node.entries.length / 2);
      const right = { type: LEAF, pageNum: this.fm.allocatePage(), entries: node.entries.slice(mid) };
      node.entries = node.entries.slice(0, mid);
      this.fm.writePage(node.pageNum, serializeLeaf(node));
      this.fm.writePage(right.pageNum, serializeLeaf(right));
      split = { sep: node.entries[node.entries.length - 1].key, left: node.pageNum, right };
    } else {
      this.fm.writePage(node.pageNum, serializeLeaf(node));
    }

    // Propagate splits up the tree (bottom-up).
    for (let i = path.length - 1; i >= 0 && split; i--) {
      const { node: parent, k } = path[i];
      parent.seps.splice(k, 0, split.sep);
      parent.children.splice(k + 1, 0, split.right.pageNum);
      this.fm.writePage(parent.pageNum, serializeInternal(parent));

      if (parent.seps.length > MAX_ENTRIES) {
        const n = parent.seps.length;
        const m = Math.floor(n / 2);
        const left = { type: INTERNAL, pageNum: parent.pageNum, seps: parent.seps.slice(0, m), children: parent.children.slice(0, m + 1) };
        const right = { type: INTERNAL, pageNum: this.fm.allocatePage(), seps: parent.seps.slice(m + 1), children: parent.children.slice(m + 1) };
        this.fm.writePage(left.pageNum, serializeInternal(left));
        this.fm.writePage(right.pageNum, serializeInternal(right));
        split = { sep: parent.seps[m], left: left.pageNum, right };
        continue;
      }
      split = null;
    }

    if (split) {
      // Root split: new root above the old root and the new right page.
      this.rootPage = this.fm.allocatePage();
      const newRoot = { type: INTERNAL, pageNum: this.rootPage, seps: [split.sep], children: [split.left, split.right.pageNum] };
      this.fm.writePage(newRoot.pageNum, serializeInternal(newRoot));
    }
  }

  /** Ascending scan. `filter(key, value)` may drop entries. */
  *scan(filter = null) {
    const stack = [this.rootPage];
    while (stack.length) {
      const node = this.read(stack.pop());
      if (node.type === INTERNAL) {
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      } else {
        for (const e of node.entries) {
          if (!filter || filter(e.key, e.value)) yield { key: e.key, value: e.value };
        }
      }
    }
  }

  stats() {
    let pageCount = 0,
      entryCount = 0,
      depth = 0;
    const walk = (pageNum, d) => {
      pageCount++;
      depth = Math.max(depth, d);
      const node = this.read(pageNum);
      if (node.type === INTERNAL) for (const c of node.children) walk(c, d + 1);
      else entryCount += node.entries.length;
    };
    walk(this.rootPage, 0);
    return { pageCount, entryCount, depth };
  }
}
