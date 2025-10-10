/* TgAlbumsApp

This version no longer relies on TgFileService having getChat/setChatDescription.
Instead, it calls Telegram Bot API methods directly using the service's botToken and chatId.

Requires TgFileService instance with:
- constructor(botToken, chatId)
- putFile(blob) -> Promise<string>
- getFile(fileId, name, mime) -> Promise<{name, type, blob}>
*/

class TgAlbumsApp {
  constructor(service) {
    if (!service) throw new Error('TgFileService instance required');
    this.service = service;
    this.botToken = service.botToken;
    this.chatId = service.chatId;
    this.root = [];
    this.rootFileId = null;
    this._ready = this._init();
  }

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

  async getChat() {
    return this._callTelegram('getChat', { chat_id: this.chatId });
  }

  async setChatDescription(desc) {
    return this._callTelegram('setChatDescription', { chat_id: this.chatId, description: desc });
  }

  async ready() { return this._ready; }

  async _init() {
    const chat = await this.getChat();
    const desc = (chat && chat.description) ? chat.description.trim() : '';
    if (!desc) {
      await this._createEmptyRoot();
      return;
    }
    try {
      await this._loadRootFromFileId(desc);
    } catch (e) {
      console.warn('Failed to load root file from chat description:', e);
      await this._createEmptyRoot();
    }
  }

  async _createEmptyRoot() {
    this.root = [];
    const blob = new Blob([JSON.stringify(this.root)], { type: 'application/json' });
    const fileId = await this.service.putFile(blob);
    this.rootFileId = fileId;
    await this.setChatDescription(fileId);
  }

  async _loadRootFromFileId(fileId) {
    const res = await this.service.getFile(fileId, 'albums.json', 'application/json');
    const text = await res.blob.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Root file JSON must be array');
    for (const a of parsed) {
      if (typeof a.name !== 'string' || typeof a.albumFileId !== 'string') throw new Error('Invalid album entry');
    }
    this.root = parsed.sort((x, y) => x.name.localeCompare(y.name));
    this.rootFileId = fileId;
  }

  async _saveRootCascade() {
    const blob = new Blob([JSON.stringify(this.root)], { type: 'application/json' });
    const newFileId = await this.service.putFile(blob);
    this.rootFileId = newFileId;
    await this.setChatDescription(newFileId);
  }

  async createAlbum(name) {
    await this.ready();
    if (!name || typeof name !== 'string') throw new Error('Name required');
    if (this.root.find(a => a.name === name)) throw new Error('Album already exists');
    const albumBlob = new Blob([JSON.stringify([])], { type: 'application/json' });
    const albumFileId = await this.service.putFile(albumBlob);
    const albumEntry = { name, thumbFileId: null, albumFileId };
    this.root.push(albumEntry);
    this.root.sort((x, y) => x.name.localeCompare(y.name));
    await this._saveRootCascade();
    return new Album(this.service, albumFileId, name, this);
  }

  async getAlbums() {
    await this.ready();
    return this.root.map(a => new Album(this.service, a.albumFileId, a.name, this, a.thumbFileId));
  }

  async findAlbumByFileId(fileId) {
    await this.ready();
    const entry = this.root.find(a => a.albumFileId === fileId);
    return entry ? new Album(this.service, entry.albumFileId, entry.name, this, entry.thumbFileId) : null;
  }

  async findAlbumByName(name) {
    await this.ready();
    const entry = this.root.find(a => a.name === name);
    return entry ? new Album(this.service, entry.albumFileId, entry.name, this, entry.thumbFileId) : null;
  }

  async deleteAllAlbums() {
    await this.ready();
    this.root = [];
    await this._saveRootCascade();
  }

  async _updateAlbumDescriptorByFileId(oldAlbumFileId, changes) {
    const idx = this.root.findIndex(a => a.albumFileId === oldAlbumFileId);
    if (idx === -1) throw new Error('Album not found in root');
    this.root[idx] = Object.assign({}, this.root[idx], changes);
    this.root.sort((x, y) => x.name.localeCompare(y.name));
    await this._saveRootCascade();
  }
}


