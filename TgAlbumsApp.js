class TgAlbumsApp {
  constructor(service) {
    if (!service) throw new Error('TgFileService instance required');
    this.service = service;
    this.botToken = service.botToken;
    this.chatId = service.chatId;
    this.root = []; // array of { name, thumbFileId, albumFileId, albumId }
    this.rootFileId = null;
    this._ready = this._init();
  }

  async ready() { return this._ready; }

  // --- Telegram API helpers ---
  async _callTelegram(method, body) {
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram API error: ${json.description}`);
    return json.result;
  }

  async _getChat() { return this._callTelegram('getChat', { chat_id: this.chatId }); }
  async _setChatDescription(desc) { return this._callTelegram('setChatDescription', { chat_id: this.chatId, description: desc }); }

  // --- utilities ---
  static _makeAlbumId() {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const pick = () => letters[Math.floor(Math.random() * letters.length)];
    const three = Array.from({ length: 3 }, () => (Math.random() < 0.5 ? pick().toUpperCase() : pick())).join('');
    return 'a' + Date.now() + three;
  }

  // --- initialization ---
  async _init() {
    try {
      const chat = await this._getChat();
      const desc = (chat && chat.description) ? chat.description.trim() : '';
      if (!desc) {
        await this._createEmptyRoot();
      } else {
        try {
          await this._loadRootFromFileId(desc);
        } catch (e) {
          console.warn('Failed to load root file from chat description:', e);
          await this._createEmptyRoot();
        }
      }
      // ensure Trash album exists and is undeletable
      const trash = this.root.find(a => a.name === 'Trash');
      if (!trash) {
        console.log('Creating missing Trash album');
        const albumId = TgAlbumsApp._makeAlbumId();
        const albumBlob = new Blob([JSON.stringify([])], { type: 'application/json' });
        const albumFileId = await this.service.putFile(albumBlob);
        const entry = { name: 'Trash', thumbFileId: null, albumFileId, albumId };
        this.root.push(entry);
        this.root.sort((a, b) => a.name.localeCompare(b.name));
        await this._saveRootCascade();
      }
    } catch (e) {
      console.error('Initialization error:', e);
      // propagate
      throw e;
    }
  }

  async _createEmptyRoot() {
    this.root = [];
    const blob = new Blob([JSON.stringify(this.root)], { type: 'application/json' });
    const fileId = await this.service.putFile(blob);
    this.rootFileId = fileId;
    await this._setChatDescription(fileId);
  }

  async _loadRootFromFileId(fileId) {
    const res = await this.service.getFile(fileId, 'albums.json', 'application/json');
    if (!res || !res.blob) throw new Error('No root file blob');
    const text = await res.blob.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Root file JSON must be array');
    for (const a of parsed) {
      if (typeof a.name !== 'string' || typeof a.albumFileId !== 'string' || typeof a.albumId !== 'string') {
        throw new Error('Invalid album entry');
      }
    }
    this.root = parsed.slice().sort((x, y) => x.name.localeCompare(y.name));
    this.rootFileId = fileId;
  }

  async _saveRootCascade() {
    const blob = new Blob([JSON.stringify(this.root)], { type: 'application/json' });
    const newFileId = await this.service.putFile(blob);
    this.rootFileId = newFileId;
    await this._setChatDescription(newFileId);
  }

  // --- Album API ---
  // createAlbum returns Album instance and also { ok:true } is returned by side-effect methods
  async createAlbum(name) {
    await this.ready();
    try {
      if (!name || typeof name !== 'string') throw new Error('Name required');
      // duplicate names allowed, but albumId must be unique
      const albumId = TgAlbumsApp._makeAlbumId();
      const albumBlob = new Blob([JSON.stringify([])], { type: 'application/json' });
      const albumFileId = await this.service.putFile(albumBlob);
      const albumEntry = { name, thumbFileId: null, albumFileId, albumId };
      this.root.push(albumEntry);
      this.root.sort((x, y) => x.name.localeCompare(y.name));
      await this._saveRootCascade();
      return { ok: true, album: new Album(this.service, albumFileId, name, this, albumEntry.thumbFileId, albumId) };
    } catch (e) {
      console.error('createAlbum error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }

  async getAlbums() {
    await this.ready();
    return this.root.map(a => new Album(this.service, a.albumFileId, a.name, this, a.thumbFileId, a.albumId));
  }

  // find by constant albumId
  async findAlbumById(albumId) {
    await this.ready();
    const entry = this.root.find(a => a.albumId === albumId);
    return entry ? new Album(this.service, entry.albumFileId, entry.name, this, entry.thumbFileId, entry.albumId) : null;
  }

  // returns array of albums matching name (duplicates allowed)
  async findAlbumsByName(name) {
    await this.ready();
    const matches = this.root.filter(a => a.name === name);
    return matches.map(a => new Album(this.service, a.albumFileId, a.name, this, a.thumbFileId, a.albumId));
  }

  async deleteAllAlbums() {
    await this.ready();
    try {
      // preserve Trash (clear it instead)
      const trashIdx = this.root.findIndex(a => a.name === 'Trash');
      const trash = trashIdx !== -1 ? this.root.splice(trashIdx, 1)[0] : null;
      this.root = [];
      if (trash) this.root.push(trash);
      await this._saveRootCascade();
      return { ok: true };
    } catch (e) {
      console.error('deleteAllAlbums error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }

  // internal update
  async _updateAlbumDescriptorByFileId(oldAlbumFileId, changes) {
    const idx = this.root.findIndex(a => a.albumFileId === oldAlbumFileId);
    if (idx === -1) throw new Error('Album not found in root');
    this.root[idx] = Object.assign({}, this.root[idx], changes);
    this.root.sort((x, y) => x.name.localeCompare(y.name));
    await this._saveRootCascade();
  }

  async _updateAlbumDescriptorByAlbumId(albumId, changes) {
    const idx = this.root.findIndex(a => a.albumId === albumId);
    if (idx === -1) throw new Error('Album not found in root');
    this.root[idx] = Object.assign({}, this.root[idx], changes);
    this.root.sort((x, y) => x.name.localeCompare(y.name));
    await this._saveRootCascade();
  }
}

// --- Album class ---
class Album {
  constructor(service, albumFileId, name, app, thumbFileId = null, albumId = null) {
    this.service = service;
    this.app = app; // reference to TgAlbumsApp
    this.name = name;
    this.albumFileId = albumFileId;
    this.thumbFileId = thumbFileId;
    this.albumId = albumId; // constant id
    this.files = []; // [{ name, mime, thumbFileId, screenFileId, fullFileId, originalAlbumIds? }]
    this._loaded = this._load();
  }

  async ready() { return this._loaded; }

  async _load() {
    const res = await this.service.getFile(this.albumFileId, `${this.name}.json`, 'application/json');
    if (!res || !res.blob) throw new Error('Failed to load album file');
    const text = await res.blob.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Album file must be array');
    for (const f of parsed) {
      if (typeof f.name !== 'string' || typeof f.fullFileId !== 'string') {
        throw new Error('Invalid file entry in album');
      }
    }
    this.files = parsed.slice().sort((x, y) => x.name.localeCompare(y.name));
  }

  static async _resizeBlob(inputBlob, maxW, maxH, mime) {
    mime = mime || inputBlob.type || 'image/png';
    const imgBitmap = await createImageBitmap(inputBlob);
    const iw = imgBitmap.width;
    const ih = imgBitmap.height;
    const ratio = Math.min(1, Math.min(maxW / iw, maxH / ih));
    const w = Math.max(1, Math.round(iw * ratio));
    const h = Math.max(1, Math.round(ih * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgBitmap, 0, 0, w, h);
    return await new Promise(resolve => canvas.toBlob(resolve, mime));
  }

  async getFiles() {
    await this.ready();
    return this.files.map(f => Object.assign({}, f));
  }

  // addFiles: items = [[Blob,name,mime], ...]
  // returns { ok:true, warnings? }
  async addFiles(items) {
    await this.ready();
    const warnings = [];
    try {
      if (!Array.isArray(items)) throw new Error('items must be array of [Blob,name,mime]');
      for (const item of items) {
        const [blob, name, mime] = item;
        if (!blob || !name) {
          const msg = 'Each item must be [Blob,name,mime]'; console.warn(msg); warnings.push(msg); continue;
        }
        const theMime = mime || blob.type || '';
        if (!theMime.startsWith('image/') && !theMime.startsWith('video/')) {
          const msg = `Skipped unsupported MIME type for file "${name}": ${theMime}`;
          console.warn(msg);
          warnings.push(msg);
          continue; // skip uploading this file
        }
        // upload original full-size file
        const fullFileId = await this.service.putFile(blob);
        // create thumbnail 150x150 and screen 1920x1080 (for images only; for video we keep same blob as placeholder)
        let thumbBlob, screenBlob;
        try {
          thumbBlob = await Album._resizeBlob(blob, 150, 150, theMime);
        } catch (e) {
          console.warn('Thumbnail creation failed, using original blob as thumb:', e);
          thumbBlob = blob;
        }
        try {
          screenBlob = await Album._resizeBlob(blob, 1920, 1080, theMime);
        } catch (e) {
          console.warn('Screen resize failed, using original blob as screen:', e);
          screenBlob = blob;
        }
        const thumbFileId = await this.service.putFile(thumbBlob);
        const screenFileId = await this.service.putFile(screenBlob);
        const fileEntry = { name, mime: theMime, thumbFileId, screenFileId, fullFileId, originalAlbumIds: [this.albumId] };
        this.files.push(fileEntry);
        this.files.sort((x, y) => x.name.localeCompare(y.name));
        // save album file to Telegram -> cascade (generate new albumFileId and update root)
        await this._saveAlbumCascade();
      }
      const result = { ok: true };
      if (warnings.length) { result.warnings = warnings; }
      return result;
    } catch (e) {
      console.error('addFiles error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }

  async _saveAlbumCascade() {
    const albumBlob = new Blob([JSON.stringify(this.files)], { type: 'application/json' });
    const newAlbumFileId = await this.service.putFile(albumBlob);
    const oldAlbumFileId = this.albumFileId;
    this.albumFileId = newAlbumFileId;
    try {
      await this.app._updateAlbumDescriptorByFileId(oldAlbumFileId, { albumFileId: newAlbumFileId, thumbFileId: this._deriveThumbFileId() });
    } catch (e) {
      // log but don't fail saving album itself
      console.error('Failed to update root after saving album:', e);
    }
  }

  _deriveThumbFileId() {
    if (this.files.length === 0) return null;
    return this.files[0].thumbFileId || null;
  }

  async findFileByFullId(fullId) {
    await this.ready();
    const entry = this.files.find(f => f.fullFileId === fullId);
    return entry ? new AlbumFile(this, entry) : null;
  }

  // returns array of AlbumFile instances matching name
  async findFilesByName(name) {
    await this.ready();
    const matches = this.files.filter(f => f.name === name);
    return matches.map(f => new AlbumFile(this, f));
  }

  async deleteThumbnailForFile(fullId) {
    await this.ready();
    try {
      const idx = this.files.findIndex(f => f.fullFileId === fullId);
      if (idx === -1) throw new Error('File not found');
      this.files[idx].thumbFileId = null;
      await this._saveAlbumCascade();
      return { ok: true };
    } catch (e) {
      console.error('deleteThumbnailForFile error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }

  async clear() {
    await this.ready();
    try {
      this.files = [];
      await this._saveAlbumCascade();
      return { ok: true };
    } catch (e) {
      console.error('clear album error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }

  async deleteAlbum() {
    await this.ready();
    try {
      if (this.name === 'Trash') {
        const msg = 'Trash album cannot be deleted';
        console.warn(msg);
        return { ok: false, errors: [msg] };
      }
      const root = this.app.root;
      const idx = root.findIndex(a => a.albumId === this.albumId);
      if (idx !== -1) {
        root.splice(idx, 1);
        this.app.root = root.sort((x, y) => x.name.localeCompare(y.name));
        await this.app._saveRootCascade();
      }
      return { ok: true };
    } catch (e) {
      console.error('deleteAlbum error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }
}

// --- AlbumFile class ---

class AlbumFile {
  constructor(album, descriptor) {
    this.album = album;
    this.descriptor = descriptor; // live reference from album.files
  }

  async getFullBlob() {
    return (await this.album.service.getFile(this.descriptor.fullFileId, this.descriptor.name, this.descriptor.mime)).blob;
  }

  async getThumbBlob() {
    if (!this.descriptor.thumbFileId) return null;
    return (await this.album.service.getFile(this.descriptor.thumbFileId, `thumb_${this.descriptor.name}`, this.descriptor.mime)).blob;
  }

  async getScreenBlob() {
    if (!this.descriptor.screenFileId) return null;
    return (await this.album.service.getFile(this.descriptor.screenFileId, `screen_${this.descriptor.name}`, this.descriptor.mime)).blob;
  }

  async getFullBlobURL() {
    return URL.createObjectURL(await this.getFullBlob());
  }

  async getThumbBlobURL() {
    return URL.createObjectURL(await this.getThumbBlob());
  }

  async getScreenBlobURL() {
    return URL.createObjectURL(await this.getScreenBlob());
  }

  async setAsAlbumThumbnail() {
    try {
      await this.album.ready();
      const target = this.album.files.find(f => f.fullFileId === this.descriptor.fullFileId);
      if (!target) throw new Error('File not found in album');
      this.album.thumbFileId = target.thumbFileId || null;
      await this.album._saveAlbumCascade();
      return { ok: true };
    } catch (e) {
      console.error('setAsAlbumThumbnail error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }

  async removeFromAlbum() {
    try {
      await this.album.ready();
      const fileIdx = this.album.files.findIndex(f => f.fullFileId === this.descriptor.fullFileId);
      if (fileIdx === -1) throw new Error('File not found in album');
      const fileEntry = this.album.files.splice(fileIdx, 1)[0];
      fileEntry.originalAlbumIds = fileEntry.originalAlbumIds || [];
      if (!fileEntry.originalAlbumIds.includes(this.album.albumId)) fileEntry.originalAlbumIds.push(this.album.albumId);
      const trashEntry = this.album.app.root.find(a => a.name === 'Trash');
      if (!trashEntry) throw new Error('Trash album not found');
      const trashAlbum = new Album(this.album.service, trashEntry.albumFileId, trashEntry.name, this.album.app, trashEntry.thumbFileId, trashEntry.albumId);
      await trashAlbum.ready();
      trashAlbum.files.push(fileEntry);
      trashAlbum.files.sort((x, y) => x.name.localeCompare(y.name));
      await trashAlbum._saveAlbumCascade();
      await this.album._saveAlbumCascade();
      return { ok: true };
    } catch (e) {
      console.error('removeFromAlbum error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }

  async restoreToAlbum() {
    try {
      await this.album.ready();
      if (this.album.name !== 'Trash') throw new Error('restoreToAlbum should be called on a file in Trash');
      const originalIds = this.descriptor.originalAlbumIds || [];
      if (!originalIds.length) throw new Error('No original album recorded');
      const targetAlbumId = originalIds[originalIds.length - 1];
      const targetEntry = this.album.app.root.find(a => a.albumId === targetAlbumId);
      if (!targetEntry) throw new Error('Original album not found');
      const targetAlbum = new Album(this.album.service, targetEntry.albumFileId, targetEntry.name, this.album.app, targetEntry.thumbFileId, targetEntry.albumId);
      await targetAlbum.ready();
      const idx = this.album.files.findIndex(f => f.fullFileId === this.descriptor.fullFileId);
      if (idx === -1) throw new Error('File not found in Trash');
      const fileEntry = this.album.files.splice(idx, 1)[0];
      fileEntry.originalAlbumIds = fileEntry.originalAlbumIds || [];
      targetAlbum.files.push(fileEntry);
      targetAlbum.files.sort((x, y) => x.name.localeCompare(y.name));
      await targetAlbum._saveAlbumCascade();
      await this.album._saveAlbumCascade();
      return { ok: true };
    } catch (e) {
      console.error('restoreToAlbum error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }

  // Updated to only remove file from current album
  async removeForever() {
    try {
      await this.album.ready();
      const idx = this.album.files.findIndex(f => f.fullFileId === this.descriptor.fullFileId);
      if (idx === -1) throw new Error('File not found in this album');
      this.album.files.splice(idx, 1);
      await this.album._saveAlbumCascade();
      return { ok: true };
    } catch (e) {
      console.error('removeForever error:', e);
      return { ok: false, errors: [String(e)] };
    }
  }
}

/*
USAGE EXAMPLES

(async () => {
  const service = new TgFileService('BOT_TOKEN', 'CHAT_ID');
  const app = new TgAlbumsApp(service);
  await app.ready();

  // Create an album
  const { ok, album, errors } = await app.createAlbum('Vacations');
  if (!ok) { console.error('Failed to create album', errors); return; }
  await album.ready();

  // Add files to album: items = [[Blob, 'name.jpg', 'image/jpeg'], ...]
  // Note: files with unsupported MIME will be skipped and produce warnings
  const imgBlob = new Blob([ ...image data... ], { type: 'image/jpeg' });
  const txtBlob = new Blob(['not an image'], { type: 'text/plain' });
  const addResult = await album.addFiles([[imgBlob, 'beach.jpg', 'image/jpeg'], [txtBlob, 'note.txt', 'text/plain']]);
  // addResult => { ok: true, warnings: ['Skipped unsupported MIME type ...'] }
  if (addResult.warnings) console.warn('Warnings:', addResult.warnings);

  // List albums
  const albums = await app.getAlbums();
  console.log('Albums:', albums.map(a => ({ name: a.name, albumId: a.albumId })));

  // Find albums by name (duplicates allowed)
  const vacs = await app.findAlbumsByName('Vacations');
  console.log('Found', vacs.length, 'albums named Vacations');

  // Find album by id
  const firstAlbum = await app.findAlbumById(vacs[0].albumId);

  // List files
  const files = await firstAlbum.getFiles();
  console.log('Files in album:', files.map(f => f.name));

  // Find files by name (may return multiple)
  const matchingFiles = await firstAlbum.findFilesByName('beach.jpg');
  if (matchingFiles.length) {
    const fileObj = matchingFiles[0];
    // Download full blob
    const full = await fileObj.getFullBlob();
    // Move to Trash
    const rm = await fileObj.removeFromAlbum();
    console.log('Removed to Trash:', rm);

    // Now restore (call restoreToAlbum on file in Trash)
    const albumsNow = await app.getAlbums();
    const trash = albumsNow.find(a => a.name === 'Trash');
    const trashFiles = await trash.getFiles();
    const trashed = trashFiles.find(f => f.fullFileId === fileObj.descriptor.fullFileId);
    const trashedObj = new AlbumFile(trash, trashed);
    const res = await trashedObj.restoreToAlbum();
    console.log('Restore result:', res);

    // Or remove forever
    // const del = await trashedObj.removeForever();
    // console.log('Removed forever:', del);
  }

  // Delete album (will fail for Trash)
  const delAlbumRes = await firstAlbum.deleteAlbum();
  console.log('Delete album:', delAlbumRes);

  // Delete all albums (preserves Trash)
  const delAll = await app.deleteAllAlbums();
  console.log('Delete all albums:', delAll);
})();
*/
