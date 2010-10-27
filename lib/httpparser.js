var FreeList = require('freelist').FreeList;
var HTTPParser = process.binding('http_parser').HTTPParser;
var httpincoming = require('httpincoming');

var parserProto = Object.create(HTTPParser.prototype);

parserProto.onMessageBegin = function () {
  this.incoming = new httpincoming.IncomingMessage(this.socket);
  this.field = null;
  this.value = null;
};

// Only servers will get URL events.
parserProto.onURL = function (b, start, len) {
  var slice = b.toString('ascii', start, start+len);
  if (this.incoming.url) {
    this.incoming.url += slice;
  } else {
    // Almost always will branch here.
    this.incoming.url = slice;
  }
};

parserProto.onHeaderField = function (b, start, len) {
  var slice = b.toString('ascii', start, start+len).toLowerCase();
  if (this.value !== null) {
    this.incoming._addHeaderLine(this.field, this.value);
    this.field = null;
    this.value = null;
  }
  if (this.field) {
    this.field += slice;
  } else {
    this.field = slice;
  }
};

parserProto.onHeaderValue = function (b, start, len) {
  var slice = b.toString('ascii', start, start+len);
  if (this.value) {
    this.value += slice;
  } else {
    this.value = slice;
  }
};

parserProto.onHeadersComplete = function (info) {
  if (this.field && (this.value !== null)) {
    this.incoming._addHeaderLine(this.field, this.value);
    this.field = null;
    this.value = null;
  }

  this.incoming.httpVersionMajor = info.versionMajor;
  this.incoming.httpVersionMinor = info.versionMinor;
  this.incoming.httpVersion = info.versionMajor + '.' + info.versionMinor;

  if (info.method) {
    // server only
    this.incoming.method = info.method;
  } else {
    // client only
    this.incoming.statusCode = info.statusCode;  
  }

  this.incoming.upgrade = info.upgrade;

  var isHeadResponse = false;

  if (!info.upgrade) {
    // For upgraded connections, we'll emit this after parser.execute
    // so that we can capture the first part of the new protocol
    isHeadResponse = this.onIncoming(this.incoming, info.shouldKeepAlive);
  }

  return isHeadResponse;
};

parserProto.onBody = function (b, start, len) {
  // TODO body encoding?
  var slice = b.slice(start, start+len);
  if (this.incoming._decoder) {
    var string = this.incoming._decoder.write(slice);
    if (string.length) {
      this.incoming.emit('data', string);
    }
  } else {
    this.incoming.emit('data', slice);
  }
};

parserProto.onMessageComplete = function () {
  this.incoming.complete = true;
  if (this.field && (this.value !== null)) {
    this.incoming._addHeaderLine(this.field, this.value);
    this.field = null;
    this.value = null;
  }
  if (!this.incoming.upgrade) {
    // For upgraded connections, also emit this after this.execute
    this.incoming.emit("end");
  }
};

var parsers = new FreeList('parsers', 1000, function () {
  var parser = new HTTPParser('request');
  parser.__proto__ = parserProto;
  return parser;
});

exports.parsers = parsers;
