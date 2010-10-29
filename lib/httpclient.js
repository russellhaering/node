var util = require('util');
var net = require('net');
var events = require('events');
var crypto = require('crypto');
var httpoutgoing = require('httpoutgoing');
var parsers = require('httpparser').parsers;
var assert = process.assert;

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
    return new Client(port, host, https, credential);
  }

  events.EventEmitter.call(this);

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

util.inherits(Client, events.EventEmitter);
exports.Client = Client;

exports.createClient = function (port, host, https, credentials) {
  var c = new Client(port, host, https, credentials);
  return c;
};

/* This is split out incase we are disconnected after a request,
 * Which is a fairly common situation in node, so we re-establish everything.
 */
Client.prototype._establishStreams = function() {
  var self = this;

  this._netstream = new net.Stream({ allowHalfOpen: true });
  this._netstream.connect(this.port, this.host);
  this._state = STATE_OPENING;

  if (!this.https) {
    this._stream = this._netstream;
    this._netstream.on('connect', function() {
      self._transportConnected();
    });

  } else {
    if (!this.credentials.hostname) {
      // Add ServerNameIndication hostname if not present. 
      this.credentials.hostname = this.host;
    }

    if (!(this.credentials instanceof crypto.Credentials)) {
      this.credentials = crypto.createCredentials(this.credentials);
    }

    this._securePair = crypto.createPair(this.credentials);

    this._securePair.encrypted.pipe(this._netstream);
    this._netstream.pipe(this._securePair.encrypted);

    this._stream = this._securePair.cleartext;
    
    this._securePair.on('secure', function() {
      self._transportConnected();
    });

    this._securePair.on('error', function(err) {
      self._transportError(err);
    });

    this._securePair.on('end', function(err) {
      self._transportEnd(err);
    });
  }

  this._netstream.on('error', function(err) {
    self._transportError(err);
  });

  this._netstream.on('end', function() {
    self._transportEnd();
  });

  this._stream.on('data', function(chunk) {
    self._transportData(chunk);
  });

  this._stream.on('resume', function() {
    self._transportResume();
  });

  this._stream.on('pause', function() {
    self._transportPause();
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

  this._stream = null;

  if (this._netstream) {
    this._netstream.destroy();
    this._netstream = null;
  }

  if (this._securePair) {
    this._securePair.destroy();
    this._securePair = null;
  }
};

Client.prototype.end = function() {
  this._destroyOnDrain = true;
}

Client.prototype.destroy = function (error) {
  var self = this;

  this._destroyStreams();

  if (this._parser) {
    parsers.free(this._parser);
    this._parser = null;
  }

  this._children.length = 0;

  process.nextTick(function () {
    if (error) self.emit('error', error);
    self.emit('close', error ? true : false);
  });
};

Client.prototype.request = function (method, url, headers) {
  if (typeof url !== 'string') {
    // Assume method was omitted, shift arguments.
    headers = url;
    url = method;
    method = 'GET';
  }

  if (!this._stream) {
    this._establishStreams();
  }

  var req = new httpoutgoing.ClientRequest(this, method, url, headers);

  this._children.push(req);

  return req;
};

Client.prototype._transportConnected = function() {
  this.emit('connect');
  this._state = STATE_OPEN;
  if (this._children.length) {
    this._childFlush(this._children[0]);
  }
};

Client.prototype._transportError = function(err) {
  this._state = STATE_DEAD;
  this.emit('error', err);
};

Client.prototype._transportEnd = function() {
  this._state = STATE_CLOSED;
  debug('ending transport');
  if (this._children.length) {
    /* TODO: For HTTP Pipelining, this will need major work to retransmit requests. */
    /* TODO: Layering violation */
    var child = this._children[0];

    if (child._dataSent) {
      debug('child sent data, but we arent sure if we are done');
      /* TODO: what should we do? This happens on many common cases, where the remote server closes the 
       * transport right after sending us all data. (Google is a good example)
       */
      //child.emit('error', new Error('Transport ended while request was ongoing.'));
    } else {
      debug('child retransmiting...');
      /* Okay, never sent any data yet, or we are between requests, reconnect and start over. */
      this._destroyStreams();
      this._establishStreams();
    }
  }
};

Client.prototype._transportData = function(chunk) {
  if (!this._children.length) {
    throw new Error('Weird. Got Data from the trnasport, but we do not have any children requests?');
  }

  var ret = this._parser.execute(chunk, 0, chunk.length);

  if (ret instanceof Error) {
    this.destroy(ret);
    return;
  }

  if (this._parser.incoming && this._parser.incoming.upgrade) {
    var bytesParsed = ret;
    var req = this._parser.incoming;

    var upgradeHead = chunk.slice(bytesParsed + 1, chunk.length);

    if (this.listeners('upgrade').length) {
      this.emit('upgrade', req, this._stream, upgradeHead);
    } else {
      this.destroy(new Error('Request should of been upgraded, but no listeners found?'));
    }
  }
};

Client.prototype._transportResume = function() {
  /* The lower level stream asked us to resume data */
  if (this._children.length) {
    var child = this._children[0];
    child.resume();
  }
};

Client.prototype._transportPause = function() {
  /* The lower level stream asked us to pause pushing data to them */
  if (this._children.length) {
    var child = this._children[0];
    child.pause();
  }
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

  res.on('end', function() {
    process.nextTick(function() {
      self._childDone(req);
    });
  });

  req.emit("response", res);

  return isHeadResponse;
};

Client.prototype._childFlush = function(child) {
  var buffer = child._parentBuffer,
      length = buffer.length;

  if (length) {
    for (var i = 0; i < length; i++) {
      this._stream.write(buffer[i]);
    }

    buffer.length = 0;
  }
};

Client.prototype._childWrite = function(child, buf) {
  if (child != this._children[0]) {
    /* UGH, someone is writing to a child who isn't at the front of the line yet.
     * We now buffer it, and hopefully someday later we can deal with it.
     */
     child._parentBuffer.push(buf);
     debug('Child write called from child not at the front?');
     return false;
  }

  this._childFlush(child);

  child._dataSent = true;

  return this._stream.write(buf);
};

Client.prototype._childAllSent = function(child) {
  /* TODO: child has finished sending request, ready for a response */
  /* TODO: HTTP pipelining changes would go here */
};

Client.prototype._childDone = function(child, error, isIncoming) {
  assert(child == this._children[0]);

  this._children.shift();

  if (child.shouldKeepAlive && this._children.length) {
    this._childFlush(this._children[0]);
    this._children[0]._cycle();
  } else if (child.shouldKeepAlive && !this._destroyOnDrain) {
    // Leaving the connectiion in keepalive.
  } else if (this._children.length) {
    // didn't want to keep-alive, kill the connection and roll...
    this._destroyStreams();
    this._establishStreams();
    this._childFlush(this._children[0]);
    this._children[0]._cycle();
  } else {
    this.destroy(error);
  }
};
