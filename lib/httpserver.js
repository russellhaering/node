/* TODO: rewrite server */

function Server (requestListener) {
  if (!(this instanceof Server)) return new Server(requestListener);
  net.Server.call(this);

  if(requestListener){
    this.addListener("request", requestListener);
  }

  this.addListener("connection", connectionListener);
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

function connectionListener (socket) {
  var self = this;

  debug("new http connection");

  httpSocketSetup(socket);

  socket.setTimeout(2*60*1000); // 2 minute timeout
  socket.addListener('timeout', function () {
    socket.destroy();
  });

  var parser = parsers.alloc();
  parser.reinitialize('request');
  parser.socket = socket;

  if (self.secure) {
    socket.setSecure(self.credentials);
  }

  socket.addListener('error', function (e) {
    self.emit('clientError', e);
  });

  socket.ondata = function (d, start, end) {
    var ret = parser.execute(d, start, end - start);
    if (ret instanceof Error) {
      socket.destroy(ret);
    } else if (parser.incoming && parser.incoming.upgrade) {
      var bytesParsed = ret;
      socket.ondata = null;
      socket.onend = null;

      var req = parser.incoming;

      // This is start + byteParsed + 1 due to the error of getting \n
      // in the upgradeHead from the closing lines of the headers
      var upgradeHead = d.slice(start + bytesParsed + 1, end);

      if (self.listeners("upgrade").length) {
        self.emit('upgrade', req, req.socket, upgradeHead);
      } else {
        // Got upgrade header, but have no handler.
        socket.destroy();
      }
    }
  };

  socket.onend = function () {
    parser.finish();

    if (socket._outgoing.length) {
      socket._outgoing[socket._outgoing.length-1]._last = true;
      outgoingFlush(socket);
    } else {
      socket.end();
    }
  };

  socket.addListener('close', function () {
    // unref the parser for easy gc
    parsers.free(parser);
  });

  // At the end of each response message, after it has been flushed to the
  // socket.  Here we insert logic about what to do next.
  socket._onOutgoingSent = function (message) {
    var message = socket._outgoing.shift();
    if (message._last) {
      // No more messages to be pushed out.

      // HACK: need way to do this with socket interface
      if (socket._writeQueue.length) {
        socket.__destroyOnDrain = true; //socket.end();
      } else {
        socket.destroy();
      }

    } else if (socket._outgoing.length) {
      // Push out the next message.
      outgoingFlush(socket);
    }
  };

  // The following callback is issued after the headers have been read on a
  // new message. In this callback we setup the response object and pass it
  // to the user.
  parser.onIncoming = function (req, shouldKeepAlive) {
    var res = new ServerResponse(req);
    debug('server response shouldKeepAlive: ' + shouldKeepAlive);
    res.shouldKeepAlive = shouldKeepAlive;
    socket._outgoing.push(res);

    if ('expect' in req.headers
       && (req.httpVersionMajor == 1 && req.httpVersionMinor == 1)
       && continueExpression.test(req.headers['expect'])) {
        res._expect_continue = true;
        if (self.listeners("checkContinue").length) {
            self.emit("checkContinue", req, res);
        } else {
            res.writeContinue();
            self.emit('request', req, res);
        }
    } else {
        self.emit('request', req, res);
    }
    return false; // Not a HEAD response. (Not even a response!)
  };
}

