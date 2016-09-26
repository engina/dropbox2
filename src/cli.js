#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Sync = require('./sync');
const ProgressBar = require('progress');
const argv = require('yargs')
.usage('$0 directory [access token]')
.demand(1)
.alias('v', 'verbose')
.describe('v', 'Display progress messages for debugging purposes.')
.alias('q', 'quiet')
.describe('q', 'Do not print the progress bar.')
.help()
.alias('h', 'help')
.argv;

let dir = argv._[0];
let accessToken = argv._[1];

let s = new Sync(dir, accessToken);

if (!argv.q) {
  var bar;
  s.onAny((event, data) => {
    if (argv.v) {
      console.error('[verbose]', event, data || '');
    }
    if (event === 'sync-tasks') {
      bar = new ProgressBar('Syncing :bar [:current/:total] Elapsed: :elapsed ETA: :eta',
                            {total: data.downloads.length, width: 40});
    }

    if (event === 'sync-file-downloaded') {
      bar.tick();
    }
  });
}

console.log('Getting list of differences...');
s.sync()
.then(result => {
  if (!argv.q) {
    console.log('Sync completed');
  }
})
.catch(Sync.Error, error => {
  if (error.native === 'ENOACC') {
    console.error('Please provide an access token or a directory with access token file in it');
  }
  throw error;
})
.catch(error => {
  console.error(error);
  process.exit(1);
});
