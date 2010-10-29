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
    var securePair = this._securePair = crypto.createPair(creds, true);

    stream.pipe(securePair.encrypted);
    securePair.encrypted.pipe(stream);

    stream = securePair.cleartext;

    // TODO: Add secure listeners.
  } else {
    // Fast case.
    //stream.on('data', streamOnData);
    stream.ondata = streamOnData;
  }

  stream.on('error', streamOnError);
  stream.on('close', streamOnClose);
  stream.on('drain', streamOnDrain);
  stream.on('end', streamOnEnd);
  stream._client = this;

  this._outgoing = [];
  this._server = server;
  this._stream = stream;
  this._reading = true;
  this._writing = true;

  this._parser = parsers.alloc();
  this._parser.reinitialize('request');
  this._parser.socket = this;
  this._parser.onIncoming = parserOnIncoming;
}

var continueExpression = /100-continue/i;

// The following callback is issued after the headers have been read on a
// new message. In this callback we setup the response object and pass it
// to the user.
var parserOnIncoming = function(request, shouldKeepAlive) {
  var self     = this.socket;
  var server   = self._server;
  var response = new outgoing.ServerResponse(request, self);

  request.connection = self._stream;

  debug('server response shouldKeepAlive: ' + shouldKeepAlive);
  response.shouldKeepAlive = shouldKeepAlive;

  self._outgoing.push(response);

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

var streamOnError = function (error) {
  this._client._server.emit('clientError', error);
};

var streamOnClose = function () {
  var client = this._client,
      parser = client._parser;

  client.destroy();

  if (parser) {
    parsers.free(parser);
    client._parser = null;
  }
};

var streamOnDrain = function () {
  var client = this._client;

  // On drain make sure the current response knows
  // that they can write again, and if we aren't supposed to be
  // writing, then we destroy the socket.
  var response = client._outgoing[0];

  if (response) {
    response.emit('drain');
  }

  if (!client._writing) {
    client.destroy();
  }
};

var streamOnData = function (data, start, end) {
  var client = this._client,
      parser = client._parser;

  var ret = parser.execute(data, start, end - start);

  if (ret instanceof Error) {
    client.destroy(ret);
  } else if (parser.incoming && parser.incoming.upgrade) {
    var bytesParsed = ret;
    var request = parser.incoming;

    // TODO: Remove data and end listeners?

    // This is start + byteParsed + 1 due to the error of getting \n
    // in the upgradeHead from the closing lines of the headers
    var upgradeHead = data.slice(bytesParsed + 1, data.length);

    if (client._server.listeners("upgrade").length) {
      client._server.emit('upgrade', request, request.connection, upgradeHead);
    } else {
      // Got upgrade header, but have no handler.
      client.destroy();
    }
  }
};

var streamOnEnd = function () {
  var client = this._client,
      parser = client._parser;

  parser.finish();

  client._reading = false;

  // If we can't read anymore, and there are no outgoing clients,
  // shut it down...
  if (!client._writing || client._outgoing.length === 0) {
    client.destroy();
  }
};

ClientConnection.prototype.destroy = function(error) {
  var self = this;

  if (this._netstream) {
    this._netstream.destroy();
    this._netstream = null;
  }

  if (this._securePair) {
    this._securePair.destroy();
    this._securePair = null;
  }

  process.nextTick(function () {
    if (error) self._server.emit('clientError', error);
  });
};

ClientConnection.prototype._childWrite = function(child, data, encoding) {
  // Fake a full write queue if the responses are sent in the wrong order.
  if (child === this._outgoing[0]) {
    return this._stream.write(data, encoding);
  }
  else {
    child._hot = false;
    child._output.push(data);
    child._outputEncoding.push(encoding);
  }

  return false;
};

ClientConnection.prototype._childAllSent = function(response) {
  /* All done.. */
  this._childDone(response);
};

ClientConnection.prototype._childDone = function(response, error, isIncoming) {
  // A response has finished, or a request has been destroyed.
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

    if ((!this._reading || response._last === true) &&
        0 === this._outgoing.length) {
      this._writing = false;

      if (!this._stream._writeQueue.length) {
        this.destroy();
      }
    } else if (!this._reading && this._writing &&
               this._outgoing.length) {
      // More responses to be sent.
      // Check if the output has been sent out.
      // If not, we do it ourselves.
      response = this._outgoing[0];

      if (response._output.length) {
        // Emit 'drain' (we faked a full writeQueue before this)
        response.emit('drain');
      }
    }
  }
};
