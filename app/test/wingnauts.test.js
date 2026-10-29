import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wingnauts, WINGNAUTS_COLLECTION, isWallet } from '../src/wingnauts.js';

test('finds only Wingnauts in a wallet and caches their art', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3c2d8a40000000049454e44ae426082', 'hex');
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body });
    if (String(url).startsWith('https://rpc.example')) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'skywatch', result: { total: 3, limit: 1000, page: 1, items: [
        { id: 'H2pY1x4nPEeEpxPny7Cg4xmfZ66F1BL7SBJKhNYRu5tc', interface: 'MplCoreAsset', grouping: [{ group_key: 'collection', group_value: WINGNAUTS_COLLECTION }],
          content: { metadata: { name: 'Wingnaut #1298', attributes: [{ trait_type: 'Rarity', value: 'Uncommon' }, { trait_type: 'Hat', value: 'Tricorn' }] }, links: { image: 'https://img.example/1298.png' } } },
        { id: 'OTHER', grouping: [{ group_key: 'collection', group_value: 'SomethingElse111111111111111111111' }], content: { metadata: { name: 'Not a Wingnaut' } } },
        { id: '4ASL9MEvjAs6tVzL2ctL2VHnj5nZ4pSSdKbAiTV8JRyu', grouping: [{ group_key: 'collection', group_value: WINGNAUTS_COLLECTION }],
          content: { metadata: { name: 'Wingnaut #4076', attributes: [] }, files: [{ uri: 'https://img.example/4076.png', mime: 'image/png' }] } },
      ] } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  const wn = new Wingnauts(dir, { fetchImpl });
  const res = await wn.refresh({ wallet: '41oP6ELHN7HsrshBBnbM5T9DnFyA4pbe2Hw9t8ZBSeBe', rpc: 'https://rpc.example/?api-key=x' });
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].name, 'Wingnaut #1298');
  assert.equal(res.items[0].rarity, 'Uncommon');
  assert.equal(res.items[0].local, 'image/png');
  assert.ok(fs.existsSync(wn.imagePath(res.items[1].id)));
  const rpcBody = JSON.parse(calls[0].body);
  assert.equal(rpcBody.method, 'getAssetsByOwner');
  assert.equal(rpcBody.params.ownerAddress, '41oP6ELHN7HsrshBBnbM5T9DnFyA4pbe2Hw9t8ZBSeBe');
});

test('rejects things that are not wallet addresses', async () => {
  assert.equal(isWallet('41oP6ELHN7HsrshBBnbM5T9DnFyA4pbe2Hw9t8ZBSeBe'), true);
  assert.equal(isWallet('0xabc'), false);
  const wn = new Wingnauts(fs.mkdtempSync(path.join(os.tmpdir(), 'wn-')));
  await assert.rejects(wn.refresh({ wallet: 'nope', rpc: 'https://x' }), /wallet/);
  await assert.rejects(wn.refresh({ wallet: '41oP6ELHN7HsrshBBnbM5T9DnFyA4pbe2Hw9t8ZBSeBe', rpc: '' }), /RPC/);
});
