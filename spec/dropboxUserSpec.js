'use strict';
const test = require('tape');
const nock = require('nock');
const mock = require('mock-fs');
const fixtures = require('./fixtures/index');
const Promise = require('bluebird');
const fse = Promise.promisifyAll(require('fs'));

const Dropbox = require('../src/dropbox');
const DropboxUser = require('../src/dropboxUser');
const Throttler = require('../src/throttler');

nock.disableNetConnect();

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

test('dropboxUser error handling', t => {
  mock();
  let testMessage = 'should throw exception with invalid account id';
  try {
    let user = new DropboxUser('../../sensitive_directory');
    if (user)
      t.fail(testMessage);
  } catch (err) {
    t.equal(err.message, 'Account id must be a string of 40 characters.', testMessage);
  }

  testMessage = 'should throw exception with empty account id';
  try {
    let user = new DropboxUser('');
    if (user)
      t.fail(testMessage);
  } catch (err) {
    t.equal(err.message, 'Account id must be a string of 40 characters.', testMessage);
  }

  n('users/get_account')
  .reply(200, fixtures.dropbox.responses.users$get_account_fail);

  testMessage = 'should reject for non verified email';
  DropboxUser.create(fixtures.dropbox.authInfo)
  .then(() => {
    t.fail(testMessage);
  })
  .catch(err => {
    t.equal(err.message, 'Dropbox user email not verified', testMessage);
  })
  .finally(() => {
    t.end();
    mock.restore();
  });
});

test('dropbox test suite #1 sync ~600 files', t => {
  mock(fixtures.fs);
  // test create
  n('users/get_account')
  .reply(200, fixtures.dropbox.responses.users$get_account);

  DropboxUser.create(fixtures.dropbox.authInfo)
  .then(user => {
    t.equal(user.stats.completed, 0, 'should have zero instance stats.complete');
    return user.getWhois().then(result => {
      t.deepEqual(result, fixtures.dropbox.responses.users$get_account, 'should save whois information');
      return user;
    });
  })
  .then(user => {
    return user.getAuth().then(auth => {
      t.deepEqual(auth, fixtures.dropbox.authInfo, 'should save authInfo');
      return user;
    });
  })
  .then(user => {
    return user.getCursor()
    .then(cursor => {
      t.equal(cursor, null, 'should return null for a cursor since this is the first run');
      return user;
    });
  })
  .then(user => {
    return DropboxUser.list().then(userList => {
      t.deepEqual(userList, [fixtures.dropbox.authInfo.account_id], 'should list created users');
      return user;
    });
  })
  .then(user => {
    t.equal(user.toString(), `DropboxUser ${fixtures.dropbox.authInfo.account_id}`, 'should have meaningful toString()');
    return user;
  })
  .then(user => {
    t.equal(user.stats.completed, 0, 'should have zero instance stats.complete');
    return user;
  })
  .then(user => {
    n('files/list_folder')
    .reply(200, fixtures.dropbox.responses.files$list_folder);

    return user.delta()
    .then(result => {
      t.deepEqual(result.allEntries,
                  fixtures.dropbox.responses.files$list_folder.entries,
                  'should return proper entries');
      t.equal(result.cursor,
              'AAGagXT71XL4J6Gd_uoJjLbssY8cbR2p4czWIaUxBgtmjzcC10Kin23pH5rIzANrMIRxVx5nUC_dcBRuz0Q_sPNIUEklay-SYNxDzUf5IsnrrjRiEY3hUeTQkxfiVQXPuEzixS0J_P0ZhbUb-XmbMinB',
              'should return correct cursor value');
      t.ok(result.has_more === undefined, 'should not have has_more property');
      t.equal(user.stats.completed, 1, 'should have instance stats.completed = 1');
      return user;
    });
  })
  .then(user => {
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
    user.onAny(eventVerifier);

    return user.sync().then(result => {
      user.offAny(eventVerifier);
      let elapsed = lastTime - startTime;
      let actualRate = result.downloads.length / elapsed * 1000 | 0;
      t.ok(actualRate > 500, 'should support burst');
      t.equal(http500, simulatedErrors, 'should simulate calculated amount of HTTP 500');
      t.equal(user.stats.retries, http500, 'should retry on http 500');
      // two calls to files/list_folder and then download requests
      t.equal(user.stats.completed, 2 + files.length, 'should have stats.completed');
      t.deepEqual(result.downloads.length, files.length, 'should have same amount of file entries');
      t.equal(eventStats['sync-file-downloaded'], files.length, 'should fire sync-file-downloaded');
      t.equal(eventStats['sync-start'], 1, 'should fire sync-start once');
      t.equal(eventStats['retry'], user.stats.retries, 'should fire retry event for each retry attempt');
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
      return user;
    });
  })
  .then(user => {
    return user.getCursor(cursor => {
      t.equal(cursor, fixtures.dropbox.responses.files$list_folder.cursor, 'should have its cursor updated');
      return user;
    });
  })
  .catch(Dropbox.RequestError, error => {
    t.fail('should not reject with unexcepted error');
    console.log(error);
  })
  .finally(() => {
    t.end();
    mock.restore();
  });
  // test web hooks
  // test web hook signature
});

