'use strict';

const path    = require('path');
const Promise = require('bluebird');
const fse     = Promise.promisifyAll(require('fs-extra'));
const Dropbox = require('./dropbox');
const EventEmitter2 = require('eventemitter2');

/**
 * One way Dropbox Sync client.
 *
 * It only supports cloud to local syncing as of now.
 *
 * It will create two additional files during first call to {@link Sync#sync}.
 *
 * @class Sync
 * @extends {EventEmitter2}
 */
class User extends EventEmitter2 {
  toString() {
    return `${this.constructor.name} ${this.homeDir}`;
  }

  /**
   * Creates an instance of Sync.
   * 
   * @param {string} folder Local folder path
   * @param {string} accessToken Access token for the user
   */
  constructor(folder, accessToken) {
    super();
    this.homeDir         = path.resolve(folder);
    this.cursorFile      = path.resolve(path.join(this.homeDir, '.cursor'));
    this.accessToken     = accessToken;
    this.accessTokenFile = path.resolve(path.join(this.homeDir, '.access_token'));
    this.stats           = {};
    Object.keys(Dropbox.stats).forEach(stat => {
      this.stats[stat] = 0;
    });
  }

  /**
   * @return {Promise<string, null>} The last saved cursor, null if there is none.
   * @rejects {Error} If an unexpected file system error occurs.
   */
  getCursor() {
    return fse.readFileAsync(this.cursorFile, 'utf8')
    .catch(error => {
      if (error.code !== undefined && error.code === 'ENOENT') {
        return null;
      }
      // Unexpected error, re-throw
      throw error;
    });
  }

/**
 * This method uses an instance variable accessTokenCache to cache the access token
 * as it might be used quite frequently.
 *
 * So, if you want to invalidate the cache simply delete the instance variable accessTokenCache.
 * @returns {Promise<string, Sync.Error>} Current access token for this sync point.
 */
  getAccessToken() {
    if (this.accessTokenCache === undefined) {
      this.accessTokenCache = fse.readFileAsync(this.accessTokenFile, 'utf8')
      .catch(error => {
        if (error.code === 'ENOENT') {
          // Access file does not exist (yet), see if user provided one in the constructor
          if (typeof this.accessToken === 'string') {
            // Write that to the access token file and return afterwards
            return fse.outputFileAsync(this.accessTokenFile, this.accessToken, 'utf8')
            .then(() => this.accessToken);
          }
          // No access token file present and no access token is provided manually
          return Promise.reject(new User.Error('Provide access token in the constructor if it is not saved in the access token file', 'ENOACC'));
        }
        return Promise.reject(new User.Error('There was a problem reading the access token file', error));
      });
    }
    return this.accessTokenCache;
  }

  rpcRequest(endpoint, parameters) {
    return this.getAccessToken()
    .then(accessToken => Dropbox.rpcRequest(accessToken, endpoint, parameters, this.emit.bind(this), this.stats));
  }

  download(src, dstPath, parameters) {
    return this.getAccessToken()
    .then(accessToken => Dropbox.download(accessToken, src, dstPath, parameters || {}, this.emit.bind(this), this.stats));
  }


  upload(src, dstPath, parameters) {
    return this.getAccessToken()
    .then(accessToken => Dropbox.upload(accessToken, src, dstPath, parameters || {}, this.emit.bind(this), this.stats));
  }

