'use strict';

const path    = require('path');
const Promise = require('bluebird');
const fse     = Promise.promisifyAll(require('fs-extra'));
const Dropbox = require('./dropbox');
const EventEmitter2 = require('eventemitter2');

class DropboxUser extends EventEmitter2 {
  toString() {
    return `${this.constructor.name} ${this.accountId}`;
  }
  /**
   * Creates directory structure for a user in the DropboxUser.USERS_DIR folder.
   *
   * The directory structure is required for sync() operation.
   *
   * Creates:
   * DropboxUser.USERS_DIR/{account_id}/data/ [folder] This is where files will be synced to.
   * DropboxUser.USERS_DIR/{account_id}/whois [file]   Contains user's name and email information.
   * DropboxUser.USERS_DIR/{account_id}/auth  [file]   Will contain access token etc.
   *
   * Later on, when you use sync(), DropboxUser.USERS_DIR/{account_id}/cursor file will also be created.
   *
   * @static
   * @param {any} authInfo Auth info as recived from hash string in the dropbox
   *              connect page.
   * {
   *   access_token: <string>,
   *   token_type: <string>,
   *   uid: <number>,
   *   account_id: <string>
   * }
   * @return {Promise} A promise that resolves to DropboxUser
   */
  static create(authInfo) {
    let newUserDir = path.join(DropboxUser.USERS_DIR, authInfo.account_id);
    let userWhois;
    return Dropbox.rpcRequest(authInfo.access_token, 'users/get_account', {account_id: authInfo.account_id})
    .then(result => {
      if (!result.email_verified) {
        throw new Error('Dropbox user email not verified');
      }
      userWhois = result;
    })
    .then(() => fse.removeAsync(newUserDir))
    .then(() => fse.ensureDirAsync(newUserDir))
    // data is the directory where users' files will be synced to
    .then(() => fse.ensureDirAsync(path.join(newUserDir, 'data')))
    .then(() => fse.writeFileAsync(path.join(newUserDir, 'whois'), JSON.stringify(userWhois)))
    .then(() => fse.writeFileAsync(path.join(newUserDir, 'auth'), JSON.stringify(authInfo)))
    .then(() => new DropboxUser(authInfo.account_id));
  }

  /**
   * Creates a DropboxUser instance.
   *
   * Make sure you've created the directory structure for the user via DropboxUser.create().
   *
   * @see DropboxUser.create()
   * @see DropboxUser.list()
   *
   * @param {string} accountId Dropbox Account ID is 40-character string.
   * This is used to build directory structure for this user instance.
   * So, account id must be a safe string (without ../ and such trickery).
   */
  constructor(accountId) {
    super();
    if (typeof accountId !== 'string' || accountId.length !== 40) {
      throw new Error(`Account id must be a string of 40 characters.`);
    }
    this.accountId   = accountId;
    this.home        = path.resolve(path.join(DropboxUser.USERS_DIR, accountId));
    this.dataDir     = path.resolve(path.join(this.home, 'data'));
    this.cursorFile  = path.resolve(path.join(this.home, 'cursor'));
    this.whoisFile   = path.resolve(path.join(this.home, 'whois'));
    this.authFile    = path.resolve(path.join(this.home, 'auth'));
    // This is used to serialize sync() and don't run two sync() operations at the same time
    this.previousPromise  = undefined;
    // Count of the queued sync operations
    this.depth = 0;

    this.stats = {};
    Object.keys(Dropbox.stats).forEach(stat => {
      this.stats[stat] = 0;
    });
  }

  /**
   * @return {Promise<string>} The last saved cursor, null if there is none.
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
   * {
   *   "account_id": "string",
   *   "name": {
   *     "given_name": "Engin",
   *     "surname": "AYDOGAN",
   *     "familiar_name": "Engin",
   *     "display_name": "Engin AYDOGAN"
   *   }
   *   "email": "engin@bzzzt.biz",
   *   "email_verified": true,
   *   "disabled": false,
   *   "is_teammate": true
   * }
   *
   * @return {Promise} That resolves to above data structure.
   */
  getWhois() {
    return fse.readFileAsync(this.whoisFile, 'utf8')
    .then(whoisRaw => JSON.parse(whoisRaw));
  }

  /**
   * Reads, parse and returns auth object. In the following format.
   *
   * {
   *   "access_token": <accessToken:string>,
   *   "token_type": "bearer",
   *   "uid": <uid:string>,
   *   "account_id": <accountId:string>
   * }
   *
   * Note: This method caches the auth file so changes won't be read until
   * you invalidate cache via `user.authCache = undefined`
   *
   * So, if access token is expired or something, you have to clear this cache
   * or simply create a new user instance.
   *
   * @return {Promise} That resolves to above data structure.
   */
  getAuth() {
    if (this.authCache === undefined) {
      this.authCache = fse.readFileAsync(this.authFile, 'utf8')
      .then(authRaw => JSON.parse(authRaw));
    }
    return this.authCache;
  }

  /**
   * @static
   * @return {Array} A list of strings of account ids for the users created via
   * DropboxUser.create()
   */
  static list() {
    return fse.readdirAsync(DropboxUser.USERS_DIR);
  }

