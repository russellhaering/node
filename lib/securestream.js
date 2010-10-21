var util = require('util');
var stream = require("stream");

var debugLevel = parseInt(process.env.NODE_DEBUG, 16);
function debug () {
  if (debugLevel & 0x4) {
    util.error.apply(this, arguments);
  }
}

/* Lazy Loaded crypto object */
var SecStream = null;

/**
 * Provides a Read and Write stream, wrapping an existing stream in an
 * SSL/TLS connection.
 *
 * @param {Object} parent_stream Existing stream to wrap.
 * @param {?Object} credentials   SSL Context to configure the SSL stream from, including
 *                                the SSL Certificates.
 * @param {?Boolean} is_server
 */

function SecureStream(parent_stream, credentials, is_server)
{
  if (!(this instanceof SecureStream)) {
    return new SecureStream(parent_stream, credentials, is_server);
  }

  stream.Stream.call(this);

  var self = this;

  try {
    SecStream = process.binding('crypto').SecureStream;
  }
  catch (e) {
    throw new Error('node.js not compiled with openssl crypto support.');
  }

  this._stream = parent_stream;

  this.writeable = true;
  this.readable = true;
  this._secureEstablished = false;
  this._is_server = is_server ? true : false;
  this._write_state = true;

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

  this._ssl = new SecStream(this.credentials.context,
                            this._is_server ? true : false,
                            this.credentials.shouldVerify);

  this._stream.on('data', function(data) {
    debug('client data');
    self._read(data);
  });

  this._stream.on('error', function(err) {
    debug('client error');
    self._error(err);
  });

  this._stream.on('end', function() {
    debug('client end');
    self.writeable = false;
    self.readable = false;
    self.emit('end');
  });

  this._stream.on('close', function() {
    debug('client close');
    self.emit('close');
  });

  this._stream.on('drain', function() {
    debug('client drain');
    self._cycle();
    self.emit('drain');
  });

  process.nextTick(function() {
    self._ssl.start();
    self._cycle();
  });
}

util.inherits(SecureStream, stream.Stream);
exports.SecureStream = SecureStream;

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
SecureStream.prototype._cycle = function() {
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
      this.emit('data', chunk);
    }
  } while (bytesRead > 0);

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
      self._write_state = this._stream.write(chunk);
    }
  } while (bytesRead > 0 && this._write_state === true);

  if (!this._secureEstablished && this._ssl.isInitFinished()) {
    this._secureEstablished = true;
    debug('secure established');
    this.emit('secure');
    this._secureCycle();
  }
};

/**
 * Attempt to pause the stream. Event can still be emitted.
 */
SecureStream.prototype.pause = function()
{
  this._stream.pause();
};

/**
 * Resume a stream that was previously paused.
 */
SecureStream.prototype.resume = function()
{
  this._stream.resume();
};


/* writable emit events: 'drain', 'error', 'close' */
/* writable methods */
SecureStream.prototype.destroy = function()
{
  this.writeable = false;
  this.readable = false;
  this._ssl.close();
  this._stream.destroy();
};

SecureStream.prototype.end = function(data, encoding)
{
  if (data) {
    this.write(data, encoding);
  }
  this._ssl.shutdown();
  this._cycle();
  this._stream.end();
};

SecureStream.prototype.write = function (chunk)
{
  this._clearIn_pending.push(chunk);
  this._cycle();
  return this._write_state;
};

SecureStream.prototype._read = function (data)
{
  this._encIn_pending.push(data);
  this._cycle();
};

SecureStream.prototype._error = function (err)
{
  self.writeable = false;
  self.readable = false;
  self.emit('error', err);
};
