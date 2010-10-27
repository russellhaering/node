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
var STATE_OPENING = 1;
var STATE_OPEN = 2;
var STATE_DEAD = 3;

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
  this._state = STATE_OPENING;

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
  this._parser.socket = this;
  this._parser.onIncoming = function(res) {
    return self._incomingResponse(res);
  };
};

Client.prototype._destroyStreams = function() {
  this._state = STATE_CLOSED;

  if (this._nestream) {
    this._netstream.destroy();
    delete this._netstream;
  }

  if (this._secure_pair) {
    this._secure_pair.destroy();
    delete this._secure_pair;
  }
};

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
  this._state = STATE_OPEN;
  if (this._children.length) {
    this._child_flush(this._children[0]);
  }
};

Client.prototype._transport_error = function(err)
{
  this._state = STATE_DEAD;
  this.emit('error', err);
};

Client.prototype._transport_end = function()
{
  this._state = STATE_CLOSED;
  if (this._children.length) {
    /* TODO: For HTTP Pipelining, this will need major work to retransmit requests. */
    /* TODO: Layering violation */
    var child = this._children[0];
    if (child._data_sent) {
      child.emit('error', new Error('Transport ended while request was ongoing.'));
    }
    else {
      /* Okay, never sent any data yet, or we are between requests, reconnect and start over. */
      this._destroyStreams();
      this._establishStreams();
    }
  }
};

Client.prototype._transport_data = function(chunk)
{
  if (!this._children.length) {
    throw new Error('Weird. Got Data from the trnasport, but we do not have any children requests?');
  }

  var ret = self.parser.execute(chunk, 0, chunk.length);

  if (ret instanceof Error) {
    this.destroy(ret);
    return;
  }

  if (self.parser.incoming && self.parser.incoming.upgrade) {
    var bytesParsed = ret;
    var req = self.parser.incoming;

    var upgradeHead = chunk.slice(bytesParsed + 1, chunk.length);

    if (this.listeners('upgrade').length) {
      this.emit('upgrade', req, self, upgradeHead);
    } else {
      this.destroy(new Error('Request should of been upgraded, but no listeners found?'));
    }
  }
};

Client.prototype._transport_resume = function() {
  /* TODO: resume child */
};

Client.prototype._transport_pause = function() {
  /* TODO: tell child to shut the fuck up */
};

Client.prototype._incomingResponse = function(res) {
  debug("incoming response!");
  var self =  this;
  var req = this._children[0];

  // Responses to HEAD requests are AWFUL. Ask Ryan.
  // A major oversight in HTTP. Hence this nastiness.
  var isHeadResponse = req.method == "HEAD";
  debug('isHeadResponse ' + isHeadResponse);

  if (res.statusCode == 100) {
    // restart the parser, as this is a continue message.
    req.emit("continue");
    return true;
  }

  if (req.shouldKeepAlive && res.headers.connection === 'close') {
    req.shouldKeepAlive = false;
  }

  res.on('end', function () {
    debug("request complete disconnecting.");
    self._child_done(req);
  });

  req.emit("response", res);

  return isHeadResponse;
};

Client.prototype._child_flush = function(child) {
  if (child._parent_buffer.length) {
    child._parent_buffer.forEach(function(item) {
      this._stream.write(item);
    });
    child._parent_buffer.length = 0;
  }
};

Client.prototype._child_write = function(child, buf) {

  if (child != this._children[0]) {
    /* UGH, someone is writing to a child who isn't at the front of the line yet.
     * We now buffer it, and hopefully someday later we can deal with it.
     */
     child._parent_buffer.push(buf);
     return false;
  }

  this._child_flush(child);

  return this._stream.write(buf);
};

Client.prototype._child_all_sent = function(child) {
  /* TODO: child has finished sending request, ready for a response */
  /* TODO: HTTP pipelining changes would go here */
};

Client.prototype._child_done = function(child) {
  assert(child == this._children[0]);

  this._children.shift();

  if (req.shouldKeepAlive && this._children.length) {
    this._child_flush(this._children[0]);
  } else {
    self.end();
  }
};
