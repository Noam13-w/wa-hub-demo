import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { logger } from '../logger.js';

const log = logger.child({ mod: 'baileys.auth' });

/**
 * Drop-in replacement for Baileys' useMultiFileAuthState with three robustness
 * fixes the bundled version lacks (it does a plain `writeFile`):
 *
 *   1. ATOMIC writes — write to `<file>.tmp` then `rename()` over the target.
 *      rename() is atomic on a POSIX filesystem, so a crash/OOM mid-write can
 *      never leave a half-written, unparseable file. The bundled version's torn
 *      `creds.json` would be silently read as "no creds" → a forced re-pair.
 *   2. A rolling BACKUP of creds.json (`creds.json.bak`) written before each
 *      overwrite, so even a catastrophic loss of the primary has a fallback.
 *   3. REFUSE to treat a present-but-corrupt creds.json as missing. If the file
 *      exists but won't parse, we try the .bak; only if BOTH are unusable do we
 *      mint fresh creds — and we log loudly, because that means a real re-pair.
 *
 * Same on-disk format and same returned shape as the library, so it is a
 * transparent swap. See node_modules/@whiskeysockets/baileys/lib/Utils/
 * use-multi-file-auth-state.js for the original.
 */
export async function useAtomicMultiFileAuthState(folder) {
  await mkdir(folder, { recursive: true });

  const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
  const pathFor = (file) => join(folder, fixFileName(file));

  // Serialize writes to the same file so two overlapping saves can't interleave
  // their temp-file/rename steps. Keyed per file path.
  const locks = new Map();
  const withLock = async (key, fn) => {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    locks.set(key, prev.then(() => next));
    await prev.catch(() => {});
    try { return await fn(); }
    finally {
      release();
      if (locks.get(key) === next) locks.delete(key);
    }
  };

  const atomicWrite = async (filePath, contents) => {
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, contents);
    await rename(tmp, filePath); // atomic replace on the same filesystem
  };

  const writeData = (data, file) => withLock(file, async () => {
    const filePath = pathFor(file);
    const contents = JSON.stringify(data, BufferJSON.replacer);
    // Keep a backup of the previous creds.json before clobbering it.
    if (file === 'creds.json') {
      try {
        const prev = await readFile(filePath, 'utf-8');
        await atomicWrite(`${filePath}.bak`, prev);
      } catch { /* no prior file yet — nothing to back up */ }
    }
    await atomicWrite(filePath, contents);
  });

  const readJson = async (filePath) => {
    const data = await readFile(filePath, { encoding: 'utf-8' });
    return JSON.parse(data, BufferJSON.reviver);
  };

  const readData = async (file) => {
    try {
      return await readJson(pathFor(file));
    } catch {
      return null;
    }
  };

  const removeData = (file) => withLock(file, async () => {
    try { await unlink(pathFor(file)); } catch { /* already gone */ }
  });

  // Load creds, surviving a corrupt primary by falling back to the backup.
  const loadCreds = async () => {
    const filePath = pathFor('creds.json');
    let raw;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      return initAuthCreds(); // genuinely absent → fresh identity (first pairing)
    }
    try {
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      log.error('creds.json is present but unparseable — trying creds.json.bak');
      try {
        return await readJson(`${filePath}.bak`);
      } catch {
        log.error('creds.json.bak also unusable — minting NEW creds (a re-pair is required)');
        return initAuthCreds();
      }
    }
  };

  const creds = await loadCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}
