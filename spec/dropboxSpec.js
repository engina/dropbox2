'use strict';

const tape = require('tape');
const nock = require('nock');
const Promise = require('bluebird');
const fs  = Promise.promisifyAll(require('fs'));

// Will be freshly loaded for each test
let Dropbox;

nock.disableNetConnect();
const Util = require('util');
console.log('initial cache',
  Util.inspect(
    Object.keys(require.cache).filter(key => key.indexOf('src/dropbox') !== -1),
    {maxArrayLength: 500}
  )
);

// Test wrapper
function test(testName, testBody, testFunction = tape) {
  // Run the test via tape
  testFunction(testName, t => {
    // mock();
    nock.cleanAll();
    Dropbox = require('../src/dropbox');
    Dropbox.events.on('log', (msg, options, error) => {
      // console.log(`LOG [${testName}]`, msg, options, error);
    });
    // Run the actual test body which always returns a promise.
    let testResult = testBody(t);
    if (testResult === undefined || testResult.then === undefined || typeof testResult.then !== 'function') {
      throw new Error(`Test '${testName}' does not return a blurbird promise.`);
    }
    testResult.finally(() => {
      // mock.restore();
      t.end();
    });
  });
}

test.only = (testName, testBody) => {
  return test(testName, testBody, tape.only);
};

test('dropox base request method', t => {
  let test1msg = 'should reject when no access token is present';
  let test1 = Dropbox.rawRequest({})
  .then(() => {
    t.fail(test1msg);
  })
  .catch(Dropbox.RequestError, err => {
    t.equal(err.message, 'Access token is required.', test1msg);
  });

  let test2msg = 'should reject when upload and download parameters are used at the same time';
  let test2 = Dropbox.rawRequest({
    accessToken: 'foo',
    download: 'path',
    upload: 'path'
  })
  .then(() => {
    t.fail(test2msg);
  })
  .catch(Dropbox.RequestError, err => {
    t.equal(err.message, 'You cannot upload and download at the same time.', test2msg);
  });

  nock('https://api.dropboxapi.com')
  .post('/2/test/endpoint')
  .reply(function(uri, requestBody) {
    // https://github.com/node-nock/nock#header-field-names-are-case-insensitive
    t.equal(this.req.headers.authorization, 'Bearer foo', 'should send access token');
    t.equal(requestBody.test, 'parameter', 'should send parameters');
    return [200, JSON.stringify({message: 'received'})];
  });
  let test3 = Dropbox.rawRequest({
    uri: 'https://api.dropboxapi.com/2/test/endpoint',
    accessToken: 'foo',
    parameters: {
      test: 'parameter'
    }
  })
  .then(response => {
    t.deepEqual(response, {message: 'received'}, 'should receive parameters');
  })
  .catch(Dropbox.RequestError, err => {
    t.fail('should not fail');
  });

  return Promise.all([test1, test2, test3]);
});

test('dropbox download', t => {
  let testData = '';
  for (let i = 0; i < 1024 * 10; i++) {
    testData += String(i);
  }
  nock('https://content.dropboxapi.com')
  .post('/2/files/download')
  .times(4)
  .reply(function(uri, requestBody) {
    // https://github.com/node-nock/nock#header-field-names-are-case-insensitive
    let req = JSON.parse(this.req.headers['dropbox-api-arg']);
    if (req.path === undefined || typeof req.path !== 'string') {
      t.fail('should set Dropbox-API-Arg HTTP Header');
      return;
    }
    t.pass('should set Dropbox-API-Arg HTTP Header');
    return [200, testData];
  });

  let test1 = Dropbox.download('dummyAccessToken', '/file/on/the/cloud', './.tmp1~')
  .then(result => {
    let actual = fs.readFileSync('./.tmp1~', 'utf8');
    fs.unlinkSync('./.tmp1~');
    t.equal(actual, testData, 'should download to file path');
  });

  let test2 = Dropbox.download('dummyAccessToken', '/file/on/the/cloud', fs.createWriteStream('./.tmp2~'))
  .then(result => {
    let actual = fs.readFileSync('./.tmp2~', 'utf8');
    fs.unlinkSync('./.tmp2~');
    t.equal(actual, testData, 'should download to write stream');
  });

  let test3msg = 'should reject gracefully if there is an error with the download destination';
  let test3 = Dropbox.download('dummyAccessToken', '/file/on/the/cloud', '/permission/denied')
  .then(result => {
    t.fail(test3msg);
  })
  .catch(Dropbox.RequestError, error => {
    t.equal(error.message, 'There was an error with the download write stream.', test3msg);
  });

  let test4msg = 'should reject gracefully if download parameter is not a stream or path';
  let test4 = Dropbox.download('dummyAccessToken', '/file/on/the/cloud', 31337)
  .then(result => {
    t.fail(test4msg);
  })
  .catch(Dropbox.RequestError, error => {
    t.equal(error.message, 'Download file must be a file path or stream.Writable.', test4msg);
  });
  return Promise.all([test1, test2, test3, test4]);
});

