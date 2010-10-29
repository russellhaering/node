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
  net.Server.call(this, { allowHalfOpen: true });

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
      self._end();
    });
  }

  this._outgoing = [];
  this._server = server;
  this._stream = stream;
  this._reading = true;
  this._writing = true;

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
    self._drain();
  });

  stream.on('data', function(data) {
    self._data(data);
  });

  stream.on('end', function() {
    self._end();
  });
}

ClientConnection.prototype.end = function () {
  if (this._netstream) {
    this._netstream.end();
  }

  if (this._securePair) {
    this._securePair.end();
  }

  if (this._parser) {
    parsers.free(this._parser);
    this._parser = null;
  }
};

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
  // On drain make sure the current response knows
  // that they can write again, and if we aren't supposed to be
  // writing, then we destroy the socket.
  var response = this._outgoing[0];

  if (response) {
    response.emit('drain');
  }

  if (!this._writing) {
    this.destroy();
  }
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

  this._reading = false;

  if (!this._writing) {
    this.end();
  }
};

ClientConnection.prototype._childWrite = function(child, buf) {
  // Fake a full write queue if the responses are sent in the wrong order.
  if (child === this._outgoing[0]) {
    return this._stream.write(buf);
  }

  return false;
};

ClientConnection.prototype._childDone = function(response, error, isIncoming) {
  // A response has finished, or a request has been destoyed.
  // For finished responses we:
  //
  // * Check if was the last on the outgoing queue
  // * End the connection is we have nothing left to do
  //

  if (!isIncoming) {
    // Ignore responses that call end() in the wrong order.
    if (response !== this._outgoing[0]) {
      return;
    }

    response = this._outgoing.shift();

    if (!this._reading &&
        0 === this._outgoing.length &&
        response._last === true) {
      this._writing = false;

      if (!this._stream._writeQueue.length) {
        this.end();
      }
    } else if (!this._reading && this._writing &&
               this._outgoing.length) {
      // More responses to be sent.
      // Check if the output has been sent out.
      // If not, we do it ourselves.
      response = this._outgoing[0];

      if (response._output.length) {
        response._cycle();

        if (0 === response._output.length) {
          this._childDone(response);
        }
      }
    }
  }
};

// The following callback is issued after the headers have been read on a
// new message. In this callback we setup the response object and pass it
// to the user.
ClientConnection.prototype._incomingRequest = function (request, shouldKeepAlive) {
  var self     = this;
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