  /**
   * @param {Function} filter is called with file object and the object is processed
   *                   only if this function returns true. Can be used to skip
   *                   file downloads, directory creations and file deletions.
   *                   Object is {'.tag': <folder|file|deleted>,
   *                              name  : <file name>,
   *                              path_lower: <lower case path>,
   *                              path_display: <path>,
   *                              id: <dropbox file id>}
   * @return {Promise} A Promise that resolves to an object
   * {
        folders  : <array of folder entries that are created>,
        deletes  : <array of file entries that got deleted>,
        downloads: <array of file entries that got downloaded>,
        ignored  : <array of file entries that are ignored>
      }
   */
  sync(filter) {
    if (filter === undefined) {
      filter = () => true;
    }
    // Data that needs to be passed between some distant thens
    let delta;
    let folders   = [];
    let deletes   = [];
    let downloads = [];
    let ignored   = [];

    this.emit('sync-start');
    return fse.ensureDirAsync(this.homeDir)
    .then(() => this.delta())
    .then(result => {
      delta = result;
      // Calculate absolute paths
      let changes = delta.allEntries.map(change => {
        change.absolutePath = path.resolve(path.join(this.homeDir, change.path_lower));
        return change;
      })
      // And make sure they are safe
      .filter(change => this._isSafe(change.absolutePath));
      // Categorize tasks
      for (let change of changes) {
        if (!filter(change)) {
          this.emit('log', `Ignored ${change.path_display}`);
          ignored.push(change);
          continue;
        }
        switch (change['.tag']) {
          case 'folder':
            folders.push(change);
            break;
          case 'deleted':
            deletes.push(change);
            break;
          case 'file':
            // Ignore any not white listed files
            downloads.push(change);
            break;
          default:
            this.emit('log', `Unknown file type ${change['.tag']}`);
        }
      }
      this.emit('sync-tasks', {
        folders  : folders,
        deletes  : deletes,
        downloads: downloads,
        ignored  : ignored
      });
      // First create new folders
      return Promise.all(folders.map(folder => fse.mkdirpAsync(folder.absolutePath)));
    })
    // And then remove deleted files
    .then(() => Promise.all(deletes.map(file => fse.removeAsync(file.absolutePath))))
    // And download
    .then(() => {
      // Map all file entities to download promises
      return Promise.all(downloads.map(download => {
        // Creating a download promise for the file entity
        return this.download(download.id, download.absolutePath)
          // Chaining an even emitter so that we can track the progress
          .then(() => {
            this.emit('sync-file-downloaded', download.path_lower);
          });
      }));
    })
    // We consider this sync completed now, so, saving the cursor
    .then(() => {
      this.emit('sync-completed');
      return fse.writeFileAsync(this.cursorFile, delta.cursor);
    })
    .then(() => {
      return {
        folders  : folders,
        deletes  : deletes,
        downloads: downloads,
        ignored  : ignored
      };
    })
    .catch(e => {
      /**
       * !FIXME
       * We are here probably because one of the downloads returned non 200-ish HTTP code.
       *
       * Even though, sync operation failed here, because it's not realiable anymore,
       * all the download requests are either:
       *
       * 1. in the throttling queue
       * 2. or request queue (https.Agent pool).
       *
       * They will continue to run in the background unless we:
       * 1. Use bluebird's Promise.cancel mechanism (which is somehow disabled by default, which
       * makes you think) to stop throttler to queue new requests into the https.Agent's pool.
       * 2. AND call https.Agent.destroy() to destroy all remaining sockets.
       *
       * or
       *
       * Manage a user space queue that we can wipe out anytime.
       *
       * This corner case is not covered yet.
       *
       * But it's more of a nuisance as it does not result in operational failure but just waste of resources.
       */
      throw e;
    });
  }

  /**
   * Checks if a path is safe or not.
   *
   * i.e. We wouldn't like a delete or write operation for, say, '../../../etc/passwd'
   *
   * We cannot blindly trust an information coming from an external source.
   *
   * @private
   * @param {string} absolutePath Absolute path of the file to be checked
   * @return {bool} True if file is safe
   */
  _isSafe(absolutePath) {
    let jail = this.homeDir + path.sep;
    return absolutePath.startsWith(jail);
  }

  /**
   * If a delta operation cannot fit into a single request/response transaction
   * we recursive get all the remaining deltas here.
   *
   * @private
   * @param {object} data A response got from files/list_folder
   *                      or files/list_folder/continue request
   * @return {object} An object with a custom allEntries parameter which contains
   *                   all of the deltas.
   */
  _recurseDelta(data) {
    // If this is the first run of _recurse, our custom allEntries variable
    // wouldn't be initialized.
    if (data.allEntries === undefined)
      data.allEntries = [];
    // We will accumulate all .entries elements into allEntries in each recursion.
    data.allEntries = data.allEntries.concat(data.entries || []);
    // If there is no more data pending, just resolve.
    if (data.has_more !== true) {
      this.emit('log', `Computing differences completed. Total differences: ${data.allEntries.length}`);
      delete data.has_more;
      return data;
    }
    this.emit('log', `Differences so far: ${data.allEntries.length}`);
    return this.rpcRequest('files/list_folder/continue', {cursor: data.cursor})
      .then(result => {
        result.allEntries = data.allEntries;
        return this._recurseDelta(result);
      });
  }

  /**
   * Returns a delta since the last cursor.
   *
   * This method does not update the cursor file itself. It's user's responsibility
   * to update the cursor file, possible after completing a task (such as sync) succesfully.
   *
   * Once the caller of this method {@link Sync#sync} saves the returned cursor, the next call to
   * delta will return the changes from that cursor and the entries returned in the
   * current call will be lost.
   * @param {string}  cursor Last cursor to get the delta from. null if you don't have a cursor
   *                  and want to get the delta from the very beginning.
   * @return {object} An object with allEntries property which holds an array
   *                  of all the entries since the last cursor saved.
   *                  Also has a .cursor property. It's caller's responsibility
   *                  to save the new cursor (probably after doing some work successfuly)
   */
  delta(cursor) {
    this.emit('log', 'Getting the list of differences');
    // Try to read the last cursor
    return Promise.try(() => {
      if (cursor !== undefined) {
        return cursor;
      }
      // Cursor is not provided, read from saved cursor file
      return this.getCursor();
    })
    .then(cursor => {
      // Either user provided a null pointer or cursor file reading failed (probably
      // because this is the first time we're doing a sync() for this user)
      // In either case we want to get the delta from the very beginning
      if (cursor === null) {
        return this.rpcRequest('files/list_folder', {path: '', recursive: true});
      }
      return this.rpcRequest('files/list_folder/continue', {cursor: cursor});
    })
    // Fetch more results if necessary (if result.has_more is true) by recursing
    .then(result => this._recurseDelta(result));
  }
}

User.Error = class UserError extends Error {
  constructor(msg, native) {
    super(msg);
    this.native = native;
  }
};

module.exports = User;
