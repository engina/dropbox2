'use strict';

const Promise   = require('bluebird');
const request   = require('request');
const fs        = require('fs');
const https     = require('https');
const Throttler = require('./throttler');
const isStream  = require('is-stream');
const EventEmitter2 = require('eventemitter2').EventEmitter2;

/**
 * @private
 */
class Retry extends Error {
  constructor(options, emit, stats, delay) {
    super('Retry request');
    this.options = options;
    this.emit    = emit;
    this.stats   = stats;
    this.delay   = delay || 0;
  }
}

/**
 * This is the unofficial Dropbox API client implementation that supports Node 4 and up.
 *
 * It provides following missing features of the official client library:
 *
 * 1. Downloads and uploads file in a streaming fashion to consume minimal memory. Official library
 * buffers downloads.
 * 2. Central throttling of all API request so that we won't get the 429 HTTP Error.
 * 3. Automatic retries on temporary errors (such as 500 and 429).
 *
 * This implementation offers a promise based interface. All success and errors are reported
 * by resolving or rejecting returned promises.
 *
 * However, some diagnostic messages are communicated via events.
 *
 * These events will be fired from {@link Dropbox.events} object which is an EventEmitter2 instance.
 *
 * However, you can provide your own emit function with the prototype *emit(eventType: string, ...) to
 * emit events from your own instances or just log the diagnostic messages.
 *
 * This client also offers a Dropbox.stats object for futher statistical information. If no custom stats
 * object is provided static {@link Dropbox.stats} object will be updated. This can be used to keep track of
 * stats per user account etc.
 *
 * @emits log
 * @emits retry
 */