class Album {
  constructor(service, albumFileId, name, app, thumbFileId=null) {
    this.service = service;
    this.app = app; // reference to TgAlbumsApp for cascade updates
    this.name = name;
    this.albumFileId = albumFileId;
    this.thumbFileId = thumbFileId;
    this.files = []; // loaded files [{ name, mime, thumbFileId, screenFileId, fullFileId }]
    this._loaded = this._load();
  }

  async ready() { return this._loaded; }

  async _load() {
    const res = await this.service.getFile(this.albumFileId, `${this.name}.json`, 'application/json');
    if (!res || !res.blob) throw new Error('Failed to load album file');
    const text = await res.blob.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Album file must be array');
    // validate entries
    for (const f of parsed) {
      if (typeof f.name !== 'string' || typeof f.fullFileId !== 'string') {
        throw new Error('Invalid file entry in album');
      }
    }
    this.files = parsed.slice().sort((x,y)=> x.name.localeCompare(y.name));
  }

  // helper resize using canvas — returns Blob
  static async _resizeBlob(inputBlob, maxW, maxH, mime) {
    mime = mime || inputBlob.type || 'image/png';
    // create image bitmap
    const imgBitmap = await createImageBitmap(inputBlob);
    const iw = imgBitmap.width;
    const ih = imgBitmap.height;
    let w = iw;
    let h = ih;
    // fit into box preserving aspect ratio
    const ratio = Math.min(1, Math.min(maxW / iw, maxH / ih));
    w = Math.max(1, Math.round(iw * ratio));
    h = Math.max(1, Math.round(ih * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgBitmap, 0, 0, w, h);
    // convert to blob, try to keep mime (jpeg/webp) if possible
    return await new Promise(resolve => canvas.toBlob(resolve, mime));
  }

  // return array of file descriptors
  async getFiles() {
    await this.ready();
    return this.files.map(f => Object.assign({}, f));
  }

  // adds multiple files; items: array of [Blob, name, mime]
  // must cascade update after each file added
  async addFiles(items) {
    await this.ready();
    if (!Array.isArray(items)) throw new Error('items must be array of [Blob,name,mime]');
    for (const item of items) {
      const [blob, name, mime] = item;
      if (!blob || !name) throw new Error('Each item must be [Blob,name,mime]');
      // upload original full-size file
      const fullFileId = await this.service.putFile(blob);
      // create thumbnail 150x150 and screen 1920x1080
      const thumbBlob = await Album._resizeBlob(blob, 150, 150, mime);
      const screenBlob = await Album._resizeBlob(blob, 1920, 1080, mime);
      const thumbFileId = await this.service.putFile(thumbBlob);
      const screenFileId = await this.service.putFile(screenBlob);
      // create file entry
      const fileEntry = { name, mime: mime || blob.type || 'application/octet-stream', thumbFileId, screenFileId, fullFileId };
      this.files.push(fileEntry);
      this.files.sort((x,y)=> x.name.localeCompare(y.name));
      // save album file to Telegram -> gets new albumFileId
      await this._saveAlbumCascade();
    }
  }

  async _saveAlbumCascade() {
    // upload updated album JSON
    const albumBlob = new Blob([JSON.stringify(this.files)], { type: 'application/json' });
    const newAlbumFileId = await this.service.putFile(albumBlob);
    // update albumFileId in this instance
    const oldAlbumFileId = this.albumFileId;
    this.albumFileId = newAlbumFileId;
    // update root entry via app
    await this.app._updateAlbumDescriptorByFileId(oldAlbumFileId, { albumFileId: newAlbumFileId, thumbFileId: this._deriveThumbFileId() });
  }

  _deriveThumbFileId() {
    // choose first file thumb as album thumb if present
    if (this.files.length === 0) return null;
    return this.files[0].thumbFileId || null;
  }

  async findFileByFullId(fullId) {
    await this.ready();
    const entry = this.files.find(f => f.fullFileId === fullId);
    if (!entry) return null;
    return new AlbumFile(this, entry);
  }

  async findFileByName(name) {
    await this.ready();
    const entry = this.files.find(f => f.name === name);
    if (!entry) return null;
    return new AlbumFile(this, entry);
  }

  async deleteThumbnailForFile(fullId) {
    await this.ready();
    const idx = this.files.findIndex(f => f.fullFileId === fullId);
    if (idx === -1) throw new Error('File not found');
    this.files[idx].thumbFileId = null;
    await this._saveAlbumCascade();
  }

  async clear() {
    await this.ready();
    this.files = [];
    await this._saveAlbumCascade();
  }

  async deleteAlbum() {
    await this.ready();
    // Remove from root and cascade save on root
    // Note: We cannot delete file objects on Telegram; we simply remove album entry.
    const root = this.app.root;
    const idx = root.findIndex(a => a.albumFileId === this.albumFileId || a.name === this.name);
    if (idx !== -1) {
      root.splice(idx, 1);
      this.app.root = root.sort((x,y)=> x.name.localeCompare(y.name));
      await this.app._saveRootCascade();
    }
  }
}


class AlbumFile {
  constructor(album, descriptor) {
    this.album = album;
    this.descriptor = descriptor; // { name, mime, thumbFileId, screenFileId, fullFileId }
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

  // set this file's thumbnail as album thumbnail
  async setAsAlbumThumbnail() {
    this.album.files = this.album.files.map(f => Object.assign({}, f));
    const target = this.album.files.find(f => f.fullFileId === this.descriptor.fullFileId);
    if (!target) throw new Error('File not found in album');
    this.album.thumbFileId = target.thumbFileId || null;
    await this.album._saveAlbumCascade();
  }

  // remove from album
  async removeFromAlbum() {
    this.album.files = this.album.files.filter(f => f.fullFileId !== this.descriptor.fullFileId);
    await this.album._saveAlbumCascade();
  }

  // add to another album by targetAlbumFileId (the album's file id)
  async addToAlbum(targetAlbumFileId) {
    // find target album in app
    const targetEntry = this.album.app.root.find(a => a.albumFileId === targetAlbumFileId);
    if (!targetEntry) throw new Error('Target album not found');
    const targetAlbum = new Album(this.album.service, targetEntry.albumFileId, targetEntry.name, this.album.app, targetEntry.thumbFileId);
    await targetAlbum.ready();
    // Copy descriptors; we can reuse existing file ids (thumb/screen/full) as Telegram stores the files.
    const copy = Object.assign({}, this.descriptor);
    targetAlbum.files.push(copy);
    targetAlbum.files.sort((x,y)=> x.name.localeCompare(y.name));
    await targetAlbum._saveAlbumCascade();
  }
}

/*
USAGE EXAMPLES

// Assume service is created outside using
// const service = new TgFileService('BOT_TOKEN', 'CHAT_ID');

(async () => {
  const app = new TgAlbumsApp(service);
  await app.ready();

  // Create an album
  const album = await app.createAlbum('Vacations');
  await album.ready();

  // Add files to album: items = [[Blob, 'name.jpg', 'image/jpeg'], ...]
  const fileBlob = new Blob([], { type: 'image/jpeg' });
  await album.addFiles([[fileBlob, 'beach.jpg', 'image/jpeg']]);

  // List albums
  const albums = await app.getAlbums();
  console.log('Albums:', albums.map(a => a.name));

  // Find album by name
  const found = await app.findAlbumByName('Vacations');
  console.log('Found album:', found.name);

  // List files
  const files = await found.getFiles();
  console.log('Files in album:', files.map(f => f.name));

  // Find file by name
  const fileObj = await found.findFileByName('beach.jpg');
  if (fileObj) {
    // Download full blob
    const full = await fileObj.getFullBlob();
    // Download thumbnail
    const thumb = await fileObj.getThumbBlob();
    // Set as album thumbnail
    await fileObj.setAsAlbumThumbnail();
    // Remove from album
    // await fileObj.removeFromAlbum();
  }

  // Delete album
  // await found.deleteAlbum();

  // Delete all albums
  // await app.deleteAllAlbums();
})();
*/
