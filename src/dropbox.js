const Promise   = require('bluebird');
const path      = require('path');
const fse       = Promise.promisifyAll(require('fs-extra'));
const request   = require('request');
const fs        = require('fs');
const https     = require('https');
const Throttler = require('./throttler');
const isStream  = require('is-stream');
const EventEmitter2 = require('eventemitter2').EventEmitter2;

/**
 * Represents a Dropbox User that authorized our app.
 *
 * Provides:
 * 1. Syncing (from cloud to local storage)
 * 2. Retrieving delta recursively for any number of changes.
 *    i.e. if delta has_more is true, it fetches next rounds until it's complete.
 * 3. Downloads and uploads file in a streaming fashion to consume little memory
 * 4. Offers rpcRequest() that helps you use any Dropbox HTTP API easily
 * 5. Central throttling of all API request (per user, not per app) so that we won't get
 * the 429 HTTP Error.
 *
 * Make sure the following static variables as you want them.
 * 1. DropboxUser.USERS_DIR
 *
 * Changes to USERS_DIR only effects the DropboxUser instances created thereafter.
 *
 * DropboxUser offers a promise based interface all success and errors are reported to
 * by resolved or rejected promises.
 *
 * However, for anything in between, are comunicated over events. Such as diagnostic messages,
 * warnings etc.
 *
 * Static methods' events will be fired from DropboxUser.events EventEmitter2 instance.
 *
 * As syncing operation can take quite some time depending on the scenario, DropboxUser
 * instances emit some events to notify user about progress.
 * @emits sync-start
 * @emits sync-tasks
 * @type {object} An object with folders, deletes, downloads, ignored properties which
 *                tells you the amount of work to be done (i.e. eventValue.downloads.length)
 * @emits sync-file-downloaded Path of the downloaded file
 * @type {string}
 * @emits sync-completed
 * @emits log Uncritical log messages for diagnostic purposes.
 * @type {string}
 * @extends {EventEmitter2}
 */
class DropboxUser extends EventEmitter2 {
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
    return this.rpcRequest(authInfo.access_token, 'users/get_account', {account_id: authInfo.account_id})
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
   * @param {string} accountId Account ID
   */
  constructor(accountId) {
    super();
    this.accountId   = accountId;
    this.home        = path.resolve(path.join(DropboxUser.USERS_DIR, accountId));
    if (!this.home.startsWith(path.resolve(DropboxUser.USERS_DIR))) {
      // Somehow accountId is malicious and tries to escape USERS_DIR
      throw new Error(`Malicious account id ${accountId}`);
    }
    this.dataDir     = path.resolve(path.join(this.home, 'data'));
    this.cursorFile  = path.resolve(path.join(this.home, 'cursor'));
    this.whoisFile   = path.resolve(path.join(this.home, 'whois'));
    this.authFile    = path.resolve(path.join(this.home, 'auth'));
    // This is used to serialize sync() and don't run two sync() operations at the same time
    this.previousPromise  = undefined;
    // Count of the queued sync operations
    this.depth = 0;
  }

  toString() {
    return `${this.constructor.name} ${this.accountId}`;
  }