class Dropbox {
  /**
   * Low level request API.
   *
   * Use higher level methods instead.
   *
   * @see {@link Dropbox.rpcRequest}
   * @see {@link Dropbox.download}
   * @see {@link Dropbox.upload}
   *
   * @static
   * @param {object} options
   * {<br>
   *  accessToken: {string},<br>
   *  uri: {string},<br>
   *  upload: {string\|Readable},<br>
   *  download: {string\|Writable},<br>
   *  parameters: {Object}<br>
   * }
   * @param {EventEmitter2.emit} emit Emit function.
   * @param {Object} stats Custom stat object
   * @return {Promise<Object>} Resolves with the response body (for rpcRequests)
   * Rejects with {Dropbox.RequestError}
   */
  static rawRequest(options, emit, stats) {
    emit  = emit || Dropbox.DefaultEmitter;
    stats = stats || Dropbox.stats;
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

        // rawRequest option defaults
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

        // prepare request options
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
          if (Object.keys(options.parameters).length === 0) {
            // dropbox requires you to send null as a non-JSON encoded string when
            // the parameters object is empty.
            // Not a JSON encoded "null" (including quotes) but a vanilla null as a string.
            // this has a complication, see this promise's then below.
            requestOptions.json = false;
            requestOptions.body = 'null';
          } else {
            requestOptions.json = true;
            requestOptions.body = options.parameters;
          }
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
                return reject(new Retry(options, emit, stats, wait * 1000));
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
                return reject(new Retry(options, emit, stats));
              }
              default: {
                let errorMessage = '';
                response.on('data', chunk => {
                  errorMessage += chunk;
                });
                response.on('end', () => {
                  reject(new Dropbox.RequestError(`HTTP Error ${response.statusCode}: ${errorMessage}`, options));
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
          // resolve(Dropbox.rawRequest(options, emit, stats));
          reject(new Retry(options, emit, stats));
        })
        .on('complete', (response, body) => {
          resolve(body);
        });
      })
      .then(result => {
        stats.completed++;
        // dropbox api requires you send plain string "null" (without the quotes)
        // when sending an empty parameters object instead of JSON.stringify()ing it
        // as usual. When doing that we set .json = false for the request...
        // which results in the response not being JSON.parse()d so, here, we are
        // working around that
        try {
          result = JSON.parse(result);
        } catch (e) {
          emit('log', 'JSON parse failed', e);
        }
        return result;
      })
      .catch(Retry, retry => {
        return Promise.delay(retry.delay)
        .then(() => Dropbox.rawRequest(retry.options, retry.emit, retry.stats));
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

  static initStats(from) {
    let stat = {
      flight   : 0,
      pending  : 0,
      completed: 0,
      errors   : 0,
      retries  : 0
    };
    return Object.assign(stat, from || {});
  }

  /**
   * Dropbox RPC request
   *
   * @static
   * @param {string} accessToken
   * @param {string} endpoint Endpoint without the preceeding slash, ex: 'users/get_account'
   * @param {object} parameters
   * @param {any} [emit=Dropbox.events.emit.bind(Dropbox.events)]
   * @return {Promise} See rawRequest
   */
  static rpcRequest(accessToken, endpoint, parameters, emit, stats) {
    parameters = parameters || {};
    emit = emit || Dropbox.DefaultEmitter;
    stats = stats || Dropbox.stats;
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
   * Note:
   * Previously destination was strictly a strem.Writable, it provided the flexibility to
   * download to Buffer streams or anything streamy but that requires file descriptors
   * to be opened before being passed to DropboxUer.download().
   * Then the requests were throttled and downloaded accordingly. During this
   * whole process, file descriptors were closed one by one as the downloads
   * are completed. So, if you were to queue 20k downloads, 20k file descriptors
   * would be opened initially (it can't be since most OSes won't let you).
   * So, instead, we have to add support to a less elegant API, and support receiving
   * destination file as a path too. In this case, file descriptor is only opened when
   * the actual download starts.
   *
   * @param {string} accessToken
   * @param {string} src Dropbox src identifier (could be path or id)
   * @param {string|stream.Writable} dst Path or Writable stream to save the downloaded file to.
   * @param {object} options Dropbox options
   * @return {Promise} A promise that resolves to destionation stream
   */
  static download(accessToken, src, dst, parameters, emit, stats) {
    parameters = parameters || {};
    emit = emit || Dropbox.DefaultEmitter;
    stats = stats || Dropbox.stats;
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
   * Uploads a file to the cloud.
   *
   * https://www.dropbox.com/developers/documentation/http/documentation#files-upload
   * @param {string} accessToken Access token
   * @param {string|stream.Readable} src Readable stream to upload
   * @param {string} dstPath Upload destination
   * @param {object} parameters Dropbox options
   * @return {Promise} A promise that resolves to undefined
   */
  static upload(accessToken, src, dstPath, parameters, emit, stats) {
    parameters = parameters || {};
    emit = emit || Dropbox.DefaultEmitter;
    stats = stats || Dropbox.stats;
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
 * Throttles HTTP API requests per account id.
 *
 * NOTE: npm package limiter is buggy https://github.com/jhurliman/node-rate-limiter/issues/25
 * Yet, the default value is a sweet spot for Dropbox API, so it should be fine, for now.
 *
 * @default is 600 requests per minute. With 600 request burst capacity.
 *
 * @static
 */
Dropbox.THROTTLER = new Throttler(600, 60000);

/**
 * HTTPS agent to be used for the communication.
 */
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
  constructor(msg, options, error) {
    // Do not leak access token
    options.accessToken = '<access token>';
    super(msg);
    this.options = options;
    this.error = error || null;
  }
};

/**
 * If you haven't provided a custom emit function, this object will be used to
 * emit diagnostic messages.
 * @static
 */
Dropbox.events = new EventEmitter2();

/**
 * Default emitter
 */
Dropbox.DefaultEmitter = Dropbox.events.emit.bind(Dropbox.events);

/**
 * Stats object will have up to date statistical information about the requests that
 * have been made so far.
 */
Dropbox.stats = {};

/**
 * Stats on how many requests are on actually sent and on the fly. The rest of may be queued up
 * by the throttler.
 * @see {@link Dropbox.stats.pending}
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