test('dropbox test suite #2 sync 10k files', t => {
  // disable throttler, we'll test the throttler later
  Dropbox.THROTTLER = new Throttler(60000, 60000);
  mock(fixtures.fs);
  n('users/get_account')
  .reply(200, fixtures.dropbox.responses.users$get_account);

  DropboxUser.create(fixtures.dropbox.authInfo)
  .then(user => {
    return user.getWhois().then(result => {
      t.deepEqual(result, fixtures.dropbox.responses.users$get_account, 'should save whois information');
      return user;
    });
  })
  .then(user => {
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
    user.onAny(eventVerifier);
    return user.sync().then(result => {
      user.offAny(eventVerifier);
      t.equal(http500, simulatedErrors, 'should simulate calculated amount of HTTP 500');
      t.equal(user.stats.retries, http500, 'should retry on http 500');
      // 6 calls to files/list_folder + downloads
      t.equal(user.stats.completed, 6 + files.length, 'should have correct stats.completed');
      t.deepEqual(result.downloads.length, files.length, 'should have same amount of file entries');
      t.equal(eventStats['sync-file-downloaded'], files.length, 'should fire sync-file-downloaded');
      t.equal(eventStats['sync-start'], 1, 'should fire sync-start once');
      t.equal(eventStats['retry'], user.stats.retries, 'should fire retry event for each retry attempt');
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
      return user;
    });
  })
  .then(user => {
    n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[4].cursor)
    .reply(200, fixtures.dropbox.responses.files$list_folder$cont[5]);

    n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[5].cursor)
    .reply(200, fixtures.dropbox.responses.files$list_folder$cont[6]);

    n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder$cont[6].cursor)
    .reply(200, fixtures.dropbox.responses.files$list_folder$cont[7]);

    // do not delete files with 1xxx.txt name. Should 1000 of them.
    let syncFilter = file => !/1\d{3}\.txt/i.test(file.name);
    return user.sync(syncFilter).then(result => {
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
      return user;
    });
  })
  .then(user => {
    return user.getCursor(cursor => {
      t.equal(cursor, fixtures.dropbox.responses.files$list_folder.cursor, 'should have its cursor updated');
      return user;
    });
  })
  .finally(() => {
    t.end();
    mock.restore();
  });
});

test('dropboxUser sync concurrency support', t => {
  mock(fixtures.fs);
  // test create
  n('users/get_account')
  .reply(200, fixtures.dropbox.responses.users$get_account);

  n('files/list_folder')
  .reply(200, fixtures.dropbox.responses.files$list_folder);
  let files = fixtures.dropbox.responses.files$list_folder.entries.filter(e => e['.tag'] === 'file');

  nock('https://content.dropboxapi.com')
  .post('/2/files/download')
  .times(files.length)
  .reply(200, ['hello']);

  n('files/list_folder/continue', body => body.cursor === fixtures.dropbox.responses.files$list_folder.cursor)
  .reply(200, fixtures.dropbox.responses.files$list_folder$cont[8]);

  DropboxUser.create(fixtures.dropbox.authInfo)
  .then(user => {
    let sync1 = user.sync();
    let sync2 = user.sync();
    return Promise.all([sync1, sync2])
    .then(([result1, result2]) => {
      t.equal(result1.downloads.length, files.length, 'should should do sync operations sequentially');
      t.equal(result2.downloads.length, 0, 'should return second sync result as empty');
      return user;
    });
  })
  .then(user => {
    nock('https://api.dropboxapi.com')
    .post('/2/files/list_folder/continue')
    .times(DropboxUser.MAX_SYNC_QUEUE + 1)
    .reply(200, fixtures.dropbox.responses.files$list_folder$cont[8]);
    for (let i = 0; i < DropboxUser.MAX_SYNC_QUEUE; i++) {
      user.sync();
    }
    return user.sync()
    .then(() => {
      t.fail('should throw SyncError');
    })
    .catch(DropboxUser.SyncError, error => {
      t.pass('should throw SyncError');
    });
  })
  .catch(error => {
    console.log(error);
    t.fail('should not fail');
  })
  .finally(() => {
    mock.restore();
    t.end();
  });
});
