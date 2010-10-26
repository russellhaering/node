var util = require('util');
var net = require('net');
var stream = require('stream');
var crypto = require('crypto');
var httpoutgoing = require('httpoutgoing');
var parsers = require('httpparser').parsers;
var debugLevel = parseInt(process.env.NODE_DEBUG, 16);

function debug () {
  if (debugLevel & 0x4) {
    util.error.apply(this, arguments);
  }
}

var STATE_CLOSED = 0;
var STATE_OPEN = 1;

function Client(port, host, https, credentials) {
  if (!(this instanceof Client)) {
    return new Client(credentials, is_server);
  }

  stream.Stream.call(this);

  var self = this;

  this.host = host;
  this.port = port;
  this.https = https;
  this.credentials = credentials ? credentials : {};

  this._children = [];
  this._destroyOnDrain = false;

  this._state = STATE_CLOSED;

  this._stream = null;

  this._establishStreams();
}

util.inherits(Client, stream.Stream);
exports.Client = Client;

exports.createClient = function (port, host, https, credentials) {
  var c = new Client(port, host, https, credentials);
  return c;
};

/* This is split out incase we are disconnected after a request,
 * Which is a fairly common situation in node, so we reestablish everyhting.
 */
Client.prototype._establishStreams = function() {

  this._netstream = new net.createConnection(this.port, this.host);
  this._state = STATE_OPEN;

  if (!this.https) {
    this._stream = this._netstream;
    this._netstream.on('connect', function() {
      self._transport_connected();
    });
  }
  else {
    if (!this.credentials.hostname) {
      /* Add ServerNameIndication hostname if not present. */
      this.credentials.hostname = host;
    }

    this._secure_pair = crypto.createPair(this.credentials);

    this._secure_pair.encrypted.pipe(this._netstream);
    this._netstream.pipe(this._secure_pair.encrypted);

    this._stream = this._secure_pair.cleartext;
    
    this._secure_pair.on('secure', function() {
      self._transport_connected();
    });

    this._secure_pair.on('error', function(err) {
      self._transport_error(err);
    });

    this._secure_pair.on('end', function(err) {
      self._transport_end(err);
    });
  }

  this._netstream.on('error', function(err) {
    self._transport_error(err);
  });

  this._netstream.on('end', function() {
    self._transport_end();
  });

  this._stream.on('data', function(chunk) {
    self._transport_data(chunk);
  });

  this._stream.on('resume', function() {
    self._transport_resume();
  });

  this._stream.on('pause', function() {
    self._transport_pause();
  });

  if (!this._parser) {
    this._parser = parsers.alloc();
  }
  this._parser.reinitialize('response');
};

Client.prototype._destroyStreams = function() {
  if (this._nestream) {
    this._netstream.destroy();
    delete this._netstream;
  }

  if (this._secure_pair) {
    this._secure_pair.destroy();
    delete this._secure_pair;
  }
}

Client.prototype.request = function (method, url, headers) {
  if (typeof(url) != "string") {
    // assume method was omitted, shift arguments
    headers = url;
    url = method;
    method = "GET";
  }

  var req = new httpoutgoing.ClientRequest(this, method, url, headers);

  this._outgoing.push(req);

  this._cycle();
  return req;
};

Client.prototype._transport_connected = function()
{
  /* TODO: start sending requests */
};

Client.prototype._transport_error = function(err)
{
  this._state = STATE_CLOSED;
  this.emit('error', err);
};

Client.prototype._transport_end = function()
{
  this._state = STATE_CLOSED;
  /* TODO: matchup end to request */
};

Client.prototype._transport_data = function()
{
  /* TODO: matchup data to child */
};

Client.prototype._transport_resume = function()
{
  /* TODO: resume child */
};

Client.prototype._transport_pause = function()
{
  /* TODO: tell child to shut the fuck up */
};

Client.prototype._child_write = function(child, buf)
{
  /* TODO: buffer children who can't write yet */
  return this._stream.write(buf);
};

Client.prototype._child_all_sent = function(child)
{
  /* TODO: child has finished sending request, ready for a response */
};

