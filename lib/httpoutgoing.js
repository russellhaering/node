var util = require('util');
var net = require('net');
var stream = require('stream');
var httputil = require('httputil');
var CRLF = httputil.CRLF;

function OutgoingMessage (parent) {
  var self = this;
  stream.Stream.call(this);

  this._parent = parent;
  this._output = [];
  this._outputEncoding = [];
  this._combined = '';
  this._combinedEncoding = null;
  // ~500 bytes is the best balance between buffer conversion
  // time, and write time.
  this._combinedMaxLength = 500;
  this._hot = true;

  this._done = false;
  this._last = false;
  this._writeState = true;
  this._paused = false;
  this._dataSent = false;

  this.chunkedEncoding = false;
  this.shouldKeepAlive = true;
  this.useChunkedEncodingByDefault = true;

  this._hasBody = true;
  this._trailer = '';
  this._parent._stream.on('drain', function() {
    /* TODO: move this to the parent */
    self._cycle();
  });
}

util.inherits(OutgoingMessage, stream.Stream);
exports.OutgoingMessage = OutgoingMessage;

OutgoingMessage.prototype.destroy = function (error) {
  this._parent._childDone(this, error);
};

OutgoingMessage.prototype.pause = function () {
  this._paused = true;
};

OutgoingMessage.prototype.resume = function () {
  this._paused = false;
};

OutgoingMessage.prototype.write = function (chunk, encoding) {
  if (!this._headerSent) {
    throw new Error("You have to call writeHead() before write()");
  }

  if (!this._hasBody) {
    throw new Error("This type of message MUST NOT have a body.");
  }

  var isString = typeof chunk === 'string';

  if (!isString && !Buffer.isBuffer(chunk)) {
    throw new TypeError("first argument must be a string, or Buffer");
  }

  if (this.chunkedEncoding) {
    if (isString) {
      len = Buffer.byteLength(chunk, encoding).toString(16);
      if (len !== "0")  {
        chunk = len + CRLF + chunk + CRLF;
        this._write(chunk, encoding);
      }
    } else {
      // buffer
      len = chunk.length;
      if (len !== 0) {
        this._write(len.toString(16) + CRLF);
        this._write(chunk, encoding, true);
        this._write(CRLF);
      }
    }

  } else {
    this._write(chunk, encoding, !isString);
  }

  if (!this._writing) {
    var self = this;
    process.nextTick(function () {
      if (self._writing) {
        self._cycle();
      }
    });
    this._writing = true;
  }

  if (this._paused) {
    return false;
  } else {
    return this._writeState;
  }
};

OutgoingMessage.prototype._write = function (data, encoding, isBuffer) {
  var isEmpty = '' === this._combined;

  if (!isBuffer && this._combinedEncoding === encoding) {
    if (encoding === 'utf-8') {
      encoding = 'utf8';
    } else if (!encoding) {
      // XXX: Should this be utf8?
      encoding = 'ascii';
    }

    if (isEmpty) {
      this._combinedEncoding = encoding;
    }

    // Write aggregation.
    this._combined += data;

    // If it is larger than the max length, then we let it pass.
    // TODO: writev() will mean this doesn't matter as much.
    if (this._combinedMaxLength <= this._combined.length) {
      this._hot = false;
      this._output.push(this._combined);
      this._outputEncoding.push(this._combinedEncoding);
      this._combined = '';
    }
  } else {
    this._hot = false;

    if (!isEmpty) {
      this._output.push(this._combined);
      this._outputEncoding.push(this._combinedEncoding);
      this._combined = '';
    }

    if (isBuffer) {
      this._output.push(data);
      this._outputEncoding.push(undefined);
    } else {
      this._combined = '' + data;
      this._combinedEncoding = encoding;
    }
  }

  return this._writeState;
};