  getCursor() {
    return fse.readFileAsync(this.cursorFile, 'utf8');
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
   * Low level request API.
   *
   * User higher level methods instead.
   *
   * @see DropboxUser#rpcRequest
   * @see DropboxUser#download
   * @see DropboxUser#upload
   *
   * @static
   * @param {object} options
   * {
   *  accessToken: <access token:string>,
   *  uri: <uri: string>,
   *  upload: <file to be uploaded:string|Readable>,
   *  download: <file to store the result:string|Writable>,
   *  paramters: <parameters for the specific end point:object>
   * }
   * @param {EventEmitter2.emit} emit Emit function.
   * @return {Promise} Resolves with the response body (for rpcRequests)
   * Rejects with {DropboxUser.RequestError}
   */
  static rawRequest(options, emit = DropboxUser.events.emit.bind(DropboxUser.events)) {
    if (!options.accessToken) {
      return Promise.reject(new DropboxUser.RequestError('Access token is required.', options));
    }

    if (options.upload && options.download) {
      return Promise.reject(new DropboxUser.RequestError('You cannot upload and download at the same time.', options));
    }

    DropboxUser.stats.pending++;
    // API requests are rate limited per user basis, we'll use access token as key.
    if (options.retry > 0) {
      emit('log', 'retry request queued');
    }
    return DropboxUser.THROTTLER.throttle(options.accessToken)
    .then(() => {
      return new Promise((resolve, reject) => {
        if (options.retry > 0) {
          emit('log', 'retry request actually sent now');
        }
        let defaults = {
          accessToken: null,
          uri: null,
          // Readable stream or file path
          upload: null,
          // Writable stream or file path
          download: null,
          // Dropbox API parameters
          parameters: {},
          retry: 0,
          timeout: 30 * 1000
        };
        options = Object.assign(defaults, options);


        let requestOptions = {
          uri: options.uri,
          headers: {
            Authorization: 'Bearer ' + options.accessToken
          },
          timeout: options.timeout,
          agent: DropboxUser.AGENT
        };

        if (options.upload || options.download) {
          // If upload or download pack the parameters into the header.
          requestOptions.headers['Dropbox-API-Arg'] = JSON.stringify(options.parameters);
          if (options.upload) {
            requestOptions.headers['Content-Type'] = 'application/octet-stream';
          }
        } else {
          // A regular RPC call
          requestOptions.headers['Content-Type'] = 'application/json';
          requestOptions.body = options.parameters;
          requestOptions.json = true;
          // There must be a cb, otherwise Request won't parse body
          // See https://github.com/request/request/blob/v2.74.1/request.js#L972
          requestOptions.callback = () => {};
        }

        let req = request.post(requestOptions);
        if (options.upload) {
          let uploadStream;
          if (isStream.readable(options.upload)) {
            uploadStream = options.upload;
          } else if (typeof options.upload === 'string') {
            uploadStream = fs.createReadStream(options.upload);
          } else {
            emit('is readable', isStream.readable(options.upload));
            return reject(new DropboxUser.RequestError(`Upload file must be a file path or stream.Readable`, options));
          }
          uploadStream.on('error', reject);
          uploadStream.pipe(req);
        }
        DropboxUser.stats.flight++;
        req.on('response', response => {
          if (response.statusCode < 200 || response.statusCode > 299) {
            
            // We got an HTTP error status code
            if (options.retry > DropboxUser.MAX_RETRY) {
              // We've already tried it too many times, bail out.
              reject(new DropboxUser.RequestError('Too many errors for request', options));
            }
            emit('log', `HTTP ERROR ${response.statusCode}`);
            switch (response.statusCode) {
              case 429: {
                // We are being rate limited
                // We'll wait as much as Dropbox API tells us to, it usually says wait 300 (seconds)
                let wait = response.headers['retry-after'] || 300;
                emit('log', `We are being rate limited. Dropbox API told us to wait ${wait} seconds`);
                emit('rate-limited', wait);

                // Maybe also adjust our rate limiter
                return resolve(Promise.delay(wait * 1000)
                              .then(() => DropboxUser.rawRequest(options)));
              }
              case 500: {
                // We got a HTTP statuc error code and this is not rate limiting
                // Maybe we got a temporary 500 error, we'll try a few more times
                // Note that we're not increasing the retry counter above (in the rate limiting)
                // Because we don't want to bail on a request just because it has been throttled
                // a few times
                emit('retry', 'HTTP 500', options);
                options.retry++;
                DropboxUser.stats.retries++;
                return resolve(DropboxUser.rawRequest(options));
              }
              default:
                let errorMessage = '';
                response.on('data', chunk => errorMessage += chunk);
                response.on('end', () => reject(new DropboxUser.RequestError(`HTTP Error ${response.statusCode}\n${errorMessage}`, options)));
                response.on('error', reject);
            }
          }
          // HTTP Status code is 200-ish.

          if (options.download) {
            let downloadStream;
            if (isStream.writable(options.download)) {
              downloadStream = options.download;
            } else if (typeof options.download === 'string') {
              downloadStream = fs.createWriteStream(options.download);
            } else {
              return reject(new DropboxUser.RequestError(`Download file must be a file path or stream.Writable`, options));
            }
            downloadStream.on('error', reject);
            req.pipe(downloadStream);
          }
        })
        .on('error', e => {
          // We have a socket error probably (ECONNRESET or ETIMEDOUT)
          options.retry++;
          if (options.retry >= DropboxUser.MAX_RETRY) {
            return reject(new DropboxUser.RequestError(`Giving up on Socket Error after ${options.retry} attempts: ${e.message}`,  options));
          }
          DropboxUser.stats.retries++;
          emit('retry', {err: e, opts: options});
          resolve(DropboxUser.rawRequest(options));
        })
        .on('complete', (response, body) => {
          resolve(body);
        });
      })
      .then(result => {
        DropboxUser.stats.completed++;
        return result;
      })
      .catch(e => {
        DropboxUser.stats.errors++;
        throw e;
      })
      .finally(() => {
        DropboxUser.stats.pending--;
        DropboxUser.stats.flight--;
      });
    });
  }

  /**
   * Static method for RPC requests
   *
   * User instance method if you want to avoid using access token.
   *
   * @static
   * @param {string} accessToken
   * @param {string} endpoint Endpoint without the preceeding slash, ex: 'users/get_account'
   * @param {object} parameters
   * @param {any} [emit=DropboxUser.events.emit.bind(DropboxUser.events)]
   * @return {Promise} See rawRequest
   */
  static rpcRequest(accessToken, endpoint, parameters, emit = DropboxUser.events.emit.bind(DropboxUser.events)) {
    let options = {
      uri: 'https://api.dropboxapi.com/2/' + endpoint,
      accessToken: accessToken,
      parameters: parameters
    };
    return DropboxUser.rawRequest(options, emit);
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
    .then(({access_token}) => DropboxUser.rpcRequest(access_token, endpoint, parameters, this.emit.bind(this)));
  }

  /**
   * Downloads a file to a writable stream.
   *
   * Notes:
   * A failed download (HTTP Status != 2xx) could be automatically re-tried.
   * It's easy to implement but backlogging can be dangerous. It should be well thought.
   *
   * History:
   * Previously destination was a strem.Writable, it provides the flexibility to
   * download to Buffers or anything streamy but that requires file descriptors
   * to be opened before being passed to DropboxUer.download(src, dstStream).
   * Then the requests were throttled and downloaded accordingly. During this
   * whole process, file descriptors were closed one by one as the downloads
   * are completed. So, if you were to queue 20k downloads, 20k file descriptors
   * would be opened initially (it can't be since most OSes won't let you).
   * So, instead, we have to resort to a less elegant API, and receive destination
   * file path instead and create the stream when only we receive a response.
   *
   * @param {string} src Dropbox src identifier (could be path or id)
   * @param {string|Writable} dst Path or Writable stream to save the downloaded file to.
   * @param {object} options Dropbox options
   * @return {Promise} A promise that resolves to destionation stream
   */
  static download(accessToken, src, dst, parameters = {}, emit = DropboxUser.events.emit.bind(DropboxUser.events)) {
    parameters.path = src;
    let options = {
      uri: 'https://content.dropboxapi.com/2/files/download',
      accessToken: accessToken,
      parameters: parameters,
      download: dst
    };
    return DropboxUser.rawRequest(options, emit);
  }

  download(src, dstPath, parameters = {}) {
    return this.getAuth()
    .then(({access_token}) => DropboxUser.download(access_token, src, dstPath, parameters, this.emit.bind(this)));
  }

  /**
   * Uploads (pipes) a readable stream to the cloud.
   *
   * @param {string} accessToken Access token
   * @param {string|stream.Readable} src Readable stream to upload
   * @param {string} dstPath Upload destination
   * @param {object} parameters Dropbox options
   * @return {Promise} A promise that resolves to undefined
   */
  static upload(accessToken, src, dstPath, parameters = {}, emit = DropboxUser.events.emit.bind(DropboxUser.events)) {
    parameters.path = dstPath;
    let options = {
      uri: 'https://content.dropboxapi.com/2/files/upload',
      accessToken: accessToken,
      parameters: parameters,
      upload: src
    };
    return DropboxUser.rawRequest(options, emit);
  }

  upload(src, dstPath, parameters = {}) {
    this.emit('log', 'uploading shit');
    return this.getAuth()
    .then(({access_token}) => DropboxUser.upload(access_token, src, dstPath, parameters, this.emit.bind(this)));
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
    if (this.depth > 10) {
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
       * This corner case is not covered yet.
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
      return this.getCursor()
      .then(cursor => this.rpcRequest('files/list_folder/continue', {cursor: cursor}))
      .catch(error => {
        if (error.code !== undefined && error.code === 'ENOENT') {
          // We don't have a cursor yet, so returning null.
          return null;
        }
        // There's an unexpected error, re-throw it
        throw error;
      });
    })
    .then(cursor => {
      // Either user provided a null pointer or cursor file reading failed (probably
      // because this is the first time we're doing a sync() for this user)
      // In either case we want to get the delta from the very beginning
      if (cursor === null) {
        return this.rpcRequest('files/list_folder', {path: '', recursive: true});
      }
    })
    // Fetch more results if necessary (if result.has_more is true) by recursing
    .then(result => this._recurseDelta(result));
  }
}