test('dropbox upload', t => {
  let testData = '';
  for (let i = 0; i < 1024 * 10; i++) {
    testData += String(i);
  }
  fs.writeFileSync('./.tmp~', testData);
  nock('https://content.dropboxapi.com')
  .post('/2/files/upload')
  .times(2)
  .reply(function(uri, requestBody) {
    // https://github.com/node-nock/nock#header-field-names-are-case-insensitive
    t.ok(this.req.headers['dropbox-api-arg'] !== undefined, 'should set Dropbox-API-Arg HTTP Header');
    let req;
    try {
      req = JSON.parse(this.req.headers['dropbox-api-arg']);
    } catch (e) {
      t.fail('should have Dropbox-API-Arg jasonified properly');
    }
    t.equal(req.path, '/path/on/the/cloud', 'should set path');
    t.pass('should set Dropbox-API-Arg HTTP Header');
    t.equal(this.req.headers['content-type'], 'application/octet-stream', 'should set HTTP Content-Type');
    t.equal(requestBody, testData, 'should upload the payload');
    return [200, testData];
  });

  let test1 = Dropbox.upload('dummyAccessToken', './.tmp~', '/path/on/the/cloud')
  .catch(error => {
    t.fail('should be able to upload via path without errors');
  });

  let test2 = Dropbox.upload('dummyAccessToken', fs.createReadStream('./.tmp~'), '/path/on/the/cloud')
  .catch(() => {
    t.fail('should be able to upload via stream.Readable without errors');
  });

  return Promise.all([test1, test2])
  .finally(() => {
    fs.unlinkSync('./.tmp~');
  });
});

test('dropbox upload error handling', t => {
  nock('https://content.dropboxapi.com')
  .post('/2/files/upload')
  .times(2)
  .reply(200);
  let test1msg = 'should reject gracefully if there is an error with the upload source';
  let test1 = Dropbox.upload('dummyAccessToken', '/no/permission', '/path/on/the/cloud')
  .then(() => {
    t.fail(test1msg);
  })
  .catch(Dropbox.RequestError, error => {
    t.equal(error.message, 'There was an error with the upload readble stream.', test1msg);
  });

  let test2msg = 'should reject gracefully the upload source is not a stream or file path';
  let test2 = Dropbox.upload('dummyAccessToken', 31337, '/path/on/the/cloud')
  .then(() => {
    t.fail(test2msg);
  })
  .catch(Dropbox.RequestError, error => {
    t.equal(error.message, 'Upload file must be a file path or stream.Readable.', test2msg);
  });

  return Promise.all([test1, test2]);
});