OutgoingMessage.prototype.end = function (data, encoding) {
  // Hot
  if (this._hot && 'string' === typeof data) {
    if (this.chunkedEncoding) {
      var l = Buffer.byteLength(data, encoding).toString(16);
      if (l === "0") {
        this._hot = false;
        return this.end(data, encoding);
      }
      this._writeState = this._parent._childWrite(this,
          this._combined + l  +
          CRLF + data + '\r\n0\r\n' + this._trailer + '\r\n', encoding);
    } else {
      this._writeState = this._parent._childWrite(this,
          this._combined + data, encoding);
    }

  } else if (this._hot && Buffer.isBuffer(data)) {
    if (this.chunkedEncoding) {
      if (data.length !== 0) {
        this._output.push(this._combined + data.length.toString(16) + CRLF);
        this._outputEncoding.push('ascii');
        this._output.push(data);
        this._outputEncoding.push(undefined);
      }
      this._output.push('\r\n0\r\n' + this._trailer + '\r\n');
      this._outputEncoding.push('ascii');
    } else {
      this._output.push(this._combined);
      this._outputEncoding.push('ascii');
      this._output.push(data);
      this._outputEncoding.push(undefined);
    }

    this._combined = '';
    this._hot = false;
    this._cycle();

  } else {
    // Don't do the nextTick()
    this._writing = true;

    if (data) {
      this.write(data, encoding);
    }

    if (this.chunkedEncoding) {
      this._write('0\r\n' + this._trailer + '\r\n'); // Last chunk.
    }

    this._cycle();
  }

  this._writing = false;
  this._done = true;

  if (this._output.length == 0) {
    this._parent._childAllSent(this);
  }

  return this._writeState;
};

OutgoingMessage.prototype._cycle = function() {
  var self = this;
  var data, encoding;

  if (!this._parent._stream || !this._parent._stream.writable) {
    this._writeState = false;
    return;
  }

  for (var i = 0, il = this._output.length; i < il; i++) {
    data = this._output[i];
    encoding = this._outputEncoding[i];

    /* TODO: writev / small write combining */
    this._writeState = this._parent._childWrite(this, data, encoding);
    if (!this._writeState) {
      this._output = this._output.slice(i + 1);
      this._outputEncoding = this._outputEncoding.slice(i + 1);

      if (0 === this._output.length && '' !== this._combined) {
        this._output.push(this._combined);
        this._outputEncoding.push(this._combinedEncoding);
        this._combined = '';
      }

      return;
    }
  }

  this._output.length = 0;

  if ('' !== this._combined) {
    this._writeState = this._parent._childWrite(this,
                         new Buffer(this._combined, this._combinedEncoding));
    this._combined = '';
  }

  if (this._done) {
    this._parent._childAllSent(this);
  }

};

var connectionExpression = /Connection/i;
var transferEncodingExpression = /Transfer-Encoding/i;
var closeExpression = /close/i;
var chunkExpression = /chunk/i;
var contentLengthExpression = /Content-Length/i;
var expectExpression = /Expect/i;

OutgoingMessage.prototype._storeHeaders = function(line, headers) {
  var messageHeader = line;
  var field, value;
  var self = this;

  var sentConnectionHeader = false;
  var sentContentLengthHeader = false;
  var sentTransferEncodingHeader = false;
  var sentExpect = false;

  function store(field, value) {
    messageHeader += field + ": " + value + CRLF;

    if (connectionExpression.test(field)) {
      sentConnectionHeader = true;
      if (closeExpression.test(value)) {
        self._last = true;
      } else {
        self.shouldKeepAlive = true;
      }

    } else if (transferEncodingExpression.test(field)) {
      sentTransferEncodingHeader = true;
      if (chunkExpression.test(value)) {
        self.chunkedEncoding = true;
      }

    } else if (contentLengthExpression.test(field)) {
      sentContentLengthHeader = true;

    } else if (expectExpression.test(field)) {
      sentExpect = true;

    }
  }

  if (headers) {
    var keys = Object.keys(headers);
    var isArray = (Array.isArray(headers));

    for (var i = 0, l = keys.length; i < l; i++) {
      var key = keys[i];
      if (isArray) {
        field = headers[key][0];
        value = headers[key][1];
      } else {
        field = key;
        value = headers[key];
      }

      if (Array.isArray(value)) {
        for (var j = 0; j < value.length; j++) {
          store(field, value[j]);
        }
      } else {
        store(field, value);
      }
    }
  }

  // keep-alive logic
  if (sentConnectionHeader === false) {
    if (this.shouldKeepAlive &&
        (sentContentLengthHeader || this.useChunkedEncodingByDefault)) {
      messageHeader += "Connection: keep-alive\r\n";
    } else {
      this._last = true;
      messageHeader += "Connection: close\r\n";
    }
  }

  if (sentContentLengthHeader === false && sentTransferEncodingHeader === false) {
    if (this._hasBody) {
      if (this.useChunkedEncodingByDefault) {
        messageHeader += "Transfer-Encoding: chunked\r\n";
        this.chunkedEncoding = true;
      } else {
        this._last = true;
      }
    } else {
      // Make sure we don't end the 0\r\n\r\n at the end of the message.
      this.chunkedEncoding = false;
    }
  }

  this._combined = messageHeader + CRLF;
  this._combinedEncoding = 'ascii';
  this._headerSent = true;

  if (sentExpect) {
    this._write('');
  }
};