/**
 * User's files will be synced to a folder in this one.
 * @static
 */
DropboxUser.USERS_DIR = 'dropboxUsers';

/**
 * Throttles HTTP API requests per account id.
 *
 * This is static because we want to rate per accountId (and not the DropboxUser instance).
 *
 * So, even multiple instance of a DropboxUser for a particular account will be throttled
 * properly.
 *
 * NOTE: npm package limiter is buggy https://github.com/jhurliman/node-rate-limiter/issues/25
 * Yet, the default value is a sweet spot for Dropbox API, so it should be fine, for now.
 *
 * @default is 600 requests per minute. With 600 request burst rate.
 *
 * @static
 */
DropboxUser.THROTTLER = new Throttler(600, 60000);

// Be a good network citizen and don't hammer Dropbox API servers.
DropboxUser.AGENT = new https.Agent({keepAlive: true});

DropboxUser.MAX_SYNC_QUEUE = 10;

/**
 * If a request is failed with HTTP 500, it is considered a temporary problem and the request
 * is resend. This is the maximum resend attempt.
 * @static
 */
DropboxUser.MAX_RETRY = 5;

DropboxUser.SyncError = class SyncError extends Error {};

DropboxUser.RequestError = class RequestError extends Error {
  constructor(msg, options) {
    // Do not leak access token
    options.accessToken = '<access token>';
    super(msg);
    this.options = options;
  }
};

/**
 * If you use static methods events will be fired from this EventEmitter2 instance.
 * @static
 */
DropboxUser.events = new EventEmitter2();

DropboxUser.stats = {};

/**
 * Stats on how many requests are on actually sent and on the fly. The rest of may be queued up
 * by the throttler.
 * @see DropboxUser.stats.pending
 * @static
 */
DropboxUser.stats.flight  = 0;

/**
 * Stats on how many requests are pending.
 * @static
 */
DropboxUser.stats.pending  = 0;

/**
 * Stats on how many requests successfully completed.
 */
DropboxUser.stats.completed = 0;

/**
 * Stats on how many requests actually endded up being a failure despite all the effort (just like you).
 * @static
 */
DropboxUser.stats.errors    = 0;

/**
 * Stats on how many times requests have been retried.
 * @static
 */
DropboxUser.stats.retries   = 0;

module.exports = DropboxUser;
