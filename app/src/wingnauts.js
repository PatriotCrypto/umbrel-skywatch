// Read-only Wingnauts lookup. Finds Wingnauts NFTs held by a public Solana wallet
// address using the DAS API (getAssetsByOwner). Nothing is signed and no keys are used.
import fs from 'node:fs/promises';
import path from 'node:path';

export const WINGNAUTS_COLLECTION = '8Rkh8zZDprVkt652krE5C2iJUCxarEU49WZbwZj1YtEM';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isWallet(s) { return BASE58.test(String(s || '')); }

export class Wingnauts {
  constructor(dataDir, { fetchImpl = globalThis.fetch } = {}) {
    this.dir = path.join(dataDir, 'wingnauts');
    this.file = path.join(this.dir, 'collection.json');
    this.fetch = fetchImpl;
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    try { this.cache = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { this.cache = { items: [], fetchedAt: 0, wallet: '' }; }
    return this.cache;
  }

  async refresh({ wallet, rpc }) {
    if (!isWallet(wallet)) throw new Error('That does not look like a Solana wallet address.');
    if (!/^https:\/\//.test(rpc || '')) throw new Error('Add a Solana RPC URL that supports the DAS API (for example a free Helius endpoint).');
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.fetch(rpc, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 'skywatch', method: 'getAssetsByOwner', params: { ownerAddress: wallet, page, limit: 1000 } }),
      });
      if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`RPC error: ${json.error.message || 'unknown'}`);
      const list = json.result?.items || [];
      for (const it of list) {
        const inCollection = (it.grouping || []).some((g) => g.group_key === 'collection' && g.group_value === WINGNAUTS_COLLECTION);
        if (!inCollection) continue;
        const md = it.content?.metadata || {};
        const attrs = Array.isArray(md.attributes) ? md.attributes : [];
        const rarityAttr = attrs.find((x) => /rarity/i.test(x.trait_type || ''));
        const image = it.content?.links?.image || it.content?.files?.find((f) => /image/.test(f.mime || ''))?.uri || it.content?.files?.[0]?.uri || null;
        items.push({
          id: it.id, name: md.name || 'Wingnaut', image,
          rarity: rarityAttr ? String(rarityAttr.value) : null,
          traits: attrs.filter((x) => x !== rarityAttr).slice(0, 8).map((x) => ({ k: String(x.trait_type), v: String(x.value) })),
        });
      }
      if (list.length < 1000) break;
    }
    await fs.mkdir(this.dir, { recursive: true });
    for (const it of items) {
      it.local = await this.cacheImage(it).catch(() => false);
    }
    this.cache = { items, fetchedAt: Date.now(), wallet };
    await fs.writeFile(this.file, JSON.stringify(this.cache));
    return this.cache;
  }

  async cacheImage(it) {
    if (!it.image || !/^https?:\/\//.test(it.image)) return false;
    const res = await this.fetch(it.image, { signal: AbortSignal.timeout(20000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\/(png|jpe?g|gif|webp)/.test(type)) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return false;
    await fs.writeFile(this.imagePath(it.id), buf);
    return type.split(';')[0].trim();
  }

  imagePath(id) { return path.join(this.dir, `${String(id).replace(/[^A-Za-z0-9]/g, '')}.img`); }

  async clear() {
    this.cache = { items: [], fetchedAt: 0, wallet: '' };
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}