OutgoingMessage.prototype.addTrailers = function (headers) {
  this._trailer = "";
  var keys = Object.keys(headers);
  var isArray = (Array.isArray(headers));
  for (var i = 0, l = keys.length; i < l; i++) {
    var key = keys[i];
    if (isArray) {
      field = headers[key][0];
      value = headers[key][1];
    } else {
      field = key;
      value = headers[key];
    }

    this._trailer += field + ": " + value + CRLF;
  }
};

function ClientRequest (parent, method, url, headers) {
  OutgoingMessage.call(this, parent);

  this.method = method = method.toUpperCase();
  this.shouldKeepAlive = false;

  if (method === "GET" || method === "HEAD") {
    this.useChunkedEncodingByDefault = false;
  } else {
    this.useChunkedEncodingByDefault = true;
  }

  this._last = true;
  this._parentBuffer = [];
  this._storeHeaders(method + " " + url + " HTTP/1.1\r\n", headers);
}

util.inherits(ClientRequest, OutgoingMessage);
exports.ClientRequest = ClientRequest;


function ServerResponse (req, parent) {
  OutgoingMessage.call(this, parent);

  if (req.method === 'HEAD') {
    this._hasBody = false;
  }

  if (req.httpVersionMajor < 1 || req.httpVersionMinor < 1) {
    this.useChunkedEncodingByDefault = false;
    this.shouldKeepAlive = false;
  }
}

util.inherits(ServerResponse, OutgoingMessage);
exports.ServerResponse = ServerResponse;

ServerResponse.prototype.writeContinue = function () {
  this._write("HTTP/1.1 100 Continue" + CRLF + CRLF, 'ascii');
  this._sent100 = true;
  this._cycle();
};

ServerResponse.prototype.writeHead = function (statusCode) {
  var reasonPhrase, headers, headerIndex;

  if (typeof arguments[1] == 'string') {
    reasonPhrase = arguments[1];
    headerIndex = 2;
  } else {
    reasonPhrase = httputil.STATUS_CODES[statusCode] || "unknown";
    headerIndex = 1;
  }

  if (typeof arguments[headerIndex] == 'object') {
    headers = arguments[headerIndex];
  } else {
    headers = {};
  }

  var statusLine = "HTTP/1.1 " + statusCode.toString() + " " +
                   reasonPhrase + CRLF;

  if (statusCode === 204 || statusCode === 304 ||
      (statusCode >= 100 && statusCode <= 199)) {
    // RFC 2616, 10.2.5:
    // The 204 response MUST NOT include a message-body, and thus is always
    // terminated by the first empty line after the header fields.
    // RFC 2616, 10.3.5:
    // The 304 response MUST NOT contain a message-body, and thus is always
    // terminated by the first empty line after the header fields.
    // RFC 2616, 10.1 Informational 1xx:
    // This class of status code indicates a provisional response,
    // consisting only of the Status-Line and optional headers, and is
    // terminated by an empty line.
    this._hasBody = false;
  }

  // don't keep alive connections where the client expects 100 Continue
  // but we sent a final status; they may put extra bytes on the wire.
  if (this._expectContinue && ! this._sent100) {
      this.shouldKeepAlive = false;
  }

  this._storeHeaders(statusLine, headers);
};

ServerResponse.prototype.writeHeader = ServerResponse.prototype.writeHead;
