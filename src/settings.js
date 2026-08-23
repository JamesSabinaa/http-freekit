import fs from 'fs';
import path from 'path';

/**
 * Persistent settings manager.
 * Saves settings as JSON to a file in the data directory.
 */
export class Settings {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'settings.json');
    this.data = {};
    this.loadError = null;
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;

    let parsed;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('Settings file must contain a JSON object');
      }
    } catch (err) {
      console.error('[Settings] Failed to load settings:', err.message);
      this.data = {};
      this.loadError = new Error(
        `Settings cannot be saved because "${this.filePath}" could not be loaded: ${err.message}. ` +
        'Repair or replace the settings file before trying again.',
        { cause: err }
      );
      return;
    }

    this._hardenExistingFilePermissions();
    this.data = parsed;
  }

  _platform() {
    return process.platform;
  }

  _hardenExistingFilePermissions() {
    if (this._platform() === 'win32') return;
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      throw new Error(
        `Could not secure existing settings file "${this.filePath}" for owner-only access: ` +
        `${error.message}. Check that the file is owned by the current user and its permissions can be changed.`
      );
    }
  }

  _save() {
    if (this.loadError) throw this.loadError;
    const tempPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      console.error('[Settings] Failed to save settings:', err.message);
      throw err;
    }
  }

  get(key, defaultValue) {
    return this.data[key] !== undefined ? this.data[key] : defaultValue;
  }

  set(key, value) {
    const previousData = this.data;
    this.data = { ...this.data, [key]: value };
    try {
      this._save();
    } catch (err) {
      this.data = previousData;
      throw err;
    }
  }

  getAll() {
    return { ...this.data };
  }

  setAll(obj) {
    const previousData = this.data;
    this.data = { ...this.data, ...obj };
    try {
      this._save();
    } catch (err) {
      this.data = previousData;
      throw err;
    }
  }
}
