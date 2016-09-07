const Promise   = require('bluebird');
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
 * 1. Dropbox.USERS_DIR
 *
 * Changes to USERS_DIR only effects the Dropbox instances created thereafter.
 *
 * Dropbox offers a promise based interface all success and errors are reported to
 * by resolved or rejected promises.
 *
 * However, for anything in between, are comunicated over events. Such as diagnostic messages,
 * warnings etc.
 *
 * Static methods' events will be fired from Dropbox.events EventEmitter2 instance.
 *
 * As syncing operation can take quite some time depending on the scenario, Dropbox
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
class Dropbox {
  /**
   * Low level request API.
   *
   * User higher level methods instead.
   *
   * @see Dropbox#rpcRequest
   * @see Dropbox#download
   * @see Dropbox#upload
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
   * Rejects with {Dropbox.RequestError}
   */
  static rawRequest(options, emit = Dropbox.events.emit.bind(Dropbox.events), stats = Dropbox.stats) {
    if (!options.accessToken) {
      return Promise.reject(new Dropbox.RequestError('Access token is required.', options));
    }

    if (options.upload && options.download) {
      return Promise.reject(new Dropbox.RequestError('You cannot upload and download at the same time.', options));
    }

    if (options.retry > Dropbox.MAX_RETRY) {
      // We've already tried it too many times, bail out.

      // reduce retries stats as this retry will not take place and aborted right now.
      stats.retries--;
      return Promise.reject(new Dropbox.RequestError('Too many errors for request', options));
    }

    stats.pending++;

    // API requests are rate limited per user basis, we'll use access token as key.
    return Dropbox.THROTTLER.throttle(options.accessToken)
    .then(() => {
      return new Promise((resolve, reject) => {
        if (options.retry > 0) {
          emit('log', 'retry request actually sent now', options);
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
          agent: Dropbox.AGENT
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
            return reject(new Dropbox.RequestError(`Upload file must be a file path or stream.Readable.`, options));
          }
          uploadStream.on('error', err => {
            reject(new Dropbox.RequestError('There was an error with the upload readble stream.', options, err));
          });
          uploadStream.pipe(req);
        }
        stats.flight++;
        req.on('response', response => {
          if (response.statusCode < 200 || response.statusCode > 299) {
            // We got an HTTP error status code
            emit('log', `HTTP ERROR ${response.statusCode}`);
            switch (response.statusCode) {
              case 429: {
                // We are being rate limited
                // We'll wait as much as Dropbox API tells us to, it usually says wait 300 (seconds)
                let wait = response.headers['retry-after'] || 300;
                emit('retry', `Attempting to retry in ${wait} seconds due to rate limiting (HTTP 429)`, options);
                options.retry++;
                stats.retries++;
                // Maybe also adjust our rate limiter
                return resolve(Promise.delay(wait * 1000)
                              .then(() => Dropbox.rawRequest(options)));
              }
              case 500: {
                // We got a HTTP statuc error code and this is not rate limiting
                // Maybe we got a temporary 500 error, we'll try a few more times
                // Note that we're not increasing the retry counter above (in the rate limiting)
                // Because we don't want to bail on a request just because it has been throttled
                // a few times
                emit('retry', 'Attempting to retry due to HTTP 500', options);
                options.retry++;
                stats.retries++;
                return resolve(Dropbox.rawRequest(options));
              }
              default: {
                let errorMessage = '';
                response.on('data', chunk => {
                  errorMessage += chunk;
                });
                response.on('end', () => {
                  reject(new Dropbox.RequestError(`HTTP Error ${response.statusCode}: ${errorMessage}`, options));
                });
                response.on('error', error => {
                  emit('log', 'response stream error, error');
                  reject(new Dropbox.RequestError('Could not read error response.', options, error));
                });
              }
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
              return reject(new Dropbox.RequestError(`Download file must be a file path or stream.Writable.`, options));
            }
            downloadStream.on('error', err => {
              reject(new Dropbox.RequestError('There was an error with the download write stream.', options, err));
            });
            req.pipe(downloadStream);
          }
        })
        .on('error', e => {
          // We have a socket error probably (ECONNRESET or ETIMEDOUT)
          emit('log', 'socket error', options, e);
          options.retry++;
          stats.retries++;
          emit('retry', 'Attempting to retrying due to socket error');
          resolve(Dropbox.rawRequest(options));
        })
        .on('complete', (response, body) => {
          resolve(body);
        });
      })
      .then(result => {
        stats.completed++;
        return result;
      })
      .catch(e => {
        stats.errors++;
        throw e;
      })
      .finally(() => {
        stats.pending--;
        stats.flight--;
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
   * @param {any} [emit=Dropbox.events.emit.bind(Dropbox.events)]
   * @return {Promise} See rawRequest
   */
  static rpcRequest(accessToken, endpoint, parameters, emit = Dropbox.events.emit.bind(Dropbox.events), stats = Dropbox.stats) {
    let options = {
      uri: 'https://api.dropboxapi.com/2/' + endpoint,
      accessToken: accessToken,
      parameters: parameters
    };
    return Dropbox.rawRequest(options, emit, stats);
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
   * @param {string|stream.Writable} dst Path or Writable stream to save the downloaded file to.
   * @param {object} options Dropbox options
   * @return {Promise} A promise that resolves to destionation stream
   */
  static download(accessToken, src, dst, parameters = {}, emit = Dropbox.events.emit.bind(Dropbox.events), stats = Dropbox.stats) {
    parameters.path = src;
    let options = {
      uri: 'https://content.dropboxapi.com/2/files/download',
      accessToken: accessToken,
      parameters: parameters,
      download: dst
    };
    return Dropbox.rawRequest(options, emit, stats);
  }

  /**
   * Uploads (pipes) a readable stream to the cloud.
   *
   * https://www.dropbox.com/developers/documentation/http/documentation#files-upload
   * @param {string} accessToken Access token
   * @param {string|stream.Readable} src Readable stream to upload
   * @param {string} dstPath Upload destination
   * @param {object} parameters Dropbox options
   * @return {Promise} A promise that resolves to undefined
   */
  static upload(accessToken, src, dstPath, parameters = {}, emit = Dropbox.events.emit.bind(Dropbox.events), stats = Dropbox.stats) {
    parameters.path = dstPath;
    let options = {
      uri: 'https://content.dropboxapi.com/2/files/upload',
      accessToken: accessToken,
      parameters: parameters,
      upload: src
    };
    return Dropbox.rawRequest(options, emit, stats);
  }
}

/**
 * User's files will be synced to a folder in this one.
 * @static
 */
Dropbox.USERS_DIR = 'Dropboxs';

/**
 * Throttles HTTP API requests per account id.
 *
 * This is static because we want to rate per accountId (and not the Dropbox instance).
 *
 * So, even multiple instance of a Dropbox for a particular account will be throttled
 * properly.
 *
 * NOTE: npm package limiter is buggy https://github.com/jhurliman/node-rate-limiter/issues/25
 * Yet, the default value is a sweet spot for Dropbox API, so it should be fine, for now.
 *
 * @default is 600 requests per minute. With 600 request burst rate.
 *
 * @static
 */
Dropbox.THROTTLER = new Throttler(600, 60000);

// Be a good network citizen and don't hammer Dropbox API servers.
Dropbox.AGENT = new https.Agent({keepAlive: true});

/**
 * If a request is failed with HTTP 500, it is considered a temporary problem and the request
 * is resend. This is the maximum resend attempt.
 * @static
 */
Dropbox.MAX_RETRY = 5;

/**
 * Encapsulates an error message regarding a request.
 *
 * Error message is in `message` property as per usual.
 *
 * Request options that caused the error is in the `options` property.
 *
 * Original error (if there is any) will be in `error` property.
 */
Dropbox.RequestError = class RequestError extends Error {
  constructor(msg, options, error = null) {
    // Do not leak access token
    options.accessToken = '<access token>';
    super(msg);
    this.options = options;
    this.error = error;
  }
};

/**
 * If you use static methods events will be fired from this EventEmitter2 instance.
 * @static
 */
Dropbox.events = new EventEmitter2();

Dropbox.stats = {};

/**
 * Stats on how many requests are on actually sent and on the fly. The rest of may be queued up
 * by the throttler.
 * @see Dropbox.stats.pending
 * @static
 */
Dropbox.stats.flight  = 0;

/**
 * Stats on how many requests are pending.
 * @static
 */
Dropbox.stats.pending  = 0;

/**
 * Stats on how many requests successfully completed.
 */
Dropbox.stats.completed = 0;

/**
 * Stats on how many requests actually endded up being a failure despite all the effort (just like you).
 * @static
 */
Dropbox.stats.errors    = 0;

/**
 * Stats on how many times requests have been retried.
 * @static
 */
Dropbox.stats.retries   = 0;

module.exports = Dropbox;