  /**
   * Same as static rpcRequest method, except this one pulls the access token for the
   * instance automatically.
   *
   * @see DropboxUser.rawRequest for implementation details
   *
   * @param {string} endpoint Endpoint without the preceeding slash, ex: 'users/get_account'
   * @param {object} parameters Parameters for the end point
   * @return {Promise} See rawRequest
   */
  rpcRequest(endpoint, parameters) {
    return this.getAuth()
    .then(({access_token}) => Dropbox.rpcRequest(access_token, endpoint, parameters, this.emit.bind(this), this.stats));
  }

  download(src, dstPath, parameters = {}) {
    return this.getAuth()
    .then(({access_token}) => Dropbox.download(access_token, src, dstPath, parameters, this.emit.bind(this), this.stats));
  }


  upload(src, dstPath, parameters = {}) {
    this.emit('log', 'uploading shit');
    return this.getAuth()
    .then(({access_token}) => Dropbox.upload(access_token, src, dstPath, parameters, this.emit.bind(this), this.stats));
  }

  /**
   * Syncs users files into DropboxUser.USERS_DIR/{accountId}/data folder.
   * @param {Function} filter is called with file object and the object is processed
   *                   only if this function returns true. Can be used to skip
   *                   file downloads, directory creations and file deletions.
   *                   Object is {'.tag': <folder|file|deleted>,
   *                              name  : <file name>,
   *                              path_lower: <lower case path>,
   *                              path_display: <path>,
   *                              id: <dropbox file id>}
   * @param {Number} timeout Timeout for the whole sync operation in ms.
   * @default 2147483647 because JS timer values are signed 32 bit.
   * @throws Promise.TimeoutError when download operation times out
   * @throws DropboxUser.SyncError when sync queue is greater than DropboxUser.MAX_SYNC_QUEUE
   * @see DropboxUser#MAX_SYNC_QUEUE
   * @return {Promise} A Promise that resolves to an object
   * {
        folders  : <array of folder entries that are created>,
        deletes  : <array of file entries that got deleted>,
        downloads: <array of file entries that got downloaded>,
        ignored  : <array of file entries that are ignored>
      }
   */
  sync(filter = () => true, timeout = 2147483647) {
    // Prevent backlogging
    if (this.depth >= DropboxUser.MAX_SYNC_QUEUE) {
      return Promise.reject(new DropboxUser.SyncError('Too many sync operations queued.'));
    }
    this.depth++;

    if (this.previousPromise === undefined) {
      this.previousPromise = Promise.resolve();
    } else {
      this.emit('log', `Sync in progress. Queueing:  ${this.depth}`);
    }

    // Data that needs to be passed between some distant thens
    let delta;
    let folders   = [];
    let deletes   = [];
    let downloads = [];
    let ignored   = [];

    let newPromise = this.previousPromise
    .then(() => this.emit('sync-start'))
    .then(() => this.delta())
    .then(result => {
      delta = result;
      // Calculate absolute paths
      let changes = delta.allEntries.map(change => {
        change.absolutePath = path.resolve(path.join(this.dataDir, change.path_lower));
        return change;
      })
      // And make sure they are safe
      .filter(change => this._isSafe(change.absolutePath));
      // Categorize tasks
      for (let change of changes) {
        if (!filter(change)) {
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
    .timeout(timeout, 'Sync download operation timeout')
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
       * We are here probably because either sync is timed out (Promise.TimeoutError) or one of the
       * downloads returned non 200-ish HTTP code.
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
    })
    .finally(() => {
      this.depth--;
      if (this.previousPromise === newPromise) {
        this.previousPromise = undefined;
      } else {
        // log.info('NOT removing promise from syncPromises, because it has been overriden');
      }
    });
    this.previousPromise = newPromise;
    return newPromise;
  }

  /**
   * Checks if a path is safe or not.
   *
   * i.e. We wouldn't like a delete or write operation for, say, '../../../etc/passwd'
   *
   * We cannot blindly trust an information coming from an external source.
   *
   * @param {string} absolutePath Absolute path of the file to be checked
   * @return {bool} True if file is safe
   */
  _isSafe(absolutePath) {
    let jail = this.dataDir + path.sep;
    return absolutePath.startsWith(jail);
  }

  /**
   * If a delta operation cannot fit into a single request/response transaction
   * we recursive get all the remaining deltas here.
   *
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
   * Cursor file is located in DropboxUser.USERS_DIR/{accountId}/cursor
   *
   * This method does not update the cursor file itself. It's user's responsibility
   * to update the cursor file, possible after completing a task (such as sync) succesfully.
   *
   * Once the caller of this method (@see DropboxUser.sync()) saves the returned cursor, the next call to
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
    this.emit('log', 'Computing difference between local copy and cloud');
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


DropboxUser.USERS_DIR = 'dropboxUsers';

DropboxUser.MAX_SYNC_QUEUE = 10;

DropboxUser.SyncError = class SyncError extends Error {};

module.exports = DropboxUser;
