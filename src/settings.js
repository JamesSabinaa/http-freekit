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
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(raw);
      }
    } catch (err) {
      console.error('[Settings] Failed to load settings:', err.message);
      this.data = {};
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[Settings] Failed to save settings:', err.message);
    }
  }

  get(key, defaultValue) {
    return this.data[key] !== undefined ? this.data[key] : defaultValue;
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  getAll() {
    return { ...this.data };
  }

  setAll(obj) {
    Object.assign(this.data, obj);
    this._save();
  }
}
