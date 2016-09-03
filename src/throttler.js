const RateLimiter = require('limiter').RateLimiter;
const Promise = require('bluebird');

class Throttler {
  constructor(rate, interval = 1000) {
    this.limiters = {};
    this.rate     = rate;
    this.interval = interval;
  }

  throttle(key = 'default') {
    return new Promise((resolve, reject) => {
      this.throttleCallback(key, resolve);
    });
  }

  throttleCallback(key, callback) {
    if (this.limiters[key] === undefined) {
      this.limiters[key] = new RateLimiter(this.rate, this.interval);
    }
    let limiter = this.limiters[key];
    limiter.removeTokens(1, callback);
  }
}

module.exports = Throttler;
