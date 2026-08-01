'use strict';

const fs = require('fs');
const path = require('path');

const CLOSE_WINDOW_BEHAVIORS = Object.freeze({
  HIDE: 'hide',
  QUIT: 'quit'
});
const DEFAULT_CLOSE_WINDOW_BEHAVIOR = CLOSE_WINDOW_BEHAVIORS.HIDE;
const DESKTOP_PREFERENCES_FILENAME = 'desktop-preferences.json';

function isCloseWindowBehavior(value) {
  return value === CLOSE_WINDOW_BEHAVIORS.HIDE || value === CLOSE_WINDOW_BEHAVIORS.QUIT;
}

class DesktopPreferences {
  constructor(userDataDir, { fileSystem = fs, logger = console } = {}) {
    if (typeof userDataDir !== 'string' || userDataDir.trim() === '') {
      throw new TypeError('A desktop user-data directory is required');
    }
    this.userDataDir = userDataDir;
    this.filePath = path.join(userDataDir, DESKTOP_PREFERENCES_FILENAME);
    this.fileSystem = fileSystem;
    this.logger = logger;
    this.data = this._load();
  }

  _load() {
    try {
      if (!this.fileSystem.existsSync(this.filePath)) return {};
      const parsed = JSON.parse(this.fileSystem.readFileSync(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('Desktop preferences must contain a JSON object');
      }
      return parsed;
    } catch (error) {
      this.logger.error('[Electron] Could not load desktop preferences:', error.message);
      return {};
    }
  }

  getCloseWindowBehavior() {
    const behavior = this.data.closeWindowBehavior;
    return isCloseWindowBehavior(behavior) ? behavior : DEFAULT_CLOSE_WINDOW_BEHAVIOR;
  }

  setCloseWindowBehavior(behavior) {
    if (!isCloseWindowBehavior(behavior)) {
      throw new TypeError('Close-window behavior must be "hide" or "quit"');
    }

    const nextData = { ...this.data, closeWindowBehavior: behavior };
    const tempPath = path.join(
      this.userDataDir,
      `.${DESKTOP_PREFERENCES_FILENAME}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      this.fileSystem.mkdirSync(this.userDataDir, { recursive: true });
      this.fileSystem.writeFileSync(
        tempPath,
        JSON.stringify(nextData, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
      this.fileSystem.renameSync(tempPath, this.filePath);
      this.data = nextData;
      return behavior;
    } catch (error) {
      try { this.fileSystem.unlinkSync(tempPath); } catch {}
      this.logger.error('[Electron] Could not save desktop preferences:', error.message);
      throw error;
    }
  }
}

module.exports = {
  CLOSE_WINDOW_BEHAVIORS,
  DEFAULT_CLOSE_WINDOW_BEHAVIOR,
  DESKTOP_PREFERENCES_FILENAME,
  DesktopPreferences,
  isCloseWindowBehavior
};
