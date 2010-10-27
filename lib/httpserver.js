/* TODO: rewrite server */

var util    = require('util');
var net     = require('net');
var outoing = require('httpoutgoing');
var crypto  = require('crypto');

function Server (requestListener) {
  if (!(this instanceof Server)) return new Server(requestListener);
  net.Server.call(this);

  if (requestListener){
    this.addListener("request", requestListener);
  }

  this.addListener("connection", incomingConnection);
}
util.inherits(Server, net.Server);

Server.prototype.setSecure = function (credentials) {
  this.secure = true;
  this.credentials = credentials;
};

exports.Server = Server;

exports.createServer = function (requestListener) {
  return new Server(requestListener);
};


var socketDrain = function () {
  var message = this._outgoing[0];
  if (message) message.emit('drain');
  if (this.__destroyOnDrain) this.destroy();
};

var socketTimeout = function () {
  this.destroy();
};

var socketError = function (error) {
  this._server.emit('clientError', error);
};

var socketData = function (data, start, end) {
  var parser = this._parser,
      server = this._server,
      ret    = parser.execute(data, start, end - start);

  if (ret instanceof Error) {
    this.destroy(ret);
  } else if (parser.incoming && parser.incoming.upgrade) {
    var bytesParsed = ret;

    this.ondata = null;
    this.onend  = null;

    var request = parser.incoming;

    // This is start + byteParsed + 1 due to the error of getting \n
    // in the upgradeHead from the closing lines of the headers
    var upgradeHead = data.slice(start + bytesParsed + 1, end);

    if (server.listeners("upgrade").length) {
      server.emit('upgrade', request, request.connection, upgradeHead);
    } else {
      // Got upgrade header, but have no handler.
      this.destroy();
    }
  }
}

var socketEnd = function () {
  this._parser.finish();

  if (this._outgoing.length) {
    this._outgoing[this._outgoing.length - 1]._last = true;
    outgoingFlush(this);
  } else {
    this.end();
  }
};

var socketClose = function () {
  // unref the parser for easy gc
  parsers.free(this._parser);
};

// At the end of each response message, after it has been flushed to the
// socket.  Here we insert logic about what to do next.
var socketOutgoingSent = function (message) {
  var message = this._outgoing.shift();
  if (message._last) {
    // No more messages to be pushed out.

    // HACK: need way to do this with socket interface
    if (this._writeQueue.length) {
      this.__destroyOnDrain = true; //socket.end();
    } else {
      this.destroy();
    }

  } else if (this._outgoing.length) {
    // Push out the next message.
    outgoingFlush(this);
  }
};


// The following callback is issued after the headers have been read on a
// new message. In this callback we setup the response object and pass it
// to the user.
var parserIncoming = function (request, shouldKeepAlive) {
  var response = new outgoing.ServerResponse(request),
      socket   = this.socket,
      server   = socket._server;

  debug('server response shouldKeepAlive: ' + shouldKeepAlive);
  res.shouldKeepAlive = shouldKeepAlive;
  socket._outgoing.push(response);

  if ('expect' in request.headers &&
      (request.httpVersionMajor == 1 && request.httpVersionMinor == 1) &&
      continueExpression.test(request.headers['expect'])) {
    res._expectContinue = true;

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


var incomingConnection = function (socket) {
  debug("new http connection");

  if (this.secure) {
    if (!(this.credentials instanceof crypto.Credentials)) {
      this.credentials = crypto.createCredentials(this.credentials);
    }

    var securePair = crypto.createPair(this.credentials, true);

    socket.pipe(securePair.encrypted);
    securePair.encrypted.pipe(socket);

    securePair.on('secure', function() {
      // TODO: Connected fo' sure
    });

    socket = securePair.cleartext;

    securePair.on('error', function (error) {
      socketError.call(socket, error);
    });

    securePair.on('end', function () {
      socketError.call(socket);
    });
  }

  var parser        = parsers.alloc();
  parser.socket     = socket;
  parser.onIncoming = parserIncoming;
  parser.reinitialize('request');

  socket.setTimeout(2 * 60 * 1000); // 2 minute timeout
  socket.addListener('timeout', socketTimeout);
  socket.addListener('error', socketError);
  socket.addListener('close', socketClose);

  // An array of outgoing messages for the socket. In pipelined connections
  // we need to keep track of the order they were sent.
  socket._outgoing        = [];
  socket.__destroyOnDrain = false;
  socket._server          = this;
  socket._parser          = parser;
  // NOTE: be sure not to use ondrain elsewhere in this file!
  socket.ondrain          = socketDrain;
  socket.ondata           = socketData;
  socket.onend            = socketEnd;
  socket._onOutgoingSent  = socketOutgoingSent;
};
