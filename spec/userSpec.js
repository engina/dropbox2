'use strict';

const test = require('tape');
const mock = require('mock-fs');
const nock = require('nock');
const fixtures = require('./fixtures/index');
const Promise = require('bluebird');
const fse = Promise.promisifyAll(require('fs'));

const Dropbox = require('../src/dropbox');
const User = require('../src/user');
const Throttler = require('../src/throttler');

nock.disableNetConnect();

process.on("unhandledRejection", function(reason, promise) {
  // See Promise.onPossiblyUnhandledRejection for parameter documentation
  console.error('Unhandled Rejection', reason);
});

function debug(str) {
  console.log.bind(console, [new Date().toTimeString()].concat(arguments));
}

function n(endpoint, opts) {
  return nock('https://api.dropboxapi.com', {
    // verify that every request should have an access token
    reqheaders: {
      Authorization: value => {
        if (value === ('Bearer ' + fixtures.dropbox.authInfo.access_token + '\n')) {
          throw new Error(`Invalid Authorization header ${value}`);
        }
        return true;
      }
    }
  }).post('/2/' + endpoint, opts);
}

test('dropbox error handling', t => {
  let sync = new User('newfolder' /* and no access token */);
  sync.sync()
  .then(() => {
    t.fail('should detect missing configuration');
  })
  .catch(User.Error, error => {
    t.pass('should detect missing configuration');
  })
  .catch(error => {
    t.pass('should detect missing configuration');
  })
  .finally(() => {
    t.end();
  });
});

test('dropbox test suite #1 sync ~600 files', t => {
  mock({});
  // test create
  let sync = new User('somefolder', fixtures.dropbox.authInfo.access_token);
  sync.getCursor()
  .then(cursor => {
    t.equal(cursor, null, 'should return null for a cursor since this is the first run');
  })
  .then(() => {
    t.equal(sync.stats.completed, 0, 'should have zero instance stats.complete');
  })
  .then(() => {
    n('files/list_folder')
    .reply(200, fixtures.dropbox.responses.files$list_folder);

    return sync.delta()
    .then(result => {
      t.deepEqual(result.allEntries,
                  fixtures.dropbox.responses.files$list_folder.entries,
                  'should return proper entries');
      t.equal(result.cursor,
              'AAGagXT71XL4J6Gd_uoJjLbssY8cbR2p4czWIaUxBgtmjzcC10Kin23pH5rIzANrMIRxVx5nUC_dcBRuz0Q_sPNIUEklay-SYNxDzUf5IsnrrjRiEY3hUeTQkxfiVQXPuEzixS0J_P0ZhbUb-XmbMinB',
              'should return correct cursor value');
      t.ok(result.has_more === undefined, 'should not have has_more property');
      t.equal(sync.stats.completed, 1, 'should have instance stats.completed = 1');
    });
  })
  .then(() => {
    n('files/list_folder')
    .reply(200, fixtures.dropbox.responses.files$list_folder);
    // this is the test data
    let allEntries = fixtures.dropbox.responses.files$list_folder.entries;
    let files = allEntries.filter(e => e['.tag'] === 'file');

    let startTime;
    let lastTime;
    let count = 0;
    let http500 = 0;
    let simulatedErrors = (files.length + 50) / 100 | 0;
    nock('https://content.dropboxapi.com')
    .post('/2/files/download')
    .times(files.length + simulatedErrors)
    .reply(function(uri, requestBody) {
      count++;
      if (!startTime) {
        startTime = Date.now();
      }
      lastTime = Date.now();
      // https://github.com/node-nock/nock#header-field-names-are-case-insensitive
      let req = JSON.parse(this.req.headers['dropbox-api-arg']);
      if (req.path === undefined || typeof req.path !== 'string') {
        throw new Error('Dropbox-API-Arg HTTP Header should be set for download/uploads.');
      }
      let buf = '';
      for (let i = 0; i < 1024; i++) {
        buf += `${req.path}\n`;
      }
      // fake a http 500 in every 100th download attempt
      if ((count % 100) === 50) {
        http500++;
        return [500, 'Internval Server Error'];
      }
      return [200, buf];
    });

    let syncTasks = {};
    let eventStats = {};
    function eventVerifier(event, value) {
      if (eventStats[event] === undefined)
        eventStats[event] = 0;
      eventStats[event]++;
      if (event === 'sync-tasks') {
        syncTasks = value;
      }
    }
    sync.onAny(eventVerifier);

    return sync.sync().then(result => {
      sync.offAny(eventVerifier);
      let elapsed = lastTime - startTime;
      let actualRate = result.downloads.length / elapsed * 1000 | 0;
      t.ok(actualRate > 500, 'should support burst');
      t.equal(http500, simulatedErrors, 'should simulate calculated amount of HTTP 500');
      t.equal(sync.stats.retries, http500, 'should retry on http 500');
      // two calls to files/list_folder and then download requests
      t.equal(sync.stats.completed, 2 + files.length, 'should have stats.completed');
      t.deepEqual(result.downloads.length, files.length, 'should have same amount of file entries');
      t.equal(eventStats['sync-file-downloaded'], files.length, 'should fire sync-file-downloaded');
      t.equal(eventStats['sync-start'], 1, 'should fire sync-start once');
      t.equal(eventStats['retry'], sync.stats.retries, 'should fire retry event for each retry attempt');
      let fail = false;
      for (let file of syncTasks.downloads) {
        let actual = fse.readFileSync(file.absolutePath, 'utf8');
        let expected = '';
        for (let i = 0; i < 1024; i++) {
          expected += `${file.id}\n`;
        }
        if (actual !== expected) {
          debug('Download error', file.absolutePath, actual, expected);
          fail = true;
          break;
        }
      }
      t.ok(fail === false, 'should download files reliably');
    });
  })
  .then(() => {
    return sync.getCursor(cursor => {
      t.equal(cursor, fixtures.dropbox.responses.files$list_folder.cursor, 'should have its cursor updated');
    });
  })
  .catch(Dropbox.RequestError, error => {
    t.fail('should not reject with unexcepted error');
    console.log(error);
  })
  .finally(() => {
    mock.restore();
    t.end();
  });
});

