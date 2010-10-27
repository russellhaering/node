/* TODO: rewrite server */

var util    = require('util');
var net     = require('net');
var outgoing = require('httpoutgoing');
var crypto  = require('crypto');
var parsers = require('httpparser').parsers;

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

function ClientConn(server, stream, secure, creds) {
  var self = this;

  // SecurePair doesn't have setTimeout()
  stream.setTimeout(2 * 60 * 1000); // 2 minute timeout
  stream.addListener('timeout', function() {
    self.destroy();
  });

  if (secure) {
    var securePair = crypto.createPair(creds, true);

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
    parsers.free(self._parser);
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

Server.prototype._incomingConnection = function(socket) {
  debug("new http connection");
  
  var c = new ClientConn(this, socket, this.secure, this.credentials);

};

ClientConn.prototype._drain = function() {
  /*
  var message = this._outgoing[0];
  if (message) message.emit('drain');
  if (this.__destroyOnDrain) this.destroy();
  */
};

ClientConn.prototype._data = function(data) {
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

ClientConn.prototype._error = function(error) {
  this._server.emit('clientError', error);
};

ClientConn.prototype._end = function() {
  this._parser.finish();

  if (this._outgoing.length) {
    /* TODO: flush clients */
  } else {
    this.end();
  }
};

ClientConn.prototype._child_write = function(child, buf) {
  return this._stream.write(buf);
};

// The following callback is issued after the headers have been read on a
// new message. In this callback we setup the response object and pass it
// to the user.
ClientConn.prototype._incomingRequest = function (request, shouldKeepAlive) {
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

