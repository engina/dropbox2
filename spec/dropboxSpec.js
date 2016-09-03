const test = require('tape');
const nock = require('nock');
const mock = require('mock-fs');
const fixtures = require('./fixtures/index');
const ProgressBar = require('progress');
const Promise = require('bluebird');
const fse = Promise.promisifyAll(require('fs-extra'));
const rcc = require('require-cache-control');
const Throttler = require('../src/throttler');

nock.disableNetConnect();

function debug(str) {
  console.log(new Date().toTimeString(), ...arguments);
}

function n(endpoint, opts) {
  return nock('https://api.dropboxapi.com', {
    // verify that every request should have an access token
    reqheaders: {
      Authorization: value => {
        if (value.startsWith('Bearer') === false ||
            value.indexOf(fixtures.dropbox.authInfo.access_token) === -1) {
          throw new Error('Invalid Authorization header', value);
        }
        return true;
      }
    }
  }).post('/2/' + endpoint, opts);
}

test('dropox static methods', t => {
  rcc.snapshot();
  const Dropbox = require('../src/dropbox');
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

  Promise.all([test1, test2])
  .finally(() => {
    rcc.restore();
    t.end();
  });
});

test('dropbox error handling', t => {
  mock();
  rcc.snapshot();
  const Dropbox = require('../src/dropbox');
  let testMessage = 'should throw exception with invalid account id';
  try {
    new Dropbox('../../sensitive_directory');
    t.fail(testMessage);
  } catch (err) {
    t.equal(err.message, 'Malicious account id ../../sensitive_directory', testMessage);
  }

  n('users/get_account')
  .reply(200, fixtures.dropbox.responses.users$get_account_fail);

  testMessage = 'should reject for non verified email';
  Dropbox.create(fixtures.dropbox.authInfo)
  .then(() => {
    t.fail(testMessage);
  })
  .catch(err => {
    t.equal(err.message, 'Dropbox user email not verified', testMessage);
  })
  .finally(() => {
    t.end();
    mock.restore();
    rcc.restore();
  });
});

test('dropbox test suite #1 sync ~600 files', t => {
  rcc.snapshot();
  const Dropbox = require('../src/dropbox');
  mock(fixtures.fs);
  Dropbox.events.onAny((event, value) => {
    // debug('dropbox static event', event, value);
  });
  // test create
  n('users/get_account')
  .reply(200, fixtures.dropbox.responses.users$get_account);

  Dropbox.create(fixtures.dropbox.authInfo)
  .then(user => {
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
      t.fail('should reject when asked for cursor, when there is none');
    })
    .catch(err => {
      t.equal(err.code, 'ENOENT', 'should reject with ENOENT');
      return user;
    });
  })
  .then(user => {
    t.deepEqual(Dropbox.stats, {
      flight: 0,
      pending: 0,
      completed: 1,
      errors: 0,
      retries: 0
    }, 'should have correct request stats');
    return user;
  })
  .then(user => {
    return Dropbox.list().then(userList => {
      t.deepEqual(userList, [fixtures.dropbox.authInfo.account_id], 'should list created users');
      return user;
    });
  })
  .then(user => {
    t.equal(user.toString(), `DropboxUser ${fixtures.dropbox.authInfo.account_id}`, 'should have meaningful toString()');
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
      t.equal(Dropbox.stats.completed, 2, 'should have stats.completed = 2');
      return user;
    });
  })
  .then(user => {
    n('files/list_folder')
    .reply(200, fixtures.dropbox.responses.files$list_folder);
    // this is the test data
    let allEntries = fixtures.dropbox.responses.files$list_folder.entries;
    let files = allEntries.filter(e => e['.tag'] === 'file');
    var bar = new ProgressBar('Syncing :bar [:current/:total] Elapsed: :elapsed ETA: :eta',
    {total: files.length, width: 40});

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

      if (event === 'sync-file-downloaded') {
        bar.tick();
      }
    }
    user.onAny(eventVerifier);

    return user.sync().then(result => {
      user.offAny(eventVerifier);
      let elapsed = lastTime - startTime;
      let actualRate = result.downloads.length / elapsed * 1000 | 0;
      t.ok(actualRate > 500, 'should support burst');
      t.equal(http500, simulatedErrors, 'should simulate calculated amount of HTTP 500');
      t.equal(Dropbox.stats.retries, http500, 'should retry on http 500');
      t.equal(Dropbox.stats.completed, 2 + 1 + files.length + Dropbox.stats.retries, 'should have stats.completed = 8');
      t.deepEqual(result.downloads.length, files.length, 'should have same amount of file entries');
      t.equal(eventStats['sync-file-downloaded'], files.length, 'should fire sync-file-downloaded');
      t.equal(eventStats['sync-start'], 1, 'should fire sync-start once');
      t.equal(eventStats['retry'], Dropbox.stats.retries, 'should fire retry event for each retry attempt');
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
  .finally(() => {
    rcc.restore();
    t.end();
    mock.restore();
  });
  // test throttling
  // test 429 handling
  // test abrupt download cancel
  // test files list continue
  // test sync reliability
  // test web hooks
  // test web hook signature
});

test('dropbox test suite #2 sync 10k files', t => {
  rcc.snapshot();
  const Dropbox = require('../src/dropbox');
  // disable throttler, we'll test the throttler later
  Dropbox.THROTTLER = new Throttler(60000, 60000);
  mock(fixtures.fs);
  n('users/get_account')
  .reply(200, fixtures.dropbox.responses.users$get_account);

  Dropbox.create(fixtures.dropbox.authInfo)
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
    console.log('files', files.length);
    var bar = new ProgressBar('Syncing :bar [:current/:total] Elapsed: :elapsed ETA: :eta',
    {total: files.length, width: 40});

    let startTime;
    let lastTime;
    let count = 0;
    let http500 = 0;
    let simulatedErrors = (files.length + 50) / 100 | 0;
    // if simulated errors are more than a hundred, they'll cause
    // another http500!
    simulatedErrors += (simulatedErrors + 50) / 100 | 0;
    var interceptor = nock('https://content.dropboxapi.com')
    .post('/2/files/download')
    .times(20000)
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

      if (event === 'sync-file-downloaded') {
        bar.tick();
      }
    }
    user.onAny(eventVerifier);

    return user.sync().then(result => {
      nock.removeInterceptor(interceptor);
      user.offAny(eventVerifier);
      let elapsed = lastTime - startTime;
      let actualRate = result.downloads.length / elapsed * 1000 | 0;
      t.ok(actualRate > 500, 'should support burst');
      t.equal(http500, simulatedErrors, 'should simulate calculated amount of HTTP 500');
      t.equal(Dropbox.stats.retries, http500, 'should retry on http 500');
      t.equal(Dropbox.stats.completed, 7 + files.length + Dropbox.stats.retries, 'should have correct stats.completed');
      t.deepEqual(result.downloads.length, files.length, 'should have same amount of file entries');
      t.equal(eventStats['sync-file-downloaded'], files.length, 'should fire sync-file-downloaded');
      t.equal(eventStats['sync-start'], 1, 'should fire sync-start once');
      t.equal(eventStats['retry'], Dropbox.stats.retries, 'should fire retry event for each retry attempt');
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
  .finally(() => {
    rcc.restore();
    t.end();
    mock.restore();
  });
  // test throttling
  // test 429 handling
  // test abrupt download cancel
  // test files list continue
  // test sync reliability
  // test web hooks
  // test web hook signature
});
