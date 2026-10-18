// IndexedDB storage: projects (song + members + segments) and audio in separate stores.

const DB_NAME = "line-dist-v2";
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        db.createObjectStore("projects", { keyPath: "id" });
        db.createObjectStore("audio"); // key = project id -> {name, blob, onsets, peaks}
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  return dbPromise;
}

function run(stores, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const tx = db.transaction(stores, mode);
    const rq = fn(tx);
    tx.oncomplete = () => res(rq ? rq.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}

export const db = {
  allProjects: () => run("projects", "readonly", tx => tx.objectStore("projects").getAll()),
  getProject: id => run("projects", "readonly", tx => tx.objectStore("projects").get(id)),
  putProject: p => run("projects", "readwrite", tx => tx.objectStore("projects").put(p)),
  deleteProject: id => run(["projects", "audio"], "readwrite", tx => {
    tx.objectStore("projects").delete(id);
    tx.objectStore("audio").delete(id);
  }),
  getAudio: id => run("audio", "readonly", tx => tx.objectStore("audio").get(id)),
  putAudio: (id, rec) => run("audio", "readwrite", tx => tx.objectStore("audio").put(rec, id)),
  deleteAudio: id => run("audio", "readwrite", tx => tx.objectStore("audio").delete(id)),
};

// v1 stored one song in localStorage and its audio in a separate database.
export function readV1Audio() {
  return new Promise(res => {
    let rq;
    try { rq = indexedDB.open("line-dist-audio", 1); } catch (e) { return res(null); }
    rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
    rq.onerror = () => res(null);
    rq.onsuccess = () => {
      try {
        const g = rq.result.transaction("kv").objectStore("kv").get("current");
        g.onsuccess = () => res(g.result || null);
        g.onerror = () => res(null);
      } catch (e) { res(null); }
    };
  });
}
