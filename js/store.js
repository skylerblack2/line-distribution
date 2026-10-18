let dbPromise = null;
function db() {
  dbPromise = dbPromise || new Promise((res, rej) => {
    const rq = indexedDB.open("linedist2", 1);
    rq.onupgradeneeded = () => {
      for (const name of ["projects", "audio", "peaks"]) rq.result.createObjectStore(name);
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbPromise;
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const rq = fn(tx.objectStore(store));
    tx.oncomplete = () => res(rq && rq.result);
    tx.onerror = () => rej(tx.error);
  });
}

export const peaksCache = {
  get: key => idb("peaks", "readonly", s => s.get(key)).catch(() => null),
  set: (key, val) => idb("peaks", "readwrite", s => s.put(val, key)).catch(() => {}),
};

function summary(id, p, updated) {
  return {
    id, updated,
    group: p.song.group, title: p.song.title, artist: p.song.artist,
    members: p.members.length, segments: p.segments.length,
  };
}

const browserStore = {
  kind: "browser",
  async list() {
    const rows = [];
    await idb("projects", "readonly", s => {
      const rq = s.openCursor();
      rq.onsuccess = () => {
        const c = rq.result;
        if (!c) return;
        rows.push(summary(c.key, c.value.project, c.value.updated));
        c.continue();
      };
    });
    return rows.sort((a, b) => b.updated - a.updated);
  },
  async load(id) {
    const rec = await idb("projects", "readonly", s => s.get(id));
    return rec ? rec.project : null;
  },
  save(id, project) {
    return idb("projects", "readwrite", s => s.put({ project, updated: Date.now() / 1000 }, id));
  },
  async remove(id) {
    await idb("projects", "readwrite", s => s.delete(id));
    await idb("audio", "readwrite", s => s.delete(id));
  },
  async getAudio(id) {
    const rec = await idb("audio", "readonly", s => s.get(id));
    return rec ? rec.blob : null;
  },
  putAudio(id, name, blob) {
    return idb("audio", "readwrite", s => s.put({ name, blob }, id));
  },
};

const api = "api/projects";
const serverStore = {
  kind: "server",
  list: () => fetch(api).then(r => r.json()),
  async load(id) {
    const r = await fetch(`${api}/${id}`);
    return r.ok ? r.json() : null;
  },
  async save(id, project) {
    const r = await fetch(`${api}/${id}`, { method: "PUT", body: JSON.stringify(project) });
    if (!r.ok) throw new Error("save failed");
  },
  remove: id => fetch(`${api}/${id}`, { method: "DELETE" }),
  async getAudio(id) {
    const r = await fetch(`${api}/${id}/audio`);
    return r.ok ? r.blob() : null;
  },
  async putAudio(id, name, blob) {
    const r = await fetch(`${api}/${id}/audio?name=${encodeURIComponent(name)}`, { method: "PUT", body: blob });
    if (!r.ok) throw new Error("audio save failed");
  },
};

// Uses the file-backed library when server.py is serving the app, otherwise IndexedDB.
export async function openStore() {
  try {
    const r = await fetch(api);
    if (r.ok && (r.headers.get("Content-Type") || "").includes("json")) return serverStore;
  } catch (e) {}
  return browserStore;
}

export function slug(text) {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