test('dropbox on HTTP 429 Error', t => {
  const WAIT = 2;
  let requests = [];
  nock('https://api.dropboxapi.com')
  .post('/2/test/endpoint')
  .times(Dropbox.MAX_RETRY + 1)
  .reply(function(uri, requestBody) {
    process.stderr.write('.');
    requests.push(Date.now());
    if (requests.length <= Dropbox.MAX_RETRY) {
      return [429, {message: 'Rate limited'}, {'retry-after': WAIT}];
    }
    process.stderr.write('\n');
    return [200, {message: 'ok'}];
  });

  let retry = 0;
  Dropbox.events.on('retry', () => {
    retry++;
  });
  let stats = Dropbox.initStats();
  return Dropbox.rpcRequest('dummyAccessToken', 'test/endpoint', {}, Dropbox.DefaultEmitter, stats)
  .then(response => {
    t.equal(retry, Dropbox.MAX_RETRY, 'should emit rate-limited events');
    let elapsed = requests[Dropbox.MAX_RETRY] - requests[0];
    let actualInterval = elapsed / (requests.length - 1);
    let expectedInterval = WAIT * 1000;
    let ratio = actualInterval / expectedInterval;
    t.ok(ratio > 0.95 && ratio < 1.05, 'should respect 429 wait time');
    t.equal(response.message, 'ok', 'should get the response after retries');
  })
  .finally(() => {
    t.equal(stats.retries, Dropbox.MAX_RETRY, 'should update stats.retries');
    t.equal(stats.completed, 1, 'should not include retries in the stats.completed');
  });
});

test('dropbox on too many retries', t => {
  nock('https://api.dropboxapi.com')
  .post('/2/test/endpoint')
  .times(6)
  .reply(500, 'Interval Server Error');

  let stats = Dropbox.initStats();
  return Dropbox.rpcRequest('dummyAccessToken', 'test/endpoint', {}, Dropbox.DefaultEmitter, stats)
  .then(response => {
    t.fail('should not resolve');
  })
  .catch(Dropbox.RequestError, error => {
    t.equal(error.message, 'Too many errors for request', 'should reject with Dropbox.RequestError');
  })
  .catch(error => {
    console.log(error);
    t.fail('should only reject with Dropbox.RequestError');
  })
  .finally(() => {
    t.equal(stats.retries, Dropbox.MAX_RETRY, 'should update stats.retries');
  });
});

test('dropbox socket error', t => {
  nock('https://api.dropboxapi.com')
  .post('/2/test/socketerror')
  .times(6)
  .reply(function(uri, body) {
    this.req.emit('error', 'Simulated error');
    this.req.end();
  });
  return Dropbox.rpcRequest('dummyAccessToken', 'test/socketerror')
  .then(response => {
    t.fail('should not resolve');
  })
  .catch(Dropbox.RequestError, error => {
    t.equal(error.message, 'Too many errors for request', 'should reject with Dropbox.RequestError2');
    t.equal(Dropbox.stats.retries, Dropbox.MAX_RETRY, 'should update stats.retries');
  })
  .catch(error => {
    t.fail('should only reject with Dropbox.RequestError');
  });
});

test('dropbox on permanent (4xx) errors', t => {
  nock('https://api.dropboxapi.com')
  .post('/2/test/permanentError')
  .reply(400, 'Permenant error, such as endpoint specific parameter error');

  let stats = Dropbox.initStats();
  return Dropbox.rpcRequest('dummyAccessToken', 'test/permanentError', {}, Dropbox.DefaultEmitter, stats)
  .catch(Dropbox.RequestError, err => {
    t.equal(err.message, 'HTTP Error 400: Permenant error, such as endpoint specific parameter error', 'should relay the error message');
    t.equal(stats.retries, 0, 'should not retry');
    t.equal(stats.errors, 1, 'should update stats.errors');
  });
});

test('dropbox throttle', t => {
  let requests = [];
  nock('https://api.dropboxapi.com')
  .post('/2/test/throttle')
  .times(700)
  .reply(function(uri, requestBody) {
    process.stderr.write('.');
    requests.push(Date.now());
    return [200, {everyting: 'is fine'}];
  });

  let requestJobs = [];
  for (let i = 0; i < 700; i++) {
    requestJobs.push(Dropbox.rpcRequest('foo', 'test/throttle'));
  }
  return Promise.all(requestJobs)
  .then(() => {
    process.stderr.write('\n');
    let first600 = requests[599] - requests[0];
    let last100 = requests[699] - requests[600];
    t.ok(first600 < 1000, 'should do burst ' + first600);
    t.ok(last100 > 8000, 'should slow down after burst ' + last100);
  })
  .catch(() => {
    t.fail('should not cause any trouble');
  });
});
