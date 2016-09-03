var RateLimiter = require('limiter').RateLimiter;

var r = new RateLimiter(600, 60000);

var trigCount = 0;

function debug(str) {
  var date = new Date();
  var time = date.toTimeString().split(' ')[0];
  var timeMS = time + '.' + date.getMilliseconds();
  var debugMessage = timeMS + ' ' + str + '\n';
  process.stderr.write(debugMessage);
}

const windowSize = 10;
let windowPosition = 0;
let windowStart = Date.now();
let start = Date.now();
let windowAverage = 0;
function triggered(str) {
  if (++windowPosition === windowSize) {
    let elapsed = Date.now() - windowStart;
    windowAverage = windowSize / elapsed * 1000;
    windowPosition = 0;
    windowStart = Date.now();
  }
  let now = Date.now();
  let elapsed = now - start;
  debug(`triggered sofar:${trigCount++} ${str}  ${(elapsed/1000).toLocaleString(undefined, {maximumFractionDigits: 1})}s Overall avg:${(trigCount / elapsed * 1000).toLocaleString(undefined, {maximumFractionDigits:2})} Window avg:${windowAverage.toLocaleString(undefined, {maximumFractionDigits: 2})}`);
}

let request = 0;
let queueCount = 500;
function queue() {
  r.removeTokens(1, function() {
    triggered('request ' + request++);
  });
  if (--queueCount === 0) {
    return;
  }
  setTimeout(queue, 0);
}

queue();

setTimeout(function() {
  for (let i = 0; i < 7; i++) {
    debug('queued 2 ' + i);
    r.removeTokens(1, function() {
      triggered('request2 ' + i);
    });
  }
}, 1000);
