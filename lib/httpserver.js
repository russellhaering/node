var util     = require('util');
var net      = require('net');
var outgoing = require('httpoutgoing');
var crypto   = require('crypto');
var parsers  = require('httpparser').parsers;

var debugLevel = parseInt(process.env.NODE_DEBUG, 16);

function debug () {
  if (debugLevel & 0x4) {
    util.error.apply(this, arguments);
  }
}

function Server (requestListener) {
  if (!(this instanceof Server)) return new Server(requestListener);
  net.Server.call(this);

  var self = this;

  if (requestListener) {
    this.addListener("request", requestListener);
  }

  this.addListener("connection", function (socket) {
    self._incomingConnection(socket);
  });
}

util.inherits(Server, net.Server);
exports.Server = Server;

exports.createServer = function (requestListener) {
  return new Server(requestListener);
};

Server.prototype.setSecure = function (credentials) {
  this.secure = true;
  this.credentials = credentials;

  if (!(this.credentials instanceof crypto.Credentials)) {
    this.credentials = crypto.createCredentials(this.credentials);
  }
};

Server.prototype._incomingConnection = function(socket) {
  debug("new http connection");

  var client = new ClientConnection(this, socket, this.secure, this.credentials);
};


function ClientConnection (server, stream, secure, creds) {
  var self = this;

  this._netstream = stream;

  // SecurePair doesn't have setTimeout()
  stream.setTimeout(2 * 60 * 1000); // 2 minute timeout
  stream.addListener('timeout', function() {
    self.destroy();
  });

  if (secure) {
    var securePair = self._securePair = crypto.createPair(creds, true);

    stream.pipe(securePair.encrypted);
    securePair.encrypted.pipe(stream);

    securePair.on('secure', function() {
      // TODO: Connected fo' sure
    });

    stream = securePair.cleartext;

    securePair.on('error', function (error) {
      self.error(error);
    });

    securePair.on('end', function () {
      self.error(error);
    });
  }

  this._outgoing = [];
  this._server = server;
  this._stream = stream;

  this._parser = parsers.alloc();
  this._parser.reinitialize('request');
  this._parser.socket = this;

  this._parser.onIncoming = function(req) {
    return self._incomingRequest(req);
  };

  stream.on('error', function(error) {
    return self._error(error);
  });

  stream.on('close', function() {
    self.destroy();
  });

  stream.on('drain', function() {
    return self._drain();
  });

  stream.on('data', function(data) {
    return self._data(data);
  });

  stream.on('end', function() {
    return self._end();
  });
}

ClientConnection.prototype.destroy = function() {
  if (this._netstream) {
    this._netstream.destroy();
  }

  if (this._securePair) {
    this._securePair.destroy();
  }

  if (this._parser) {
    parsers.free(this._parser);
    this._parser = null;
  }
};

ClientConnection.prototype._drain = function() {
  /*
  var message = this._outgoing[0];
  if (message) message.emit('drain');
  if (this.__destroyOnDrain) this.destroy();
  */
};

ClientConnection.prototype._data = function(data) {
  var ret = this._parser.execute(data, 0, data.length);

  if (ret instanceof Error) {
    this.destroy(ret);
  } else if (this._parser.incoming && this._parser.incoming.upgrade) {
    var bytesParsed = ret;
    var request = parser.incoming;

    // This is start + byteParsed + 1 due to the error of getting \n
    // in the upgradeHead from the closing lines of the headers
    var upgradeHead = data.slice(bytesParsed + 1, data.length);

    if (this._server.listeners("upgrade").length) {
      this._server.emit('upgrade', request, request.connection, upgradeHead);
    } else {
      // Got upgrade header, but have no handler.
      this.destroy();
    }
  }
};

ClientConnection.prototype._error = function(error) {
  this._server.emit('clientError', error);
};

ClientConnection.prototype._end = function() {
  this._parser.finish();

  if (this._outgoing.length) {
    /* TODO: flush clients */
  } else {
    this.end();
  }
};

ClientConnection.prototype._childWrite = function(child, buf) {
  return this._stream.write(buf);
};

ClientConnection.prototype._childDone = function(response) {
  if (response._last === true) {
    var self = this;

    this._netstream.on('end', function() {
      self.destroy();
    })

    this._stream.end();

    if (self._securePair) {
      this._netstream.end();
    }
  }
};

// The following callback is issued after the headers have been read on a
// new message. In this callback we setup the response object and pass it
// to the user.
ClientConnection.prototype._incomingRequest = function (request, shouldKeepAlive) {
  var self = this;
  var server   = this._server;
  var response = new outgoing.ServerResponse(request, this);

  debug('server response shouldKeepAlive: ' + shouldKeepAlive);
  response.shouldKeepAlive = shouldKeepAlive;
  this._outgoing.push(response);

  if ('expect' in request.headers &&
      (request.httpVersionMajor == 1 && request.httpVersionMinor == 1) &&
      continueExpression.test(request.headers['expect'])) {
    response._expectContinue = true;

    if (server.listeners("checkContinue").length) {
      server.emit("checkContinue", request, response);
    } else {
      response.writeContinue();
      server.emit('request', request, response);
    }
  } else {
    server.emit('request', request, response);
  }

  return false; // Not a HEAD response. (Not even a response!)
};