test('dropbox test suite #2 sync 10k files', t => {
  mock({});
  // disable throttler, we'll test the throttler later
  Dropbox.THROTTLER = new Throttler(60000, 60000);
  n('users/get_account')
  .reply(200, fixtures.dropbox.responses.users$get_account);

  let sync = new User('local', fixtures.dropbox.authInfo.access_token);
  n('files/list_folder')
  .reply(200, fixtures.dropbox.responses.files$list_folder_big);

  n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder_big.cursor)
  .reply(200, fixtures.dropbox.responses.files$list_folder$cont[0]);

  n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[0].cursor)
  .reply(200, fixtures.dropbox.responses.files$list_folder$cont[1]);

  n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[1].cursor)
  .reply(200, fixtures.dropbox.responses.files$list_folder$cont[2]);

  n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[2].cursor)
  .reply(200, fixtures.dropbox.responses.files$list_folder$cont[3]);

  n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[3].cursor)
  .reply(200, fixtures.dropbox.responses.files$list_folder$cont[4]);
  let allEntries = fixtures.dropbox.responses.files$list_folder_big.entries;
  allEntries = allEntries.concat(fixtures.dropbox.responses.files$list_folder$cont[0].entries);
  allEntries = allEntries.concat(fixtures.dropbox.responses.files$list_folder$cont[1].entries);
  allEntries = allEntries.concat(fixtures.dropbox.responses.files$list_folder$cont[2].entries);
  allEntries = allEntries.concat(fixtures.dropbox.responses.files$list_folder$cont[3].entries);
  allEntries = allEntries.concat(fixtures.dropbox.responses.files$list_folder$cont[4].entries);

  let files = allEntries.filter(e => e['.tag'] === 'file');
  let folders = allEntries.filter(e => e['.tag'] === 'folder');

  let startTime;
  let lastTime;
  let count = 0;
  let http500 = 0;
  let simulatedErrors = (files.length + 50) / 100 | 0;
  // if simulated errors are more than a hundred, they'll cause
  // another http500!
  simulatedErrors += simulatedErrors / 100 | 0;
  nock('https://content.dropboxapi.com')
  .post('/2/files/download')
  .times(files.length + simulatedErrors)
  .reply(function(uri, requestBody) {
    count++;
    if (!startTime) {
      startTime = Date.now();
    }
    lastTime = Date.now();
    // https://github.com/node-nock/nock#header-field-names-are-case-insensitive
    let req = JSON.parse(this.req.headers['dropbox-api-arg']);
    if (req.path === undefined || typeof req.path !== 'string') {
      throw new Error('Dropbox-API-Arg HTTP Header should be set for download/uploads.');
    }
    // fake a http 500 in every 100th download attempt
    if ((count % 100) === 50) {
      http500++;
      return [500, 'Internval Server Error'];
    }
    let buf = '';
    for (let i = 0; i < 1024; i++) {
      buf += `${req.path}\n`;
    }
    return [200, buf];
  });

  let syncTasks = {};
  let eventStats = {};
  function eventVerifier(event, value) {
    if (eventStats[event] === undefined)
      eventStats[event] = 0;
    eventStats[event]++;
    if (event === 'sync-tasks') {
      syncTasks = value;
    }
  }
  sync.onAny(eventVerifier);
  sync.sync().then(result => {
    sync.offAny(eventVerifier);
    t.equal(http500, simulatedErrors, 'should simulate calculated amount of HTTP 500');
    t.equal(sync.stats.retries, http500, 'should retry on http 500');
    // 6 calls to files/list_folder + downloads
    t.equal(sync.stats.completed, 6 + files.length, 'should have correct stats.completed');
    t.deepEqual(result.downloads.length, files.length, 'should have same amount of file entries');
    t.equal(eventStats['sync-file-downloaded'], files.length, 'should fire sync-file-downloaded');
    t.equal(eventStats['sync-start'], 1, 'should fire sync-start once');
    t.equal(eventStats['retry'], sync.stats.retries, 'should fire retry event for each retry attempt');
    let fail = false;
    for (let file of syncTasks.downloads) {
      let actual = fse.readFileSync(file.absolutePath, 'utf8');
      let expected = '';
      for (let i = 0; i < 1024; i++) {
        expected += `${file.id}\n`;
      }
      if (actual !== expected) {
        debug('Download error', file.absolutePath, actual, expected);
        fail = true;
        break;
      }
    }
    t.ok(fail === false, 'should download files reliably');
    t.equal(syncTasks.folders.length, folders.length, 'should extract folders from the delta');
    let dirFail = false;
    for (let folder of syncTasks.folders) {
      if (!fse.statSync(folder.absolutePath).isDirectory()) {
        dirFail = true;
      }
    }
    t.ok(dirFail === false, 'should create the directorties');
  })
  .then(() => {
    n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[4].cursor)
    .reply(200, fixtures.dropbox.responses.files$list_folder$cont[5]);

    n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[5].cursor)
    .reply(200, fixtures.dropbox.responses.files$list_folder$cont[6]);

    n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[6].cursor)
    .reply(200, fixtures.dropbox.responses.files$list_folder$cont[7]);

    // do NOT delete files with 1xxx.txt name. Should 1000 of them.
    let syncFilter = file => /1\d{3}\.txt/i.test(file.name) === false;
    return sync.sync(syncFilter).then(result => {
      t.equal(result.deletes.length, 3500, 'should extract delete information from delta with filter');
      let deleteFail = false;
      for (let deleted of result.deletes) {
        try {
          fse.statSync(deleted.absolutePath);
          deleteFail = true;
        } catch (error) {
          if (error.code !== 'ENOENT') {
            deleteFail = true;
          }
        }
      }
      t.ok(deleteFail === false, 'should delete the files');
    });
  })
  .then(() => {
    return sync.getCursor(cursor => {
      t.equal(cursor, fixtures.dropbox.responses.files$list_folder.cursor, 'should have its cursor updated');
    });
  })
  .finally(() => {
    mock.restore();
    t.end();
  });
});
