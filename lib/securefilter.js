var util = require('util');
var events = require('events');

var debugLevel = parseInt(process.env.NODE_DEBUG, 16);
function debug () {
  if (debugLevel & 0x4) {
    util.error.apply(this, arguments);
  }
}

/* Lazy Loaded crypto object */
var SecureStream = null;

/**
 * Provides a Read and Write stream, wrapping an existing stream in an
 * SSL/TLS connection.
 *
 * @param {Object} parent_stream Existing stream to wrap.
 * @param {?Object} credentials   SSL Context to configure the SSL stream from, including
 *                                the SSL Certificates.
 * @param {?Boolean} is_server
 */

function SecureFilter(source, target, credentials, is_server)
{
  if (!(this instanceof SecureFilter)) {
    return new SecureFilter(source, target, credentials, is_server);
  }

  var self = this;

  try {
    SecureStream = process.binding('crypto').SecureStream;
  }
  catch (e) {
    throw new Error('node.js not compiled with openssl crypto support.');
  }

  events.EventEmitter.call(this);

  this._source = source;
  this._target = target;

  this._secureEstablished = false;
  this._is_server = is_server ? true : false;
  this._target_write_state = true;
  this._source_write_state = true;
  this._done = false;

  var crypto = require("crypto");

  if (!credentials) {
    this.credentials = crypto.createCredentials();
  }
  else {
    this.credentials = credentials;
  }

  if (!this._is_server) {
    /* For clients, we will always have either a given ca list or be using default one */
    this.credentials.shouldVerify = true;
  }

  this._secureEstablished = false;
  this._encIn_pending = [];
  this._clearIn_pending = [];

  this._ssl = new SecureStream(this.credentials.context,
                               this._is_server ? true : false,
                               this.credentials.shouldVerify);

  this._source.on('data', function(data) {
    debug('clearIn data');
    self._clearIn_pending.push(data);
    self._cycle();
  });

  this._target.on('data', function(data) {
    debug('encIn data');
    self._encIn_pending.push(data);
    self._cycle();
  });

  this._source.on('end', function() {
    debug('client end');
    self._ssl.shutdown();
    self._cycle();
    self.emit('end');
    self.destroy();
  });

  this._source.on('close', function() {
    debug('source close');
    self.emit('close');
    self.destroy();
  });

  this._target.on('end', function() {
    if (!this._done) {
      self._error(new Error('Target ended before secure stream was done'));
    }
  });

  this._target.on('close', function() {
    if (!this._done) {
      self._error(new Error('Target closed before secure stream was done'));
    }
  });

  this._source.on('drain', function() {
    debug('source drain');
    self._cycle();
    self._target.resume();
  });

  this._target.on('drain', function() {
    debug('target drain');
    self._cycle();
    self._source.resume();
  });

  process.nextTick(function() {
    self._ssl.start();
    self._cycle();
  });
}

exports.SecureFilter = SecureFilter;
util.inherits(SecureFilter, events.EventEmitter);

exports.createSecureFilter = function(source_cleartext, target_encrypted, credentials, is_server)
{
  var filter = new exports.SecureFilter(source_cleartext, target_encrypted, credentials, is_server);
  return filter;
};

/**
 * Attempt to cycle OpenSSLs buffers in various directions.
 *
 * An SSL Connection can be viewed as four separate piplines,
 * interacting with one has no connection to the behavoir of
 * any of the other 3 -- This might not sound reasonable,
 * but consider things like mid-stream renegotiation of 
 * the ciphers.
 *
 * The four pipelines, using terminology of the client (server is just reversed):
 *   1) Encrypted Output stream (Writing encrypted data to peer)
 *   2) Encrypted Input stream (Reading encrypted data from peer)
 *   3) Cleartext Output stream (Decrypted content from the peer)
 *   4) Cleartext Input stream (Cleartext content to send to the peer)
 *
 * This function attempts to push any available data out of the Cleartext
 * output stream (#3), and the Encrypted output stream (#1), and push them up 
 * to the consumer or the peer socket, respectively.
 *
 * It is called whenever we do something with OpenSSL -- post reciving content,
 * trying to flush, trying to change ciphers, or shutting down the connection.
 *
 * Because it is also called everywhere, we also check if the connection
 * has completed negotiation and emit 'secure' from here if it has. 
 */
SecureFilter.prototype._cycle = function() {
  if (this._done) {
    return;
  }

  var rv;
  var tmp;
  var bytesRead;
  var bytesWritten;
  var chunkBytes;
  var chunk = null;
  var pool = null;

  while (this._encIn_pending.length > 0) {
    tmp = this._encIn_pending.shift();

    try {
     rv = this._ssl.encIn(tmp, 0, tmp.length);
    } catch (e) {
      return this._error(e);
    }

    if (rv === 0) {
      this._encIn_pending.unshift(tmp);
      break;
    }

    assert(rv === tmp.length);
  }

  while (this._clearIn_pending.length > 0) {
    tmp = this._clearIn_pending.shift();
    try {
      rv = this._ssl.clearIn(tmp, 0, tmp.length);
    } catch (e) {
      return this._error(e);
    }

    if (rv === 0) {
      this._clearIn_pending.unshift(tmp);
      break;
    }

    assert(rv === tmp.length);
  }

  do {
    bytesRead = 0;
    chunkBytes = 0;
    pool = new Buffer(4096);
    pool.used = 0;
    do {
      try {
        chunkBytes = this._ssl.clearOut(pool,
                                        pool.used + bytesRead,
                                        pool.length - pool.used - bytesRead);
      } catch (e) {
        return this._error(e);
      }
      if (chunkBytes >= 0) {
        debug('clearOut read: '+ chunkBytes);
        bytesRead += chunkBytes;
      }
    } while ((chunkBytes > 0) && (pool.used + bytesRead < pool.length));

    if (bytesRead > 0) {
      chunk = pool.slice(0, bytesRead);
      this._source_write_state = this._source.write(chunk);
    }
  } while (bytesRead > 0 && this._source_write_state === true);

  do {
    pool = new Buffer(4096);
    pool.used = 0;
    bytesRead = 0;
    chunkBytes = 0;
    bytesWritten = 0;

    do {
      try {
        chunkBytes = this._ssl.encOut(pool,
                                      pool.used + bytesRead,
                                      pool.length - pool.used - bytesRead);
      } catch (e) {
        return this._error(e);
      }
      if (chunkBytes >= 0) {
        debug('encOut read: '+ chunkBytes);
        bytesRead += chunkBytes;
      }
    } while ((chunkBytes > 0) && (pool.used + bytesRead < pool.length));

    if (bytesRead > 0) {
      chunk = pool.slice(0, bytesRead);
      self._target_write_state = this._target.write(chunk);
    }
  } while (bytesRead > 0 && this._target_write_state === true);



  if (!this._source_write_state) {
    this._target.pause();
  }

  if (!this._target_write_state) {
    this._source.pause();
  }

  if (!this._secureEstablished && this._ssl.isInitFinished()) {
    this._secureEstablished = true;
    debug('secure established');
    this.emit('secure');
    this._cycle();
  }
};

SecureFilter.prototype.destroy = function()
{
  this._done = true;
  this._ssl.close();
};

SecureFilter.prototype._error = function (err)
{
  this.emit('error', err);
};
